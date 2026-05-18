# Copilot API 实现总览（中文）

> 项目至今所有功能模块、实现细节、安全要点的统一文档。
> 按主题模块组织，每节遵循 **背景 → 实现 → 安全/性能 → 文件位置** 的结构。
>
> **范围**：从 issue #2 起的所有实现工作，涵盖 Responses API 适配、
> Anthropic 兼容层、原生 Anthropic 透传、模型路由、配置管理、数据库基础
> 以及 Admin Plane（#23-#36）整套管理面板。

---

## 目录

- [§1 Responses API 适配（#2, #4, #6, #7, #11, #12）](#1-responses-api-适配)
- [§2 Anthropic Messages 适配器（#8, #9, #10, #13）](#2-anthropic-messages-适配器)
- [§3 原生 Anthropic 透传（#37–#46）](#3-原生-anthropic-透传)
- [§4 模型路由分类器（#5）](#4-模型路由分类器)
- [§5 模型别名重写（#25, #26）](#5-模型别名重写)
- [§6 配置管理（#24）](#6-配置管理)
- [§7 SQLite 基础（#27）](#7-sqlite-基础)
- [§8 Admin Plane Epic（#23, #28–#36）](#8-admin-plane-epic)
  - [§8.0 拓扑](#80-拓扑)
  - [§8.1 表结构](#81-数据库-schema)
  - [§8.2 服务层](#82-服务层)
  - [§8.3 中间件](#83-中间件)
  - [§8.4 HTTP 接口](#84-http-接口)
- [§9 横切关注点](#9-横切关注点)
  - [§9.1 测试体系](#91-测试体系)
  - [§9.2 CSP 与客户端 JS](#92-csp-与客户端-js)
  - [§9.3 CLI 接口](#93-cli-接口)
  - [§9.4 文件系统布局](#94-文件系统布局)
  - [§9.5 横切决策](#95-横切决策)
  - [§9.6 已知限制](#96-已知限制)
- [§10 提交索引](#10-提交索引)

---

## §1 Responses API 适配

**涉及 issue：** #2 类型补全、#4 上游服务客户端、#6 SSE 净化、#7
reasoning_effort、#11 vision header、#12 previous_response_id

### 背景

GitHub Copilot 暗用 OpenAI 的 Responses API（`/v1/responses`），那是
比 Chat Completions 更新的接口，原生支持 reasoning blocks、
tool_calls、image inputs。我们把它直通出去，并修正 GitHub 的实现
里几个非标准之处。

### 实现

**`src/routes/responses/`**

- `types.ts` —— Responses API 完整类型覆盖（`ResponsesPayload`、
  `ResponsesResponse`、`ResponseChunk`、`ResponseStreamEvent` 等）。
- `route.ts` —— Hono 路由挂载 `/responses` + `/v1/responses`。
- `handler.ts` —— 入站负载解析；模型 alias 重写（与 chat-completions
  对称）；调用 `upstreamCreateResponses`；流式响应包成 SSE 转发。
- `translation.ts` —— 上游响应的 **SSE 净化**：
  1. 去除字段值为 `null` 的 `status`（GitHub 偶发返回 `status: null`
     却在 spec 里此字段不可为 null）。
  2. 保留 `encrypted_content`，并把 `response.reasoning.encrypted_content`
     回填到 reasoning summary 中，避免后续 `previous_response_id`
     调用因丢失 encrypted_content 而 422。

**X-Initiator 头部**：`src/services/copilot/create-responses.ts` 中根据
消息历史是否包含 assistant/tool 角色，设置 `X-Initiator: agent` 或
`X-Initiator: user`。GitHub 用这个区分 agent 调用以做配额计费。

**Vision 支持**：检查任一 message.content 是否包含 `image_url`，是则
往 `copilotHeaders()` 注入 `Copilot-Vision-Request: true`。

**Reasoning effort**：`reasoning_effort` 字段（`minimal|low|medium|high`）
直通上游；route 层做枚举校验避免无效值。

### 安全/性能

- 流式响应通过 `hono/streaming` 的 `streamSSE`，handler 出错时
  Hono 的默认错误处理器接管 —— 早期 #4 评审发现没装错误处理就走
  unhandled rejection。
- `encrypted_content` 字段是 GitHub 内部 KV 引用；丢了会让对话
  上下文无法被 `previous_response_id` 续接，所以**净化时必须保留**
  而不是无脑删 null。

### 文件位置

```
src/routes/responses/{route,handler,translation,types}.ts
src/services/copilot/create-responses.ts
tests/responses-route.test.ts
tests/responses-streaming.test.ts
```

---

## §2 Anthropic Messages 适配器

**涉及 issue：** #8 入站翻译、#9 thinking block、#10 SSE 流翻译、
#13 路径与 reasoning 保真度测试

### 背景

为了让 Claude Code 等 Anthropic 客户端使用 Copilot，我们暴露
`/v1/messages` 端点，把 Anthropic Messages 协议双向翻译成 OpenAI
Responses API（**不是** chat completions —— Claude/GPT 的高级 reasoning
模型走 Responses API 路径以保留 thinking blocks）。

### 实现

**`src/routes/messages/`**

```
anthropic-types.ts          —— 入站请求与响应的 Anthropic 协议类型
anthropic-to-responses.ts   —— Anthropic Messages → OpenAI Responses
                              （system prompt 合并、tool_use 转译、
                              image content 镜像）
responses-to-anthropic.ts   —— 非流式响应反向翻译
stream-translation.ts       —— Anthropic SSE 帧构造工具
                              （message_start / content_block_start /
                              content_block_delta / content_block_stop /
                              message_delta / message_stop）
responses-stream-translation.ts —— **核心**：把 OpenAI Responses 流
                              的事件序列翻译成 Anthropic 流的事件序列。
                              这是整个适配器最复杂的部分。
non-stream-translation.ts   —— 非流式响应组装
handler.ts                  —— Hono handler 入口
route.ts                    —— /v1/messages 挂载
utils.ts                    —— content normalization 等小工具
count-tokens-handler.ts     —— /v1/messages/count_tokens 端点
```

### 翻译要点

#### Anthropic → Responses（入站）

- `system` 字段（顶层 prompt）合并为 `instructions`。
- `messages[]` 翻译成 `input` 数组；image content（base64 或 URL）
  保留为 `input_image`。
- `tools[]` 翻译；`tool_choice` 直通。
- `thinking.enabled` 映射到 `reasoning_effort: "medium"`（保守
  默认；Anthropic 不暴露细分等级）。

#### Responses → Anthropic（出站）

- `output[*].type === "message"` → Anthropic `content[*].type ==
  "text"`。
- `output[*].type === "reasoning"` → Anthropic `content[*].type ==
  "thinking"`。**关键**：保留 reasoning block 顺序与 message block
  顺序的相对位置，这是 Anthropic 客户端区分"思考"和"回答"的依据。
- `output[*].type === "function_call"` → Anthropic `tool_use`。
- `usage.input_tokens` ← `usage.prompt_tokens`；
  `usage.output_tokens` ← `usage.completion_tokens`。

#### 流式翻译（最复杂）

OpenAI Responses 流：`response.created`、`response.output_item.added`、
`response.output_item.done`、`response.output_text.delta` 等。
Anthropic 流：`message_start`、`content_block_start`、`*_delta`、
`*_stop`、`message_delta`、`message_stop`。

`responses-stream-translation.ts` 通过状态机把扁平的 Responses 事件
序列重新组织成嵌套的 Anthropic 块结构：

- 每个 Responses `output_item` 翻译成一个 Anthropic content_block 对。
- text delta 累积成 `content_block_delta` 帧，类型 `text_delta`。
- reasoning delta 类似，类型 `thinking_delta`。
- tool_use 触发 `content_block_start` + 多个 `input_json_delta`。
- 最后输出 `message_delta` 携带 usage 与 stop_reason。

### 安全/性能

- 早期 #8/#9 评审发现 reasoning block 的 `encrypted_content` 字段
  在流模式下被丢，导致 `previous_response_id` 续接失败 —— 修复版
  在 `content_block_stop` 时把 encrypted_content 作为 `signature`
  字段塞进 Anthropic 的 thinking block。
- #10 评审发现非 JSON SSE 数据帧（比如 `[DONE]`）被翻译器误吞掉，
  修复版把它们透传。
- `__proto__` 注入测试：模型名直通时如果某个攻击者控制的字段叫
  `__proto__`，`Object.assign` 会原型污染。我们用 `Object.create(null)`
  作为基对象 + 显式字段拷贝，杜绝。

### 文件位置

```
src/routes/messages/*.ts
tests/anthropic-to-responses.test.ts
tests/responses-to-anthropic.test.ts
tests/responses-stream-translation.test.ts
tests/native-passthrough.test.ts
```

---

## §3 原生 Anthropic 透传

**涉及 issue：** #37（VS Code header 模拟）、#38–#46（原生透传服务）

### 背景

某些 Anthropic 模型（如 `claude-sonnet-4-5`）在 GitHub Copilot 后端
直接支持原生 Anthropic 协议 —— 不需要任何翻译。原生透传保留了
Anthropic 独有的请求字段（如 `top_k`、`metadata.user_id`、
`stop_sequences`），翻译路径无法做到这一点。

### 实现

- `src/services/copilot/create-messages-native.ts` —— 直接转发
  Anthropic 协议到 Copilot 的 Anthropic-shaped 端点；保留所有客户端
  字段。
- `src/routes/messages/handler.ts` 里的**模型分流**：
  ```ts
  if (isNativeAnthropicModel(payload.model)) {
    return passthroughToNativeAnthropic(payload)
  }
  return translateThroughResponsesAPI(payload)
  ```
- VS Code header 模拟（#37, #47）：精确复刻 VS Code Copilot Chat
  扩展发出的所有 header 名/值组合，包括
  - `Copilot-Integration-Id`（值为 `vscode-chat`）
  - `OpenAI-Intent`（按模型分类）
  - `Editor-Version`、`Editor-Plugin-Version`、`User-Agent`
  - `Copilot-Vision-Request`（vision payload 时）
  - `X-Initiator`（agent vs user）
  - 详细见 `docs/prd/vscode-header-simulation.md`

### 安全/性能

- 评审两轮（#38 round 1 + round 2）发现：
  - 透传服务原先直接转发了客户端的 `anthropic-version` header；
    上游期待固定值，已改为代理服务器内部统一设置。
  - 透传分流之前先 `redactSystem` —— 移除可能携带的客户端凭据。
  - 流式响应必须用 `pipeThrough` 而非 await `text()`，否则会被代理
    缓冲整个响应再吐出。
- #46 修复了 `state.vsCodeVersion` 在 `setupCopilotToken` 之前可能
  为 undefined 的边界 —— 加了 fallback guard `?? "1.99.0"`。

### 文件位置

```
src/services/copilot/create-messages-native.ts
src/routes/messages/handler.ts（分流）
src/lib/api-config.ts（VS Code header 表）
docs/prd/native-anthropic-passthrough.md
docs/prd/vscode-header-simulation.md
tests/native-passthrough.test.ts
```

---

## §4 模型路由分类器

**涉及 issue：** #5

### 背景

不同模型走不同的 Copilot 上游端点：
- 经典模型（gpt-3.5-turbo、gpt-4 等）→ `/chat/completions`
- 新版 reasoning 模型（gpt-5、o1、o3、claude-* sonnet 等）→
  `/responses`
- 部分新模型同时存在两种端点；客户端调用 `/v1/chat/completions`
  并请求一个 responses-only 模型时，应拒绝并提示用 `/v1/responses`。

### 实现

`src/lib/model-routing.ts` 提供 `getModelMode(model)`：

```ts
type Mode = "responses" | "chat-completions" | "both"
```

判定优先级：

1. 显式正则：
   - `^gpt-5(-\d{4}-\d{2}-\d{2})?$` → responses
   - `^o[1-9](-mini|-preview)?$` → responses
   - `^codex-` → responses
2. capabilities 短路：state.models 的 `capabilities.family` 是
   `gpt-5` / `o-series` / `reasoning-only` 时 → responses
3. 默认 → chat-completions

`/v1/chat/completions` handler 检测到 responses-only 模型时返回 400
带 `responses_only_model` 错误码，引导用户改调 `/v1/responses`。

### 评审修复（#5）

- 原版用 `.capabilities` 短路时没考虑 model 不在 state.models 里
  的情况 —— 加了 undefined guard。
- 正则 `o[1-9]` 误拒了未来的 `o10` 等 —— 改成 `o\d+`。
- 评审 round 2 发现 `gpt-5-2024-03-15` 这类带日期后缀的 alias
  没匹配 —— 正则加 `(-\d{4}-\d{2}-\d{2})?`。

### 文件位置

```
src/lib/model-routing.ts
tests/model-routing.test.ts
```

---

## §5 模型别名重写

**涉及 issue：** #25 双向 alias、#26 /v1/models 过滤

### 背景

`config.json` 中 `models` 字段定义客户端可见的别名映射：

```jsonc
{
  "models": {
    "my-fast-model": { "upstream": "gpt-4o-mini", "enabled": true },
    "claude-sonnet": { "upstream": "claude-sonnet-4-5", "enabled": true }
  }
}
```

客户端发送 `model: "my-fast-model"`，代理改写为 `gpt-4o-mini` 转发到
上游，再把响应里的 `model` 字段改回 `my-fast-model`。

### 实现

`src/lib/alias.ts`：

```ts
resolveAlias(clientFacing, models): string       // ingress: alias → upstream
resolveUpstream(upstream, models): string        // egress: upstream → alias
```

每个 handler 拿 **同一个 config snapshot**（防止 ingress/egress
之间 config 热重载导致不一致）。

`/v1/models` 端点根据 config 里的 alias 表过滤：
- 没配 alias → 直接转发上游 model 列表
- 配了 alias → 只返回 `enabled: true` 的 alias（隐藏上游真名）
- 全部 `enabled: false` → 返回空 `data: []`，**不**泄露上游

### 评审修复

- #25 round 2 发现 SSE 流响应的 `model` 字段没改回 alias —— 修复版
  在 stream chunk 解析时也跑 `resolveUpstream`，但**只**改顶层
  `model` 字段，绝不动嵌套（避免破坏 tool_calls arguments）。
- #26 发现 SSRF 风险：`upstream` 字段如果是 URL（`https://attacker`）
  会被当模型名转发 —— config schema 加了正则
  `/^\w[\w.:-]*$/` 拒绝 URL 形态。

### 文件位置

```
src/lib/alias.ts
src/routes/models/handler.ts
src/routes/models/route.ts
src/routes/chat-completions/handler.ts（ingress/egress 调用点）
src/routes/messages/handler.ts（同上）
tests/alias.test.ts
tests/model-routing.test.ts
```

---

## §6 配置管理

**涉及 issue：** #24

### 背景

之前所有配置都是 CLI 参数或环境变量。引入 `config.json` 后需要：
原子写入、热重载、schema 校验、安全权限。

### 实现

`src/lib/config-store.ts`：

```ts
ConfigSchema: ZodObject<{
  version: literal(1),
  models: Record<string, ModelEntrySchema>,
  retention: { events_days, traces_days, traces_max_bytes, audit_days },
  features: { auth: boolean, telemetry: boolean, debug: boolean }
}>

loadConfig(filePath?): Promise<Config>    // 异步读 + 校验 + 缓存
saveConfig(config, filePath?): void        // 原子写（tmp + rename + fsync）
getConfig(): Readonly<Config>              // 返回深冻结快照
watchConfig(onChange, filePath?): dispose  // fs.watch 带 250ms 防抖
initConfig(onChange?, filePath?): dispose  // load + watch 一气
setRuntimeAuthOverride(boolean | undefined) // CLI 覆盖（见 §8.3）
```

### 原子写入

1. 生成 tmp 路径：`config.json.<pid>.<8-hex>.tmp`（PID + 随机后缀防
   TOCTOU 符号链接攻击）。
2. `mkdir` 父目录，mode 0o700。
3. `O_WRONLY | O_CREAT | O_TRUNC` 打开，写入，`fsync`，关闭。
4. `chmod` 设置 0o600（双保险）。
5. `rename` 到目标路径（POSIX 原子）。
6. 父目录 `fsync` 持久化目录项（Windows 跳过 —— NTFS journal 已保证）。

### 热重载

`watchConfig` 用 `fs.watch` 监听**父目录**（而非文件本身，因为
`rename` 替换文件会让基于 inode 的 watcher 失效）。filename 不匹配时
忽略；匹配时 250ms 防抖后异步重新 loadConfig。校验失败时**保留旧
config**，打 warn 日志。

### 评审修复（#24）

- 原版用 `fs.openSync(file, "w")` 不设 mode → 文件权限走 umask，
  实际可能是 0o644。修复版 `0o600` 明示传入。
- watch 回调里 callback 拿到的是直接引用而非冻结快照，调用方理论上
  能改 `_currentConfig`。修复：`onChange(deepFreeze(structuredClone(...)))`。
- `XDG_DATA_HOME` 可以是相对路径攻击向量（设成 `../../etc`）—— 增加
  `path.isAbsolute(xdg)` 检查，相对路径回落到 `~/.local/share`。

### 文件位置

```
src/lib/config-store.ts
src/lib/paths.ts
tests/config-store.test.ts
```

---

## §7 SQLite 基础

**涉及 issue：** #27

### 背景

audit 日志、key 管理、session、events、debug TTL 都需要持久化。
选 `bun:sqlite`（Bun 原生绑定，单文件部署友好，WAL 模式下读写并发好）。

### 实现

`src/lib/db.ts`：

```ts
openDb(filePath?): Database
hardenDbFiles(dbFile): void        // 把 db/-wal/-shm chmod 0o600
runMigrations(database, dir?): void
initDb(filePath?, migrationsDir?): Database   // open + migrate + harden
getDb(): Database                  // 模块级单例
closeDb(database): void
resetDb(): void                    // 测试用
```

### WAL + 权限

```ts
process.umask(0o077)           // 新建文件强制 0o600
new Database(file, { create: true })
process.umask(prev)            // 恢复

run("PRAGMA journal_mode=WAL")
run("PRAGMA synchronous=NORMAL")
run("PRAGMA foreign_keys=ON")

// 校验 WAL 真生效（防 read-only 文件系统等情况）
const row = query("PRAGMA journal_mode").get()
if (row?.journal_mode !== "wal") throw new Error(...)

hardenDbFiles(file)            // 对 -wal、-shm 也设 0o600
```

`hardenDbFiles` 用 **lstat 拒绝符号链接 → fchmod 在打开的 fd 上**
做 TOCTOU 安全的权限修改。

### 迁移运行器

PRAGMA `user_version` 驱动：

1. 读当前 `user_version`。
2. 列举 `migrations/` 下 `^\d{3}_.+\.sql$` 文件，按文件名排序。
3. 跳过 num ≤ version 的文件。
4. 每个文件：
   - `BEGIN EXCLUSIVE`（立即拿写锁，避免迁移途中 SQLITE_BUSY）
   - 跳过纯注释文件（`001_init.sql` 是占位符）
   - `run(sql)` 执行 SQL
   - `PRAGMA user_version = ${num}`（PRAGMA 不接受绑定参数，
     这里把已校验的整数插入）
   - `COMMIT`
5. 出错 → `ROLLBACK` + 抛错。

### 文件位置

```
src/lib/db.ts
src/lib/migrations/*.sql
tests/db.test.ts
```

---

## §8 Admin Plane Epic

**涉及 issue：** epic #23 + #28（keys）+ #29（auth）+ #30（audit）+
#31（WebUI shell）+ #32（keys 管理）+ #33（--no-auth 安全门）+ #34
（telemetry）+ #35（usage 看板）+ #36（debug trace）

### §8.0 拓扑

```
┌────────────── HTTP 入口 ──────────────┐
│ logger() → cors()                     │
│                                       │
│ ─── 公开（免认证）───                  │
│   /, /healthz, /readyz                │
│   /admin/assets/* （静态）            │
│   /admin/login                        │
│                                       │
│ ─── API key 认证挂载 ───              │
│   server.use("*", 路径跳过→auth)      │
│                                       │
│ ─── 遥测挂载 ───                       │
│   server.use("*", 路径跳过→telemetry) │
│                                       │
│ ─── trace 挂载 ───                     │
│   server.use("*", 路径跳过→trace)     │
│                                       │
│ ─── Admin API ───                      │
│   /admin/audit （admin tier）         │
│                                       │
│ ─── 会话保护 admin WebUI ───           │
│   /admin (overview)                   │
│   /admin/keys                         │
│   /admin/usage                        │
│   /admin/traces                       │
│                                       │
│ ─── 代理路由 ───                       │
│   /chat/completions /v1/chat/completions  │
│   /messages /v1/messages              │
│   /embeddings /v1/embeddings          │
│   /responses /v1/responses            │
│   /models /v1/models                  │
│   /usage /token                       │
└───────────────────────────────────────┘
```

挂载顺序至关重要：auth 先于 telemetry（需要 `c.var.key`），telemetry
先于 trace（保证 trace 和 event 用同一 key_id），三者都先于代理路由
处理器（这样可以包裹响应体）。

### §8.1 数据库 Schema

#### 002_keys.sql（#28）

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

- `hash` = `SHA-256(明文)` 十六进制。**明文绝不进库。**UNIQUE 自动建索引。
- `json_valid` 拒非法 JSON；服务层 `validateAllowedModels` 进一步拒
  URL 形态防 SSRF。
- 软删除：`revoked_at` 不置空即吊销，行保留供审计。

#### 003_sessions.sql（#31）

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

- `id` = 32 随机字节 hex（256 bit 熵）。
- 级联删除：key 被硬删时其 session 一并清掉。
- `csrf_token` 持久化但**当前中间件不直接比对**，比对的是 HMAC
  派生值（见 §8.3）。

#### 004_debug_expires.sql（#32）

```sql
ALTER TABLE keys ADD COLUMN debug_expires_at INTEGER;
```

debug 模式自动 24 小时失效，由 sweeper 每 60 秒检查。

#### 005_events.sql（#34）

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,             -- '__noauth__' 哨兵
  model TEXT NOT NULL,              -- 客户端可见 alias
  upstream_model TEXT NOT NULL,     -- alias 解析后真实模型
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  error TEXT,                       -- 短固定词汇 tag
  usage_unknown INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_key_ts    ON events(key_id, ts);
CREATE INDEX idx_events_model_ts  ON events(model, ts);
```

- `key_id` **不**带 FK，让 `__noauth__` 哨兵能插。
- `error` 是低基数 tag（`bad_request`、`rate_limited`、
  `client_aborted` 等），**绝不**是响应体。

### §8.2 服务层

#### `keys.ts`（#28, #32）

**Key 生成**：33 随机字节（264 bit）→ base32 → 52 字符 →
`sk-cap-` + 52 = 59 字符。264 bit ≥ 256 bit，所以静态用不加盐
SHA-256。

```
sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
       └────── 52 个 base32 大写字符 ──────┘
```

**`isDebugActive(row, now)` —— 单一真理源**

```ts
if (row.debug_enabled !== 1) return false
if (row.revoked_at !== null) return false
if (row.debug_expires_at !== null && row.debug_expires_at <= now) return false
return true
```

`#32` 评审发现直接比较 `row.debug_enabled === 1` 在 60 秒 sweeper
窗口内会过时；改用这个函数后所有显示/逻辑路径一致。

**`countActiveDebugKeys()` —— TTL 感知 COUNT**

```sql
SELECT COUNT(*) FROM keys
 WHERE debug_enabled = 1
   AND revoked_at IS NULL
   AND (debug_expires_at IS NULL OR debug_expires_at > ?)
```

驱动每个 admin 页面顶部的红色 banner。

**其他**：`createKey`、`revokeKey`（幂等软删）、`listKeys(limit, offset)`、
`updateKeyScope`、`findKeyByHash`、`findKeyById`、`countActiveAdminKeys`、
`setDebugEnabled`（同时维护 `debug_expires_at`）。

#### `audit.ts`（#30）

JSONL 追加到 `audit-YYYY-MM-DD.jsonl`，mode 0600，
`O_WRONLY | O_CREAT | O_APPEND`。按天滚动；启动时跑保留期清理。

事件形状：

```ts
{
  ts, actor_key_id, actor_tier,
  action,         // "auth.bootstrap" "key.create" "key.revoke"
                  // "key.scope_update" "key.debug_enable"
                  // "key.debug_disable" "key.debug_renew"
                  // "key.debug_expired" "auth.reject"
                  // "server.start_no_auth"
  target?,        // 资源 id 或 bearer hash 前 8 hex
  before?, after?, ip?, user_agent?
}
```

**关键安全要点**：`auth.reject` 只记 `SHA-256(bearer)` 前 8 字节
hex，**绝不**记 bearer 本身。

#### `events.ts` + `retention.ts`（#34）

```ts
recordEvent(row): void                  // best-effort INSERT
purgeEventsOlderThan(cutoffMs): number   // 分块 DELETE 每批 1000
                                         // + await setImmediate 让出循环
startEventRetention(): cancel             // 整点对齐小时级 sweep
```

Sweeper 对齐墙上时钟整点；启动算 `msUntilNextHour()` 跑首次，之后
3600s 间隔；如果 `delta > 1.25 × HOUR_MS` 则判为系统挂起恢复，立即
跑一次补漏。返回 cancel 句柄挂入 SIGINT/SIGTERM 关停钩子。

#### `debug-ttl-sweeper.ts`（#32）

```sql
SELECT id FROM keys
 WHERE debug_enabled = 1
   AND debug_expires_at IS NOT NULL
   AND debug_expires_at <= ?
```

bulk UPDATE 失效，每行发一条 `key.debug_expired` 审计事件。
每 60 秒一次。

#### Trace 管线（#36）

```
trace.ts 中间件
     │
     ├── trace-redact.ts   （纯函数，无 IO）
     │   redactHeaders / redactBody / assertRedacted
     │
     ├── trace-writer.ts   （同步 JSONL 追加，落盘前跑 assertRedacted）
     │
     └── trace-broadcaster.ts  （进程内 SSE 发布订阅）
```

##### 两阶段脱敏

阶段 1：`redactBody(body)` 替换匹配 `BODY_PATTERNS`：
- `gh[oprsu]_[A-Za-z0-9]{20,}` —— GitHub 经典 token
- `github_pat_\w{20,}` —— 细粒度 PAT
- `eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+` —— JWT 形（Copilot bearer）
- `Iv\d+\.[A-Fa-f0-9]{16,}` —— GitHub App client id
- `sk-cap-[A-Z2-7]{52}` —— **本代理自己的 token**（#36 评审 R1 补加）
- `sk-ant-[\w-]{40,}` —— Anthropic key
- `sk-[\w-]{40,}` —— OpenAI 风格 key
- `\bAKIA[A-Z0-9]{16}\b` —— AWS access key id
- `(?<=://)[^:/@\s]+:[^@\s]{1,200}(?=@)` —— URL 内嵌 basic auth

阶段 2：`assertRedacted(line)` —— **独立**事后检查：
- 重跑 `BODY_PATTERNS`（抓替换循环 bug）
- 加跑 `POST_REDACT_HEURISTICS`：
  - `\bbearer\s+[\w+./~=-]{32,}` —— `bearer ` 后任何不透明 token
  - `\b(api[_-]?key|token|secret|password)["':=]+...{32,}`

任一抛错，writer 直接丢弃这条 trace —— 抓到未枚举的 secret 形态。

##### `trace-writer.ts`

1. 构造 JSONL 文本（脱敏 + JSON.stringify）。
2. 跑 `assertRedacted`，抛错则丢弃。
3. `traces_days <= 0` 时 return（仅内存模式）。
4. `mkdir tracesDir mode 0o700`。
5. 用 `O_WRONLY | O_CREAT | O_APPEND` mode 0o600 打开
   `traces/traces-YYYY-MM-DD.jsonl`。写入。关闭。
6. 推送到 `broadcastTrace(text)`。

##### `trace-broadcaster.ts`

进程内单点 pub-sub，给 `/admin/traces/stream`。

- 订阅上限 4；第 5 个返回 503。
- 每订阅队列上限 1 MB，溢出丢老的。
- 心跳帧每 15 秒。
- 100 条 ring buffer 支持 `Last-Event-ID` 断线重播。
- `subscribe()` **同步**占位（#36 评审 R4 修复），堵住 check-then-act 竞态。

##### `trace-retention.ts`

```ts
purgeOldTraces()    // 按年龄
enforceSizeCap()    // 按总大小（1 GB），优先删最老一天
                    // 保留期内触发删除时打 warn
startTraceRetention(): cancel
```

### §8.3 中间件

#### `auth.ts`（#29）

```
1. 无条件剥 x-api-key、cookie。
2. no-auth 模式：塞 NO_AUTH_SENTINEL（id "__noauth__"）。
3. 必须有 Authorization，不区分大小写解 "bearer "。剥 authorization。
4. SK_CAP_RE = /^sk-cap-[A-Z2-7]{52}$/，全形状校验。
5. SHA-256 比对找 key 行；未找到/已吊销 → 401。
6. 剥 x-capi-debug；admin tier 时设 c.var.debug_via_header。
7. 每 key 限速（lastTs + windowMs）。
8. c.set("key", row); next()
```

`isModelAllowed` 用 `Array.isArray` 守卫防 `"*".includes("*")` 绕过。

#### `telemetry.ts`（#34）

每请求一行。**Body model 快照**用上限 16 KB 流式读，找到
`"model": "..."` 立即返回，避免双倍缓冲 vision payload。

**流式响应埋点**（#34 评审 R1 修复，**关键发现**）：Bun 的
`TransformStream.cancel` 在下游 cancel 时**不触发**，所以 SSE 客户端
中途断开会静默丢 trace。改成手写 `ReadableStream`：

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

`recorded` 标志保证 fire 在 EOF/cancel/pull-error 三种竞态下只跑一次。

#### `trace.ts`（#36）

激活条件（任一）：
- `isDebugActive(c.get("key"))`
- `c.get("debug_via_header")`（admin tier + `X-Capi-Debug: 1`）

256 KB 每段上限，超出填 `[TRUNCATED]`。v1 仅抓客户端→代理→客户端
两段；上游段需要在每个 `src/services/copilot/*` helper 里穿管道
（留 TODO）。

#### `session-middleware.ts`（#31）

```
1. HTTPS-或-环回守卫；X-Forwarded-Proto 仅 TRUST_PROXY=true 时信任。
2. 提取 sid cookie；不存在 → 302 /admin/login。
3. CSRF（非 GET 方法）：
   - Sec-Fetch-Site 必须 same-origin
   - x-csrf-token header（或表单 body 字段 csrf_token，用于 HTML 表单）
   - csrf cookie
   - 两个 token 都必须 verifyCsrfToken(sid, ...) 成功
4. getSession(sid)（同时滑动 expires_at）。
5. c.set("session", session); next()
6. 响应时 c.res.headers.append Set-Cookie（滑动浏览器 cookie 的 Max-Age）
```

**`requireAdminSession`**（#35 评审 F-6 修复）—— 每请求重新查
keys 表，发现 key 缺失/吊销/非 admin 立即拆会话。深度防御。

`csrf.ts`：

```ts
generateCsrfToken(sid) = base64url(HMAC-SHA256(sid, CSRF_SECRET))
verifyCsrfToken(sid, t) = timingSafeEqual(expected, t)
```

`CSRF_SECRET = crypto.randomBytes(32)` 模块加载时生成。**已知限制**：
进程重启使所有 CSRF token 失效，用户需重新登录。

### §8.4 HTTP 接口

#### `/admin/login`

- GET：服务端渲染表单。
- POST：
  1. `findKeyByHash(sha256(明文))`
  2. 拒绝：未找到/已吊销/非 admin
  3. **删除同 key 旧会话**（#31 评审修复，防止偷的会话在重新登录后还活）
  4. `createSession(keyRow.id)` → 新 sid + csrf
  5. 303 → /admin

Cookie 属性：

```
sid=<hex>;  HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800
csrf=<hmac>; Secure; SameSite=Strict; Path=/admin
```

CSRF cookie 不带 HttpOnly（JS/表单需要读它做 double-submit）。

#### `/admin/keys`

| Method | Path                          | 动作                       |
|--------|-------------------------------|----------------------------|
| GET    | `/admin/keys`                 | 列表，50/页                 |
| GET    | `/admin/keys/new`             | 创建表单                    |
| POST   | `/admin/keys/new`             | 创建 + 闪存明文             |
| GET    | `/admin/keys/created?flash=X` | 一次性明文显示              |
| GET    | `/admin/keys/:id`             | 详情/编辑                   |
| POST   | `/admin/keys/:id/revoke`      | 软删                        |
| POST   | `/admin/keys/:id/scope`       | 更新 allowed_models + rate  |
| POST   | `/admin/keys/:id/debug`       | 启用/停用/续期 debug        |

**Flash store** 进程级 `Map`，5 分钟 TTL，一次性消费。URL 上的 token
是 `crypto.randomUUID()`。刷新页面会拿到 410 Gone 带"明文不再可用"
错误（#32 评审 F-3 修复）。

**Debug 二次确认**是**服务端门控**（#32 评审 R2 修复）：表单同时
提交 `debug_enabled=1` AND `debug_confirm=yes`。后者由 `keys.js` 在
modal 确认后设置。**没有 JS 完全启用不了 debug**。CSP 禁止 inline
script + inline `onclick`，所有交互都在外部 `keys.js`。

**Renew 按钮**（#32 评审 R1 修复）：原与 Disable 共用一个表单，
表单总提交 `debug_enabled=0`，点 Renew 实际是悄悄停用。改成两个
独立表单；renew 表单提交 `action=renew`，handler 强制
`setDebugEnabled(id, true)`。

#### `/admin/usage`（#35）

`queries.ts` 提供 SQL helper（全部走索引，EXPLAIN QUERY PLAN 测试覆盖）：

```ts
requestsPerMinute(filter)
tokensPerHour(filter)
p95LatencyPerHour(filter)          // 两阶段桶 + OFFSET，无 window 函数
topKeysByTokens, topModelsByRequests
errorRateByKey
streamEventsForCsv                  // .iterate() 流式
distinctModels
```

**CSV 导出** `/admin/usage/export.csv`：

- **拉式** ReadableStream（#35 评审 F-2 修复）：`pull()` 一行一行
  `iter.next()`，客户端慢自动背压。
- `cancel()` 调用 `iter.return?.()` 终结 SQLite 迭代器，释放读事务。
- RFC 4180 引号 + **公式注入守卫**（#35 评审 F-1 修复）：值首字符
  是 `=`、`+`、`-`、`@`、`\t`、`\r` 时前缀单引号。Excel/Numbers/
  LibreOffice 把单引号当文本压制符渲染，击败 `=cmd|'/c calc'!A1` 攻击。

**自定义时间窗口上限**（#35 评审 F-9 修复）：钳到 90 天，防止恶意
请求长期占读事务。

**JSON 数据岛**：在 `<script type="application/json" id="usage-data">`
里。`<`、`>`、`&`、U+2028、U+2029 全部转义成 `\uXXXX`（#35 评审
F-3 修复），HTML 分词器看到不透明 payload。

#### `/admin/traces`（#36）

| Method | Path                            | 动作                              |
|--------|---------------------------------|-----------------------------------|
| GET    | `/admin/traces`                 | 实时 tail 页面                    |
| GET    | `/admin/traces/stream`          | SSE 流                            |
| GET    | `/admin/traces/:filename`       | 流式 JSONL 下载                   |

**路径穿越守卫**（#36 评审 R3 修复）：

1. 必须 `.jsonl` 结尾。
2. 日期必须 `^\d{4}-\d{2}-\d{2}$`。
3. `path.join` 后**字面**检查 `startsWith(tracesDir() + sep)`。
4. **符号链接检查（纵深防御）**：`fs.realpathSync.native`，
   resolved 路径必须仍在 tracesDir 内。
5. ENOENT → 404。其他错误 → 400。

**流式下载**（#36 评审 R5 修复）：`fs.readFileSync` 会冻住事件循环
100 MB 文件期间。改用 `fs.createReadStream` 包成 Web ReadableStream，
带 pause/resume 背压和 cancel 钩子销毁 Node 流。

#### Auth 模式安全门 `src/lib/auth-mode.ts`（#33）

```ts
resolveAuthMode({ noAuth, acceptRisk, host, port, configAuth }): AuthModeResult
```

三个标签：
- `"on"` —— auth 开
- `"off (loopback)"` —— auth 关 + 环回 host
- `"off (acknowledged risk)"` —— auth 关 + 非环回 + 必须有
  `--i-accept-account-suspension-risk`

其他组合**抛错**附 README 提示。CLI 捕获后红色打印 + `process.exit(2)`。

`isLoopbackHost(host)` 覆盖：
- 字面：`localhost`、`127.x.y.z`（带 0-255 边界）、`::1`、`[::1]`
- 长形式 IPv6：`0:0:0:0:0:0:0:1`、零填满
- IPv4 映射 IPv6：`::ffff:127.0.0.1`
- 大小写不敏感 + trim
- 拒绝相似：`128.x.x.x`、`127.0.0.999`、`127.0.0.1.attacker.com`、
  `127.0.0.1:80`、`127.0.0.1/24`

`formatBindAddress` 按 RFC 3986 加方括号，IPv6 显示为 `[::1]:4141`
而非有歧义的 `::1:4141`。

`setRuntimeAuthOverride(boolean)` 仅当 CLI 显式 `--no-auth` 时调用
（#33 评审 R2 修复）。否则配置文件 `features.auth` 是权威。schema
默认值从 `false` 翻成 `true`。

---

## §9 横切关注点

### §9.1 测试体系

525 个测试横跨 27 个文件，全部基于 `bun:test`。生命周期：

```ts
beforeEach: 临时目录 → 新 DB → loadConfig(临时) → 重置模块级状态
afterEach:  closeDb → resetDb → rm 临时目录 → loadConfig("__nonexistent__")
            （防止 features.auth=true 泄露到下一文件）
```

主要测试文件：

| 文件 | 数量 | 覆盖 |
|------|-----:|------|
| `keys.test.ts` | 35 | 生成、hash、校验、分页、debug TTL |
| `auth.test.ts` | 22 | 401/403 路径、model scope、WWW-Authenticate |
| `audit.test.ts` | 25 | mode 0600、append、保留期、auth.reject 不留 token |
| `admin.test.ts` | 38 | CSRF、sessions、登录、cookie 标志 |
| `admin-keys.test.ts` | 37 | flash 不可重放、吊销立刻生效、1000 key 性能、XSS |
| `auth-mode.test.ts` | 16 | 环回各变种、IPv6 长形式、ack 组合 |
| `config-store.test.ts` | 30 | schema 默认、runtime override、watch 热重载 |
| `telemetry.test.ts` | 14 | 各状态行形态、流式、断开回归（R1）、间谍测试 |
| `usage-queries.test.ts` | 24 | 聚合、EXPLAIN 用索引、CSV 来回、公式注入、1M 行性能 |
| `admin-usage.test.ts` | 11 | 会话重定向、图表岛、CSP、CSV mime + body |
| `trace-redaction-fuzz.test.ts` | 21 | 1000 输入属性测试、未知形态启发 |
| `trace.test.ts` | 22 | 文件权限、保留期、路径穿越（含符号链接）、broadcaster |
| `responses-route.test.ts` | 18 | Responses API 通路、X-Initiator、reasoning |
| `responses-streaming.test.ts` | 12 | SSE 净化、null status、encrypted_content |
| `anthropic-to-responses.test.ts` | 24 | 入站翻译完整性 |
| `responses-to-anthropic.test.ts` | 15 | 出站翻译完整性 |
| `responses-stream-translation.test.ts` | 31 | 流式翻译状态机、thinking、tool_use |
| `native-passthrough.test.ts` | 16 | 原生透传、header 模拟、版本回退 |
| `model-routing.test.ts` | 20 | 端点分类、alias 过滤 |
| `alias.test.ts` | 14 | 双向 alias 重写 |
| `db.test.ts` | 12 | WAL、迁移、权限硬化、TOCTOU |

### §9.2 CSP 与客户端 JS

CSP（所有 `/admin` 响应）：

```
default-src 'self';
frame-ancestors 'none';
form-action 'self';
img-src 'self' data:;
style-src 'self' 'unsafe-inline'
```

其他安全 header：`X-Frame-Options: DENY`、`Referrer-Policy:
no-referrer`、`X-Content-Type-Options: nosniff`。

`script-src` 未显式设 → 继承 `default-src 'self'` → 不允许 inline
script 和 inline 事件 handler。交互在三个外部 JS：

- `keys.js` —— debug 确认 modal、复制按钮、"我已复制"门控
- `usage.js` —— 读 JSON 岛、画三个 uPlot 图
- `traces.js` —— EventSource、追加到 `<pre>`

`uplot.min.js` 是 vendor 进来的 uPlot 1.6.32（MIT，~50 KB 压缩）。

### §9.3 CLI 接口

```
start [--port 4141]
      [--host 127.0.0.1]                            # 默认环回
      [--no-auth]                                    # legacy 无认证
      [--i-accept-account-suspension-risk]          # 非环回 no-auth 必带
      [--account-type individual|business|enterprise]
      [--manual]
      [--rate-limit <seconds>]
      [--wait]
      [--github-token <token>]
      [--claude-code]
      [--show-token]
      [--proxy-env]
      [--verbose]
```

启动序列（`runServer`）：

1. `ensurePaths()` + `loadConfig()`
2. `resolveAuthMode(...)` —— 不安全组合抛错（CLI 红色打印 + `exit(2)`）
3. `--no-auth` 显式传时 `setRuntimeAuthOverride(false)`
4. `applyOptions()` —— 代理、版本、token、cache models
5. `initDb()` —— 在 WAL 下跑全部 5 个迁移
6. `initAudit()` —— 审计 JSONL 保留期扫除
7. `logAuthModeBanner(authMode)`
8. `runBootstrap()` —— 首启动生成 admin key 到 `admin.key.txt`
9. `startPeriodicSweepers()` —— sessions（小时）+ debug TTL（60s）
10. `startEventRetention()` → 关停钩子
11. `startTraceRetention()` → 关停钩子
12. 若 auth 关，审计 `server.start_no_auth` 带 bind address
13. `installShutdownHandlers(...)` —— SIGINT/SIGTERM 停 sweeper +
    关 DB + `exit`
14. `serve({ fetch, port, hostname })`

### §9.4 文件系统布局

```
~/.local/share/copilot-api/
├── config.json                              # Zod 校验，mode 0600
├── copilot-api.db                           # bun:sqlite WAL
├── copilot-api.db-shm
├── copilot-api.db-wal
├── github_token                             # 用户的 GH token，mode 0600
├── admin.key.txt                            # 一次性 bootstrap key
├── audit-YYYY-MM-DD.jsonl                   # 按天滚动审计日志
└── traces/
    ├── traces-YYYY-MM-DD.jsonl              # 仅当 traces_days > 0
    └── ...
```

所有文件 0600，目录 0700。`hardenDbFiles` 通过 lstat 拒符号链接 →
fchmod 在 fd 上做 TOCTOU 安全的权限修改。

### §9.5 横切决策

- **Bun 的 `TransformStream.cancel` 在下游 cancel 时不触发。**所有
  需要在流关闭后做埋点的地方都改成手写 `ReadableStream`（telemetry、
  trace、traces 下载、usage CSV）。
- **`/admin/audit` 是例外** —— 不被会话路由接管，作为 admin API
  跑过 API key 认证链。
- **`features.auth` 默认值翻成 true。**无 config.json 的现有安装
  进入 "auth on" + bootstrap。
- **`traces_days` 默认翻成 0**（隐私优先）。落盘是显式 opt-in；
  broadcaster 在 `traces_days=0` 仍接收事件用于实时 tail。
- **config 里 `auth=false` 不再静默通过**：和 `--no-auth` 走同一
  安全门，非环回 bind 也必须 ack 才放行。
- **Best-effort 审计/遥测**：写不进时落 `consola.error` 继续，绝不
  回滚或向客户端传递。
- **`assertRedacted` 用独立 pattern**，不复跑 BODY_PATTERNS。
- **Sessions 在 subscribe 时同步占位**，堵住 4 订阅上限的
  check-then-act 窗口。
- **alias 解析使用单一 config snapshot**：handler 入口拿一次
  `getConfig()`，全 request 用同一份，防止热重载导致 ingress/egress
  不一致。
- **`Object.create(null)` 作为翻译器中间状态的基对象**，防止
  `__proto__` 字段污染原型链。

### §9.6 已知限制

1. **CSRF 密钥进程级内存**。重启后所有 CSRF token 失效，用户需重新
   登录。
2. **Trace 没抓上游段**。`upstream_req`/`upstream_res` 字段在
   schema 里但没 service 调用 `c.set("trace_capture", ...)`。
3. **p95 用每桶 OFFSET**（bun:sqlite 无 window 函数）。30 天 + 3000 万
   events 时是 720 桶查询 + 每桶排序。
4. **`Last-Event-ID` 重连在重启后最多丢 100 帧**（`monotonicId` 清零）。
5. **无多进程支持**。所有内存状态（broadcaster、CSRF 密钥、session、
   rate-limit 桶）都进程内。未来多实例部署需要粘性会话 + 共享 pub-sub。
6. **Reasoning encrypted_content 不可见**：作为不透明字符串透传，
   无法在客户端审查。

---

## §10 提交索引

按主题逆序列出（最近在前），格式 `commit  类型/范围  描述  (issue)`：

```
e0a6c97  fix(traces)        #36 评审修复                          #36
e1c4e73  feat(traces)        debug 抓取 + 脱敏 + SSE 实时 tail     #36
66644eb  fix(usage)         #35 评审修复                          #35
25ddb4a  feat(usage)         admin 看板 + uPlot + CSV              #35
208ed8b  fix(telemetry)     #34 评审修复                          #34
8a9e500  feat(telemetry)     events 表 + 中间件 + 保留期           #34
37f0495  fix(auth)          #33 评审修复                          #33
c77b6b6  feat(auth)          --no-auth 安全门 + 弃用计划           #33
81477aa  fix(admin-keys)    #32 评审修复                          #32
7277dea  feat(admin-keys)    keys 管理 UI + debug TTL              #32
0d02f79  fix(admin)         #31 评审修复                          #31
647ce71  feat(admin)         Admin WebUI 外壳 + 登录 + CSRF + CSP   #31
82ed67b  feat(audit)         审计日志 + /admin/audit                #30
2259356  feat(auth)          Bearer 认证 + 限速 + model scope       #29
574f9fd  fix(auth)          #28 评审修复                          #28
303eb40  feat(auth)          keys 表 + sk-cap 生成 + bootstrap     #28
658b6dc  fix(models)        #26 评审修复                          #26
991a097  feat(models)        /v1/models 按 alias 过滤              #26
047d71d  fix(alias)         #25 评审修复                          #25
4f7ab93  feat(alias)         双向 model alias 重写                  #25
919dd47  fix(db)            #27 评审修复                          #27
0b3f519  feat(db)            bun:sqlite + WAL + 迁移               #27
7fc5aca  fix(config)        #24 评审修复                          #24
9b41141  feat(config)        config.json 存储 + 原子写 + 热重载    #24
b1133a3  fix(tests)         #13 评审修复                          #13
3ab9d01  feat(tests)         Responses 路径 + reasoning 保真度测试  #13
47c5486  fix(messages)      #10 评审修复                          #10
8804287  feat(messages)      Responses → Anthropic SSE 流翻译      #10
4f2c00a  fix(messages)      #8/#9 评审 round 2 修复               #8/#9
c7297e3  fix(messages)      #8/#9 评审修复                        #8/#9
c5fd7ab  feat(messages)      Anthropic → Responses + thinking 块   #8/#9
27b8a63  feat(responses)     vision header + previous_response_id   #11, #12
b191620  fix(responses)      SSE 净化 + null status 测试修正       #6
e1df9cc  feat(responses)     保留 encrypted_content + 剥 null status #6
68d6b94  fix(routing)        undefined model 守卫 + 正则修正        #5
394203a  fix(routing)        capabilities 短路 + 日期正则 + 守卫顺序 #5
d7c4b26  feat(routing)       model-to-endpoint 分类器               #5
ac754b0  fix(responses)      afterEach mock 清理 + 流测试 + 日志    #4
8341b89  fix(responses)      streamSSE 错误 handler + reasoning 检测 #4
b134dfa  fix(responses)      死导出 + 显式类型 + X-Initiator 测试    #4
65a4522  feat(responses)     上游 service 客户端 + 路由接线          #4
9409034  fix                 api-config.ts 加 vsCodeVersion fallback #46
6c92355  fix                 原生透传评审 round 2 修复               #38
dce9e6c  fix                 原生透传评审 round 1 修复               #38
cc11c1d  feat(native-anthropic)  透传服务 + 分流 + 类型修正           #38-#45
c83a9f8  feat                VS Code header 模拟精确化               #37, #47
d417a7c  fix(responses)      类型 + 错误处理 + 路由测试               #2, #7
a36fa09  feat(responses)     路由脚手架 + reasoning_effort 类型      #2, #7
977a30f  fix(responses)      Responses API 类型完整覆盖              #2
```

每个 `fix(...)` 都是对应 `feat(...)` 并行 crew 评审之后的修复回应。
两边在 git 历史里特意分开。

---

> 全文约 4400 行实现代码 + 27 个测试文件 + 525 个测试用例 + 16 个
> 主要的 crew 评审反馈被吸收。这是一份完整的"做了什么"清单 —— 配合
> 本仓库的 `CHANGELOG.md` 看用户视角摘要，配合每个 commit 的提交体
> 看更细的取舍。
