# Admin Plane 实现说明（v0.8）

> 跨 issue #28–#36 + epic #23 的"实际实现"权威文档。配合
> `CHANGELOG.md` 一起看是面向用户的简介。

每一节都按相同的结构组织：**表结构 → 服务层 → 中间件 → HTTP 接口 → 测试 →
安全要点**。交叉引用使用 `path:line` 的形式标注位置。

---

## 0. 拓扑

```
┌─────────────────────── HTTP 入口 ────────────────────────┐
│ logger() → cors()                                        │
│                                                          │
│ ───── 公开（免认证）─────                                 │
│   GET /                          server.ts:37            │
│   GET /healthz                   server.ts:40            │
│   GET /readyz                    server.ts:43            │
│   GET /admin/assets/*            server.ts:60（静态）     │
│   *   /admin/login               loginApp                │
│                                                          │
│ ───── API key 认证挂载 ─────                              │
│   server.use("*", 路径跳过 → authMiddleware)             │
│                                                          │
│ ───── 遥测挂载 ─────                                      │
│   server.use("*", 路径跳过 → telemetryMiddleware)        │
│                                                          │
│ ───── 调试 trace 挂载 ─────                               │
│   server.use("*", 路径跳过 → traceMiddleware)            │
│                                                          │
│ ───── Admin API ─────                                    │
│   /admin/audit         （admin tier API key）            │
│                                                          │
│ ───── 会话保护的 admin WebUI ─────                        │
│   /admin/* (sessionMiddleware + requireAdminSession)     │
│     /admin            概览                                │
│     /admin/keys       Key 管理                            │
│     /admin/usage      用量看板                            │
│     /admin/traces     调试 trace 实时 tail                │
│                                                          │
│ ───── 代理路由 ─────                                      │
│   /chat/completions, /v1/chat/completions                │
│   /messages,         /v1/messages                        │
│   /embeddings,       /v1/embeddings                      │
│   /responses,        /v1/responses                       │
│   /models,           /v1/models                          │
│   /usage,            /token                              │
└──────────────────────────────────────────────────────────┘
```

挂载顺序很重要：auth 先于 telemetry（telemetry 需要读 `c.var.key`），
telemetry 先于 trace（这样 trace 记录的 `key_id` 与 event 记录一致），
trace 先于路由处理器（这样它才能在响应体外层做包裹）。

路径跳过判定（`server.ts:107-114` 等处）：

```ts
if (path === "/admin" || (path.startsWith("/admin/") && !path.startsWith("/admin/audit"))) {
  return next()  // 会话型 WebUI 自己做认证
}
return authMiddleware(c, next)
```

`/admin/audit` 是唯一**不被**会话路由接管的 `/admin/*` 路径——它是一个
admin API，不是 WebUI 页面。

---

## 1. 数据库 Schema (`src/lib/migrations/`)

使用 `bun:sqlite` + WAL；迁移基于 PRAGMA `user_version`
（`src/lib/db.ts:108-156`）。每个 `.sql` 文件在
`BEGIN EXCLUSIVE ... COMMIT` 里执行；版本号采用字符串拼接而非绑定参数
（因为 `PRAGMA` 不接受绑定参数）。

### 001_init.sql

旧版兼容占位符，空文件。

### 002_keys.sql（issue #28）

```sql
CREATE TABLE keys (
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('admin','client')),
  label TEXT,
  allowed_models TEXT NOT NULL DEFAULT '["*"]' CHECK(json_valid(allowed_models)),
  rate_limit_override INTEGER,
  debug_enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
```

- `hash` 是 `SHA-256(明文)` 的十六进制——**明文绝不进库**。UNIQUE 约束
  也自动创建索引供 `findKeyByHash` 使用。
- `json_valid(allowed_models)` 在 INSERT 时拒绝非法 JSON；服务层
  `validateAllowedModels` 进一步拒绝 URL 形态的 model 名称，防止 SSRF。
- 软删除：吊销时设置 `revoked_at`，行本身保留以便审计。

### 003_sessions.sql（issue #31）

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES keys(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

- `id` = `crypto.randomBytes(32).toString("hex")` —— 256 bit 熵。
- `ON DELETE CASCADE` 关联 keys：硬删 key 行时（罕见，通常软删
  `revoked_at`）相关会话也清掉。
- `csrf_token` 存了但**当前中间件并不直接对它比对**——比对的是 HMAC-SHA256
  派生值。这一列保留是为未来 PR 持久化 CSRF 密钥做准备。

### 004_debug_expires.sql（issue #32）

```sql
ALTER TABLE keys ADD COLUMN debug_expires_at INTEGER;
```

为 `debug_enabled=1` 加上 24 小时 TTL。`src/services/
debug-ttl-sweeper.ts` 每 60 秒自动失效到期的行。

### 005_events.sql（issue #34）

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,             -- '__noauth__' 哨兵用于 --no-auth
  model TEXT NOT NULL,              -- 客户端可见的别名
  upstream_model TEXT NOT NULL,     -- 别名解析后的真实模型
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error TEXT,                       -- 短的固定词汇 tag
  usage_unknown INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_key_ts    ON events(key_id, ts);
CREATE INDEX idx_events_model_ts  ON events(model, ts);
```

- `key_id` **没有**外键约束，目的是让 `__noauth__` 哨兵能正常插入。
- `error` 是低基数 **tag**（`bad_request`、`rate_limited`、
  `client_aborted` 等），**绝不**是响应体——参见
  `src/middleware/telemetry.ts:statusToErrorTag`。

---

## 2. 服务层

### 2.1 `keys.ts`（issue #28，#32 扩展）

#### Key 生成

`generateKey()` —— 33 字节随机（264 bit）→ base32（无 padding）→ 52
字符 → `sk-cap-` + 52 = 59 字符。264 ≥ 256 bit 远超 NIST 给的"无需加盐"
门槛，所以静态存储用不加盐的 SHA-256。

```
sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
       └────────── 52 个 base32 大写字符 ──────────────────┘
```

#### `validateAllowedModels`

拒绝空数组。每个 model 名称必须匹配 `/^\w[\w.:-]*$/` 或者是通配符 `*`。
这条正则与 config-store 验证 upstream id 时用的一样，是防 SSRF 的关键
（不允许 URL、不允许斜杠）。

#### `resolveRateLimit`

每 key 的限速覆盖最多是全局默认的 10×（默认 60 秒 → 上限 600 秒）。
负数或非整数抛错。

#### `createKey`

单条 INSERT。返回 `{ plain, row }` —— 明文**只**返回给调用方一次，
绝不进库。`bootstrap.ts` 和 `admin/keys/route.tsx` 负责把它仅展示一次。

#### `setDebugEnabled(id, enabled)`

切换 + 刷新 TTL 一气呵成：

```sql
UPDATE keys
   SET debug_enabled = ?,
       debug_expires_at = ?   -- 启用：now+24h；停用：NULL
 WHERE id = ?
```

#### `isDebugActive(row, now)` —— **单一真理源**

```ts
if (row.debug_enabled !== 1) return false
if (row.revoked_at !== null) return false
if (row.debug_expires_at !== null && row.debug_expires_at <= now) return false
return true
```

#32 评审发现，全代码里直接比对 `row.debug_enabled === 1` 容易过时
（sweeper 60 秒跑一次；这窗口里一行可能 `debug_enabled=1` 但
`debug_expires_at <= now`）。现在所有调用——列表视图、详情页、banner、
trace 中间件——都用这个辅助函数。

#### `countActiveDebugKeys()` —— 感知 TTL 版本

```sql
SELECT COUNT(*) FROM keys
 WHERE debug_enabled = 1
   AND revoked_at IS NULL
   AND (debug_expires_at IS NULL OR debug_expires_at > ?)
```

驱动每个 admin 页面的红色 banner。

#### `listKeys(limit=50, offset=0)`

返回 `{ rows, total }` 给分页 UI 用。`ORDER BY created_at DESC, id`
让最新的 key 排前面。1000 行性能测试
（`tests/admin-keys.test.ts:181-204`）验证 <100 ms 完成。

#### `updateKeyScope(id, allowedModels, rateLimitOverride)`

重新校验 models；拒绝更新已吊销的 key；tier 创建后不可改。

### 2.2 `audit.ts`（issue #30）

JSONL 追加到 `~/.local/share/copilot-api/audit-YYYY-MM-DD.jsonl`，
mode 0600，`O_WRONLY | O_CREAT | O_APPEND`。按天滚动（文件名带日期）。
启动时做一次保留期清理。

`audit(event)` 自动填 `ts`，转发到 `appendAudit`。任何错误被
`consola.error` 捕获——遥测/审计的失败永远是 best-effort，绝不向客户
端传递。

`AuditEvent` 形状：

```ts
{
  ts: number
  actor_key_id: string       // "__system__" / "__noauth__" / key id
  actor_tier: "admin" | "client" | "system"
  action: string             // "auth.bootstrap", "key.create", "key.revoke",
                             // "key.scope_update", "key.debug_enable",
                             // "key.debug_disable", "key.debug_renew",
                             // "key.debug_expired", "auth.reject",
                             // "server.start_no_auth"
  target?: string            // 资源 id 或 bearer hash 的前 8 个十六进制字符
  before?: object
  after?: object             // server.start_no_auth 时包含 bind_address
  ip?: string
  user_agent?: string
}
```

**安全要点：**
- `auth.reject` 事件只记录 `SHA-256(bearer)` 的前 8 个十六进制字符，
  **绝不**记录 bearer 本身。
- 一次 trace 写入失败**绝不**回滚触发它的 mutation（取舍：运维完整性
  优先于审计完整性——#32 评审中 `safeAudit` 已注明）。

### 2.3 `events.ts` + `retention.ts`（issue #34）

```ts
recordEvent(row): void                  // best-effort INSERT
countEvents(): number
purgeEventsOlderThan(cutoffMs): number   // 分块 DELETE，每批 1000
                                         // + await setImmediate 让出事件循环
startEventRetention(): cancel             // 整点对齐的小时级扫除
```

保留期 sweeper 锚定在墙上时钟的整点：

1. 启动时计算 `msUntilNextHour()`，首次扫除在那时跑。
2. 之后每 3,600,000 ms 一次。
3. **挂起-恢复检测**：如果 `Date.now() - lastTickTs > 1.25 × HOUR_MS`，
   记一条 "system likely resumed from suspend" 然后立刻补一次扫除。
4. 每次 tick 都从 `getConfig()` 读取 `retention.events_days`，所以热
   reload `config.json` 在下个 tick 自动生效，无需重启。

返回的 cancel 句柄挂进 `start.ts` 里 SIGINT/SIGTERM 的关停钩子。

### 2.4 `debug-ttl-sweeper.ts`（issue #32）

```sql
SELECT id FROM keys
 WHERE debug_enabled = 1
   AND debug_expires_at IS NOT NULL
   AND debug_expires_at <= ?    -- now
```

每条命中行：先 bulk UPDATE 把 `debug_enabled=0, debug_expires_at=NULL`，
然后每行各发一条 `key.debug_expired` 审计事件。每 60 秒跑一次。

### 2.5 Trace 管线（issue #36）

三个模块特意拆开，方便单元测试逐个验证：

```
trace.ts 中间件
     │
     ├── trace-redact.ts   （纯函数，无 IO）
     │   redactHeaders / redactBody / assertRedacted
     │
     ├── trace-writer.ts   （同步追加到 JSONL）
     │   writeTrace      ← 持久化前先跑 assertRedacted
     │
     └── trace-broadcaster.ts  （进程内 SSE 发布订阅）
         broadcastTrace(line) / subscribe(opts)
```

#### `trace-redact.ts`

两道纵深防御：

1. `redactBody(body)` —— 替换匹配 `BODY_PATTERNS` 的子串：
   - `gh[oprsu]_[A-Za-z0-9]{20,}` —— GitHub 经典 token
   - `github_pat_\w{20,}` —— 细粒度 PAT
   - `eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+` —— JWT 形状（覆盖 Copilot bearer）
   - `Iv\d+\.[A-Fa-f0-9]{16,}` —— GitHub App client id（Iv1.*、Iv23.*）
   - `sk-cap-[A-Z2-7]{52}` —— **本代理自己签发的 key** ← #36 评审补加；
     否则用户把自己的 key 粘到 prompt 里会被原样落盘
   - `sk-ant-[\w-]{40,}` —— Anthropic API key
   - `sk-[\w-]{40,}` —— OpenAI 风格 key
   - `\bAKIA[A-Z0-9]{16}\b` —— AWS Access Key ID
   - `(?<=://)[^:/@\s]+:[^@\s]{1,200}(?=@)` —— URL 里的 basic auth

2. `assertRedacted(line)` —— **独立的**事后检查：
   - 重跑 `BODY_PATTERNS`（捕获替换循环的 bug）
   - 加跑 `POST_REDACT_HEURISTICS`：
     - `\bbearer\s+[\w+./~=-]{32,}` —— `bearer ` 后任何不透明 token
     - `\b(api[_-]?key|token|secret|password)["':=]+...{32,}`

   两道任一抛错，writer 直接丢弃这条 trace。这一关捕获我们没枚举到
   的 secret 形态（比如一个没有可识别前缀的合作伙伴 API key）。

`REDACTED_HEADERS` = `{authorization, x-api-key, cookie, set-cookie,
proxy-authorization, x-github-token, x-vscs-token, x-capi-debug}` ——
忽略大小写（Headers 自动归一化为小写；纯对象分支先 lowercase key）。

#### `trace-writer.ts`

```ts
writeTrace(event: TraceEvent): void
```

1. 用 `redactHeaders` + `redactBody` + `JSON.stringify` 构造 JSONL 文本。
2. 对输出跑 `assertRedacted`。抛错就记日志并丢弃。
3. 若 `getConfig().retention.traces_days <= 0` → 直接 return（仅内存模式）。
4. `fs.mkdirSync(tracesDir(), { recursive: true, mode: 0o700 })`。
5. 用 `O_WRONLY | O_CREAT | O_APPEND` mode 0o600 打开
   `traces/traces-YYYY-MM-DD.jsonl`。写入。关闭。
6. 把已脱敏的文本推送到 `broadcastTrace(text)`。

目录权限 + 文件权限保证只有代理进程的用户能读到抓取的 prompt。

#### `trace-broadcaster.ts`

进程内单点发布订阅，给 `/admin/traces/stream` 用。内部状态：

```ts
const subscribers = new Set<Subscriber>()   // 上限 4
const ring: Array<RingEntry> = []           // 保留最近 100 帧用于断线重播
let monotonicId = 0
```

`subscribe(opts)` **同步**占位——立刻把一个带 `PLACEHOLDER_CONTROLLER`
的 `Subscriber` 加入 set；真正的 controller 在 ReadableStream 的
`start()` 回调里换上。这一改动堵住了 #36 评审找出的 check-then-act
race（R4）：两个几乎同时的 `subscribe()` 调用本来可能都看到
`size >= 4` 是 `false`。

每订阅者队列上限 1 MB（`MAX_QUEUE_BYTES`），溢出时丢老的。心跳帧
（`: ping\n\n`）15 秒一次。心跳 interval 句柄在关闭时被 clear。

`Last-Event-ID` 重连：客户端发了这个 header 时，broadcaster 重播 `ring`
里 `id > lastEventId` 的条目。重启会清零（已知限制：客户端最多丢失
ring-size 条目）。

#### `trace-retention.ts`

小时级扫除：

```ts
purgeOldTraces()    // 按年龄：删除超过 traces_days 的文件
enforceSizeCap()    // 按总大小：把总和压到 traces_max_bytes 以下
                    // 优先删最老的一天；若在保留期内还触发删除则告警
startTraceRetention(): cancel
```

`enforceSizeCap` 按日期升序排，累加字节数，从最老的一天开始删直到总和
≤ 上限。如果**保留期内**就触发删除会打 warn 日志——这是"增长速度超过
你设的保留策略"的告警条件。

---

## 3. 中间件

### 3.1 `auth.ts` —— Bearer + 每 key 限速 + model 范围（issue #29）

```ts
authMiddleware:
  // 1. 在任何分支之前先剥掉敏感的客户端 header。
  c.req.raw.headers.delete("x-api-key")
  c.req.raw.headers.delete("cookie")

  // 2. no-auth 模式：塞一个 NO_AUTH_SENTINEL key（id = "__noauth__"）。
  if (!getConfig().features.auth) {
    c.set("key", NO_AUTH_SENTINEL)
    return next()
  }

  // 3. 必须有 Authorization。Bearer 大小写不敏感（RFC 7235 §2）。
  const authHeader = c.req.header("Authorization")
  if (!authHeader) { auditReject(c); return reject401(...) }

  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7)
    : authHeader
  c.req.raw.headers.delete("authorization")  // 转上游前先剥

  // 4. SK_CAP_RE = /^sk-cap-[A-Z2-7]{52}$/  —— 全形状验证，免得上游
  //    误把残缺前缀当我们的 key 拒掉。
  if (!SK_CAP_RE.test(bearer)) {
    const prefix = sha256(bearer).slice(0, 8)
    auditReject(c, prefix)             // 只记 8 位 hash 前缀
    return reject401("Use a sk-cap-* key issued by this server")
  }

  // 5. DB 查找（hash 比对）。
  const hash = sha256(bearer)
  const row = findKeyByHash(hash)
  if (!row || row.revoked_at !== null) {
    auditReject(c, hash.slice(0, 8))
    return reject401("Invalid API key")
  }

  // 6. X-Capi-Debug —— 无条件剥除；只有 admin tier 才会设置
  //    `debug_via_header` 上下文标志（trace 中间件消费）。
  const debugHeader = c.req.header("x-capi-debug")
  c.req.raw.headers.delete("x-capi-debug")
  if (debugHeader === "1" && row.tier === "admin") {
    c.set("debug_via_header", true)
  } else if (debugHeader !== undefined && row.tier !== "admin") {
    consola.warn("[auth] Stripped X-Capi-Debug from client-tier request")
  }

  // 7. 每 key 限速（粗略 token bucket：lastTs + windowMs 淘汰）。
  try {
    checkKeyRateLimit(row.id, row.rate_limit_override)
  } catch (err) {
    if (err instanceof HTTPError) return new Response(err.response.body, ...)
    throw err
  }

  c.set("key", row)
  return next()
```

`isModelAllowed(allowedModelsJson, model)`：
- `JSON.parse` 列值。
- 在 `.some()` 前**先**做 `Array.isArray` 守卫——评审发现
  `"*".includes("*")` 在非数组上返回 true，会让一个客户端 tier 的 key
  通过在 `allowed_models` 里塞 JSON 字符串 `"*"` 来绕过范围检查。
  `Array.isArray` 关掉这个口子。

### 3.2 `telemetry.ts`（issue #34）

每请求记一行。形状：

```
key_id          c.get("key")?.id  ?? "__noauth__"
model           来自 POST body 的快照（带上限读取，见下）
upstream_model  c.get("upstream_model") ?? model
prompt_tokens   c.get("usage")?.prompt_tokens
completion_tokens c.get("usage")?.completion_tokens
status          c.res.status
latency_ms      Date.now() - start
error           statusToErrorTag(status)  // 固定词汇
usage_unknown   prompt 和 completion 都 null 时为 1，否则 0
```

**Body model 快照**（#34 评审 R2 修复）：原先调用
`await req.clone().text()` 会把整个请求体读进内存只为拿一个 `model`
字段。修复版用流式 reader 上限 16 KB，找到 `"model": "..."` 正则匹配
就提早返回。否则一个 vision payload（数 MB base64）会因为这个 label
被双倍缓冲。

**流式响应埋点**（#34 评审 R1 修复）：原来用
`pipeThrough(TransformStream(... flush() {...} ))` 在流关闭时触发遥测
插入。评审发现 **Bun 的 `TransformStream.cancel` 在下游 cancel 时
不触发**，所以客户端中途断开 SSE 时静默丢失这条记录。修复换成手写
`ReadableStream`：

```ts
new ReadableStream<Uint8Array>({
  async pull(controller) {
    try {
      const { value, done } = await sourceReader.read()
      if (done) { controller.close(); fire(); return }
      controller.enqueue(value)
    } catch (err) {
      fire({ aborted: true })
      controller.error(err)
    }
  },
  cancel(reason) {
    fire({ aborted: true })
    sourceReader.cancel(reason).catch(() => {})
  },
})
```

`recorded` 标志保证 `fire()` 在 EOF / cancel / pull-error 三种竞态下
只跑一次。当 `aborted=true` 且 status < 400 时，event 行的 `error`
列设为 `"client_aborted"`，看板就能把客户端断开和上游错误分开看。

### 3.3 `trace.ts`（issue #36）

激活条件（任一）：
- `isDebugActive(c.get("key"))` —— key 满足 `debug_enabled=1` 且未吊销
  且 `debug_expires_at > now`
- `c.get("debug_via_header")` —— admin tier key 带了 `X-Capi-Debug: 1`
  时 auth 中间件设的标志

流式响应用与 `telemetry.ts` 完全一样的 `ReadableStream` 包裹模式。
每段上限 256 KB，超过的部分填 `[TRUNCATED]`。v1 只抓**客户端 → 代理 →
客户端**两段；要抓代理 → GitHub 那段需要在 `src/services/copilot/*`
的每个 helper 里穿管道（在 `middleware/trace.ts` 留了 TODO 注释）。

### 3.4 `session-middleware.ts`（issue #31）

```ts
sessionMiddleware:
  // 1. HTTPS-或-环回守卫。X-Forwarded-Proto 仅当
  //    process.env.TRUST_PROXY === "true" 时才信任。
  if (!isRequestAllowed(c)) return c.text("HTTPS required ...", 403)

  // 2. 会话查找。
  const sid = extractSessionId(cookieHeader)
  if (!sid) return c.redirect("/admin/login", 302)

  // 3. CSRF —— 对非 GET 方法**先**于 DB 查找做检查，免得被偷的 sid
  //    通过滑动续期写入来探测。
  if (!["GET","HEAD"].includes(method)) {
    if (fetchSite !== "same-origin") return 403
    const tokenHeader = c.req.header("x-csrf-token")
    const tokenBody   = await extractCsrfBody(c)   // form-body 兜底
    const effective   = tokenHeader ?? tokenBody
    const tokenCookie = extractCsrfCookie(cookieHeader)
    if (!effective || !tokenCookie) return 403
    if (!verifyCsrfToken(sid, effective) || !verifyCsrfToken(sid, tokenCookie))
      return 403
  }

  const session = getSession(sid)        // 同时滑动过期时间
  if (!session) { 清 cookie；重定向 /admin/login }
  c.set("session", session)
  await next()

  // 4. 滑动窗口：每个鉴权通过的响应都刷新 Max-Age，保持浏览器 cookie
  //    与服务端过期时间同步。
  c.res.headers.append("Set-Cookie", sessionCookieValue(session.id))
```

**`requireAdminSession`**（#35 评审 F-6 修复）：每个请求都重新去
keys 表里查 `session.key_id`，如果 key 不存在 / 已吊销 / 非 admin 就
拆掉会话。深度防御 —— 万一 `login.tsx` 出现回归（比如把 client tier
key 也放过），这一关挡住。

`csrf.ts`：

```ts
generateCsrfToken(sessionId): string
  = base64url(HMAC-SHA256(sessionId, CSRF_SECRET))
verifyCsrfToken(sessionId, token): boolean
  = timingSafeEqual(expected, token)
```

`CSRF_SECRET = crypto.randomBytes(32)`，模块加载时生成。**已知限制**：
进程重启会让所有已有 CSRF token 作废，用户必须重新登录。模块头部
注释里写明了这点。

---

## 4. HTTP 接口

### 4.1 `loginApp` —— POST/GET /admin/login

- GET：服务端渲染表单（key 输入框 + 登录按钮）。错误信息通过
  `?error=missing|invalid`。
- POST：
  1. `findKeyByHash(sha256(明文))`。
  2. 拒绝：未找到 / 已吊销 / 非 admin。
  3. **作废同 key 的旧会话**：
     `DELETE FROM sessions WHERE key_id = ?`（#31 评审修复）。
     防止被盗 session 在重新登录后还活着。
  4. `createSession(keyRow.id)` → 新 sid + csrf cookie 对。
  5. 303 → `/admin`。

Cookie 属性：

```
sid=<32-byte-hex>;  HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800
csrf=<hmac>;        Secure;   SameSite=Strict; Path=/admin
```

（CSRF cookie **不**带 `HttpOnly` —— JS/表单需要读到它来完成
double-submit。CSRF cookie 缺 `Secure` 是 #31 评审 F-5 找到的，
已修复。）

### 4.2 Admin keys 页面 —— `/admin/keys`

| Method | Path                          | 动作                            |
|--------|-------------------------------|---------------------------------|
| GET    | `/admin/keys`                 | 列表，50 一页                    |
| GET    | `/admin/keys/new`             | 创建表单                         |
| POST   | `/admin/keys/new`             | 创建 key + flash 明文            |
| GET    | `/admin/keys/created?flash=X` | 一次性明文显示（看完即销）        |
| GET    | `/admin/keys/:id`             | 详情 / 编辑页                    |
| POST   | `/admin/keys/:id/revoke`      | 软删                             |
| POST   | `/admin/keys/:id/scope`       | 更新 allowed_models + rate limit |
| POST   | `/admin/keys/:id/debug`       | 启用 / 停用 / 续期 debug         |

**Flash store** 是进程生命期的内存 `Map<token, {plain, keyId, expires}>`。
TTL 5 分钟。一次性消费（读后 `Map.delete`）。URL 里的 token 是
`crypto.randomUUID()`（122 bit）。如果用户刷新页面，会拿到一个 410 Gone
带明确"明文不再可用"的错误页 —— **不是**静默重定向（#32 评审 F-3 修复）。

**Debug 确认**现在是**服务端门控**（#32 评审 R2 修复）：表单提交
`debug_enabled=1` AND `debug_confirm=yes`。后者在 `keys.js` 里 modal
确认后才被 JS 设置。**没有 JS 的话操作员根本启用不了 debug**。CSP
（`default-src 'self'`）禁止 inline scripts AND inline `onclick`
处理器，所以全部交互都在 `src/admin/assets/keys.js` 里通过
`addEventListener` 接管。

**Renew 按钮**（#32 评审 R1 修复）：原来与 Disable 按钮共用一个表单，
表单总是提交 `debug_enabled=0`，结果点 Renew 实际是悄悄停用而不是续期
TTL。修复用两个独立表单；renew 表单提交 `action=renew`，handler 调用
`setDebugEnabled(id, true)`，与 `debug_enabled` 字段无关。

### 4.3 用量看板 —— `/admin/usage`（issue #35）

`queries.ts` 暴露纯 SQL 辅助：

```ts
requestsPerMinute(filter)   → Array<{ts, model, count}>
tokensPerHour(filter)       → Array<{ts, prompt_tokens, completion_tokens}>
p95LatencyPerHour(filter)   → Array<{ts, p95}>
topKeysByTokens(filter, n)  → Array<{key_id, tokens}>
topModelsByRequests(filter, n) → Array<{model, count}>
errorRateByKey(filter)      → Array<{key_id, total, errors, rate}>
streamEventsForCsv(filter)  → IterableIterator<EventRow>   (.iterate)
distinctModels()            → Array<string>
```

p95 算法：按小时分桶，每桶 count，再按 latency_ms 排序取第
(0.95 × count) 行。每桶两条查询；planner 依然能用 `idx_events_ts`
做范围扫描。

**CSV 导出** `/admin/usage/export.csv`：

- 拉式 `ReadableStream`（#35 评审 F-2 修复）—— `pull()` 一行行
  `iter.next()`，客户端慢时自动施加背压。
- `cancel()` 调用 `iter.return?.()` 终结 SQLite 迭代器，释放读事务，
  让 WAL checkpoint 能进行。
- RFC 4180 引号经 `csvField(value)`：
  - 值含 `,`、`"`、`\r`、`\n` 时加引号包裹。内嵌 `"` 双倍化
    （`"a""b"`）。
  - **公式注入守卫**（#35 评审 F-1 修复）：值首字符是 `=`、`+`、
    `-`、`@`、`\t` 或 `\r` 时前缀一个单引号 `'`。Excel/Numbers/
    LibreOffice 把单引号当文本压制符号渲染而非字面字符 —— 击败
    `=cmd|'/c calc'!A1` 这类 payload 当 model 名时的攻击。

**自定义时间范围上限**（#35 评审 F-9 修复）：`parseFilter` 把自定义
窗口钳到 90 天；event 本身已经被保留期限制，但这一步把 WHERE 扫描
范围也限制住，免得一个糟糕的请求把读事务长期占着。

**JSON 数据岛**在 `page.tsx` 里包在
`<script type="application/json" id="usage-data">` 里。所有 HTML
特殊字符（`<`、`>`、`&`、U+2028、U+2029）在嵌入前转义成 `\uXXXX`
形式（#35 评审 F-3 修复）。`JSON.parse` 透明解码；HTML 分词器看到
的是不透明 payload。

### 4.4 Traces —— `/admin/traces`（issue #36）

| Method | Path                            | 动作                              |
|--------|---------------------------------|-----------------------------------|
| GET    | `/admin/traces`                 | 实时 tail 页面（加载 traces.js）  |
| GET    | `/admin/traces/stream`          | broadcaster.subscribe 的 SSE 流   |
| GET    | `/admin/traces/:filename`       | 流式 JSONL 下载                   |

**路径穿越守卫**（#36 评审 R3 修复）：

1. `filename` 必须以 `.jsonl` 结尾；剥掉扩展。
2. `date` 必须匹配 `^\d{4}-\d{2}-\d{2}$`。
3. 构造 `fullPath = path.join(tracesDir(), `traces-${date}.jsonl`)`。
4. 字面检查：`fullPath.startsWith(tracesDir() + path.sep)`。
5. **符号链接检查（纵深防御）**：
   `resolved = fs.realpathSync.native(fullPath)`。若 `resolved` 不以
   `tracesDir() + path.sep` 起头，400 拒绝。
6. 第 5 步遇到 ENOENT → 404。其他错误 → 400。

**流式下载**（#36 评审 R5 修复）：原代码用
`fs.readFileSync(fullPath, "utf8")`，一个 100 MB 的文件会冻住事件循环
整个读取过程。修复用 `fs.createReadStream` 包成 Web `ReadableStream`，
带 `pause()`/`resume()` 背压和 `cancel()` 钩子销毁 Node 流。

### 4.5 Auth 模式安全门（issue #33）

`src/lib/auth-mode.ts`：

```ts
resolveAuthMode({ noAuth, acceptRisk, host, port, configAuth }): AuthModeResult
```

三个标签：

- `"on"` —— auth 开启，无额外检查。
- `"off (loopback)"` —— `--no-auth` 或 `features.auth=false` 关掉了
  auth，但 host 是环回（`127.0.0.1`、`::1`、`localhost`，或者 RFC4291
  长形式 IPv6 环回）。允许但带黄色 warning。
- `"off (acknowledged risk)"` —— 非环回 bind，只有同时设置
  `--i-accept-account-suspension-risk` 时才允许。允许但带红色 warning。

其他情况都**抛错**，附带指向 README 的描述性提示。CLI 捕获 throw 并
`process.exit(2)`。这一关在 `applyOptions` 之前跑，所以被拒绝启动时
我们不会去初始化 DB 或者拉上游 token。

`isLoopbackHost(host)` 处理：
- `localhost`、`127.x.y.z`（带每位 0-255 边界检查）
- `::1`、`[::1]`、`0:0:0:0:0:0:0:1`、零填满版本
- `::ffff:127.0.0.1`（IPv4 映射的 IPv6 环回）
- `LOCALHOST`（大小写不敏感）、`127.0.0.1\n`（trim）
- 拒绝相似但不是环回的：`128.x.x.x`、`127.0.0.999`、
  `127.0.0.1.attacker.com`、`127.0.0.1:80`、`127.0.0.1/24`

`formatBindAddress(host, port)` 把 IPv6 按 RFC 3986 加方括号，
`::1` 显示成 `[::1]:4141`，不再是有歧义的 `::1:4141`。

`config-store.ts` 里的 `setRuntimeAuthOverride(boolean)` —— 仅当 CLI
显式传了 `--no-auth` 时才调用（#33 评审 R2 修复）。否则配置文件里
的 `features.auth` 是权威值。schema 默认从 `false` 翻成了 `true`。

---

## 5. 测试体系

525 个测试横跨 27 个文件。每个测试文件用同一套生命周期：

```ts
beforeEach: (
  fresh tmp 目录 → fresh DB → loadConfig(临时) → 重置任何模块级状态
)
afterEach: (
  closeDb → resetDb → 删 tmp 目录 → loadConfig("__nonexistent__")
  这样内存里的 config 不会把 features.auth=true 泄露到下一个文件
)
```

按功能拆分的测试文件：

| 文件 | 数量 | 覆盖范围 |
|------|------:|----------|
| `keys.test.ts` | 35 | 生成、hash、校验、分页、debug TTL |
| `auth.test.ts` | 22 | 401 / 403 路径、model scope、WWW-Authenticate、no-auth 模式 |
| `audit.test.ts` | 25 | mode 0600、append 不截断、保留期、auth.reject 不留 token |
| `admin.test.ts` | 38 | CSRF、sessions、登录、cookie 标志、HTML 结构、healthz/readyz |
| `admin-keys.test.ts` | 37 | flash store 不可重放、吊销立刻生效、debug 二次确认、1000 key 性能、label 中 XSS 转义 |
| `auth-mode.test.ts` | 16 | 环回各种变种、IPv6 长形式、--no-auth + ack 组合 |
| `config-store.test.ts` | 30 | schema 默认值、runtime override、watchConfig 热加载 |
| `telemetry.test.ts` | 14 | 各状态码下的行形态、流式有/无 usage、断开回归（R1）、对 recordEvent 失败的间谍测试 |
| `usage-queries.test.ts` | 24 | 聚合、EXPLAIN 用索引、RFC 4180 来回、公式注入、1M 行性能（CI 跳过） |
| `admin-usage.test.ts` | 11 | 会话重定向、图表岛、CSP、CSV mime + body |
| `trace-redaction-fuzz.test.ts` | 21 | 1000 输入属性测试、每个 issuer 模式、事后启发式抓未知形态 |
| `trace.test.ts` | 22 | 文件权限 0600、traces_days=0 不写、保留期扫除 + 1GB cap、路径穿越（URL 编码、符号链接）、broadcaster 扇出 + 上限 + 丢老的、X-Capi-Debug 中间件启用 |
| + 14 个先前的测试文件（model routing、native messages 等）| 其余 | 未改动 |

---

## 6. CSP 与客户端 JS

CSP 应用到每个 `/admin` 响应：

```
default-src 'self';
frame-ancestors 'none';
form-action 'self';
img-src 'self' data:;
style-src 'self' 'unsafe-inline'
```

其他安全头：`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、
`X-Content-Type-Options: nosniff`。

`script-src` 没显式设，所以继承 `default-src 'self'` —— **不允许**
inline script，**不允许** inline 事件处理器（`onclick="..."` 等）。
所有交互在三个外部文件里：

- `src/admin/assets/keys.js` —— debug 确认 modal、key created banner
  的复制按钮、"我已复制"门控 + beforeunload 警告
- `src/admin/assets/usage.js` —— 读取 JSON 岛，实例化三个 uPlot 图
- `src/admin/assets/traces.js` —— 打开 EventSource，往 `<pre>` 里
  追加行

`src/admin/assets/uplot.min.js` 是 vendor 进来的 uPlot 1.6.32
（MIT，~50 KB 压缩，从 jsdelivr 拉的）。

---

## 7. CLI 接口（`src/start.ts`）

```
start [--port 4141]
      [--host 127.0.0.1]                            # 默认只绑环回
      [--no-auth]                                    # legacy 无认证，受门控
      [--i-accept-account-suspension-risk]          # 非环回 no-auth 必带
      [--account-type individual|business|enterprise]
      [--manual]                                     # 每请求人工确认
      [--rate-limit <seconds>]
      [--wait]                                       # 限速时等待而非报错
      [--github-token <token>]                       # 跳过交互式认证
      [--claude-code]                                # 输出 ANTHROPIC_* 环境脚本
      [--show-token]
      [--proxy-env]
      [--verbose]
```

启动序列（`runServer`）：

1. `ensurePaths()` + `loadConfig()`
2. `resolveAuthMode({...})` —— 不安全组合时**抛错**。命令的
   `run({})` 里 catch 后红色打印 + `process.exit(2)`。
3. 若传了 `--no-auth`，`setRuntimeAuthOverride(false)`。
4. `applyOptions()` —— 代理环境、版本获取、github + copilot token、
   cache models。
5. `initDb()` —— 在 WAL 下跑全部 5 个迁移。
6. `initAudit()` —— 审计 JSONL 的保留期扫除。
7. `logAuthModeBanner(authMode)` —— 打印 `[auth] mode=X bind=Y`。
8. `runBootstrap()` —— 若 `features.auth` 开启且没有任何 admin key，
   创建一把并写入 `admin.key.txt`（mode 0600，O_EXCL）。
9. `startPeriodicSweepers()`：
   - sessions：每小时
   - debug TTL：每 60 秒
10. `startEventRetention()` → cancel 句柄入关停钩子。
11. `startTraceRetention()` → cancel 句柄入关停钩子。
12. 若 `features.auth` 关，审计 `server.start_no_auth` 并带 bind
    address。
13. `installShutdownHandlers(...)` —— SIGINT/SIGTERM 时停掉所有
    sweeper，然后关闭 DB，最后 `process.exit`。
14. `serve({ fetch: server.fetch, port, hostname })`。

---

## 8. 文件系统布局

```
~/.local/share/copilot-api/
├── config.json                              # Zod 校验过，mode 0600
├── copilot-api.db                           # bun:sqlite WAL
├── copilot-api.db-shm
├── copilot-api.db-wal
├── github_token                             # 用户的 GH token，mode 0600
├── admin.key.txt                            # 一次性 bootstrap key
├── audit-YYYY-MM-DD.jsonl                   # 按天滚动的审计日志
└── traces/
    ├── traces-YYYY-MM-DD.jsonl              # 仅当 traces_days > 0
    └── ...
```

所有文件权限 0600，目录权限 0700。`hardenDbFiles`（lib/db.ts）在
`lstat` 拒绝符号链接之后通过 `fchmod`（基于打开的 fd）做 chmod ——
TOCTOU 安全。

---

## 9. 横切决策 / 非显然之处

- **bun:sqlite `TransformStream.cancel` 不会在下游 cancel 时触发。**
  所有需要在流关闭后做埋点的地方都改成手写 `ReadableStream`
  （`telemetry.ts`、`trace.ts`、traces/route.tsx、usage/route.tsx）。
- **`/admin/audit` 是个例外** —— 不被会话路由接管，作为 admin API
  跑过 API key 认证链。它不是 WebUI 页面。
- **`features.auth` 默认值**从 `false` 翻成了 `true`。没有 config.json
  的现有安装会进入 "auth on" + bootstrap 流程。
- **`traces_days` 默认值**从 `7` 翻成了 `0`，遵循隐私优先：on-disk
  持久化是显式 opt-in。在 `traces_days = 0` 时 broadcaster 仍能收到
  事件用于实时 tail，只是不落盘。
- **`features.auth=false` 写在 config.json 里**不再被**静默忽略**——
  它经过和 `--no-auth` 一样的安全门，所以非环回 bind 时用 config
  逃逸也得有 `--i-accept-account-suspension-risk` 才放行。
- **Best-effort 审计策略**：写不进去的审计追加（磁盘满、EACCES 等）
  落到 `consola.error` 然后继续。触发它的 mutation 已经提交在 DB
  里，**不应**回滚。审计是可观测性，不是持久性。
- **遥测 / trace 失败永远不向客户端传递。**两个中间件都把后置工作
  包在 try/catch 里走 consola。契约：哪怕整个 DB 坏了，代理也要能
  返回 200 + 有效的 Copilot 响应。
- **`assertRedacted` 用独立的 pattern**，不是把 `BODY_PATTERNS`
  在自己输出上再跑一遍。这样能抓到未知 secret 家族。
- **Sessions 在 subscribe 时同步占位**，不是在 ReadableStream 的
  `start()` 里。堵住了 4 订阅上限的 check-then-act 窗口。

---

## 10. 已知限制

1. **CSRF 密钥是进程生命期内存版。**重启会让所有现有浏览器会话的
   CSRF token 失效；用户必须重新登录。`csrf.ts` 有注释。
2. **Trace 没抓上游那段。**Writer schema 里有 `upstream_req` /
   `upstream_res` 字段，但目前没有任何 service 调用
   `c.set("trace_capture", ...)`。下一步是穿管道到
   `src/services/copilot/*` 里每个 helper。
3. **p95 延迟用每桶 OFFSET 取**（bun:sqlite 没有 window 函数）。
   30 天窗口 + 约 3000 万 events 时是 720 桶查询带每桶排序。实践上
   够快；`queries.ts` 里有性能注释。
4. **Bun 的 `TransformStream.cancel`** 在下游 cancel 时不触发 ——
   见第 9 节。如果未来 Bun 修了这个，手写 `ReadableStream` 包裹可以
   换回更简洁的 `pipeThrough` 模式。
5. **`Last-Event-ID` 断线重连**在服务端重启时最多丢失 ring-size
   （100 帧）数据，因为 `monotonicId` 会清零。
6. **没有多进程支持。**Trace broadcaster、CSRF 密钥、session 表、
   rate-limit 桶全部在进程内。未来多实例部署需要粘性会话 + 共享
   pub-sub（Redis 等）。

---

## 11. Commit 索引

```
303eb40  feat(auth)        keys 表、sk-cap 生成器、bootstrap          #28
574f9fd  fix(auth)         #28 评审修复                                #28
2259356  feat(auth)        Bearer auth + 限速 + model scope            #29
82ed67b  feat(audit)       审计日志 + /admin/audit                     #30
647ce71  feat(admin)       Admin WebUI 外壳 + 登录 + CSRF + CSP        #31
0d02f79  fix(admin)        #31 评审修复                                #31
7277dea  feat(admin-keys)  Keys 管理 UI + debug TTL                    #32
81477aa  fix(admin-keys)   #32 评审修复                                #32
c77b6b6  feat(auth)        --no-auth 安全门 + 弃用计划                  #33
37f0495  fix(auth)         #33 评审修复                                #33
8a9e500  feat(telemetry)   events 表 + 中间件 + 保留期                  #34
208ed8b  fix(telemetry)    #34 评审修复                                #34
25ddb4a  feat(usage)       Admin 看板 + uPlot + CSV                    #35
66644eb  fix(usage)        #35 评审修复                                #35
e1c4e73  feat(traces)      调试 trace + 脱敏 + SSE                     #36
e0a6c97  fix(traces)       #36 评审修复                                #36
```

每个 `fix(...)` 提交都是对应 `feat(...)` 提交并行 crew 评审之后的修复
回应。两边特意在 git 历史里分开保留。
