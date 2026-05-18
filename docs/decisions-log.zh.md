# 技术决策日志（中文）

> 项目里所有关键技术取舍 + 实测发现 + 当时为什么这么做的速记。
> 按时间逆序：最近的在最上面。

---

## D-012 · 2026-05-14 · Admin UI 重构 Phase 2–5（全部 6 页迁完）

承接 D-011 的骨架，Phase 2–5 把剩下 5 个旧 SSR 页面（Keys / Usage / Logs / Audit / Settings）替换成 React + Tremor，并新增 Phase 5 的 Models 页（旧仓库没有的）。结果是 SPA 完整接管 `/admin/*`，旧 SSR 整体 fallback 到 `/admin/legacy/*`（迁移期保留供回滚），新写的 SSR 入口全部删掉。

**新加的 JSON 端点（每个 ≤200 行，无业务逻辑、只组装服务层数据）**

| 路径                          | 方法       | 复用的服务层                                                                                |
| ----------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `/admin/api/keys`             | GET / POST | `listKeys`, `createKey`                                                                     |
| `/admin/api/keys/:id`         | GET        | `findKeyById`, `usageForKey × 3`, `recentCallsForKey`                                       |
| `/admin/api/keys/:id/revoke`  | POST       | `revokeKey`                                                                                 |
| `/admin/api/keys/:id/scope`   | POST       | `updateKeyScope`                                                                            |
| `/admin/api/keys/:id/debug`   | POST       | `setDebugEnabled`                                                                           |
| `/admin/api/usage`            | GET        | `requestsPerMinute`, `tokensPerHour`, `latencyPercentiles`(NEW), `errorBreakdownByStatus`(NEW), `topKeysByTokens`, `topModelsByRequests`, `errorRateByKey`, `distinctModels` |
| `/admin/api/usage/export.csv` | GET        | `streamEventsForCsv`                                                                        |
| `/admin/api/logs`             | GET        | 直 SQL（events 表 + key label JOIN）                                                        |
| `/admin/api/logs/traces`      | GET        | `fs.readdirSync(tracesDir())`                                                               |
| `/admin/api/models`           | GET        | `getConfig().models` + 24h events 聚合                                                      |
| `/admin/api/models/:alias`    | GET        | events 表（按 model 过滤）                                                                  |
| `/admin/api/audit`            | GET        | `auditFilePath`, `fs.readFileSync` + 小时桶聚合                                             |
| `/admin/api/settings`         | GET / PUT  | `getConfig`, `ConfigSchema.safeParse`, `saveConfig`, `audit('config.update')`               |

**新加的 queries.ts 函数**

- `latencyPercentiles(filter)` — 在 `p95LatencyPerHour` 基础上扩展，按小时给 p50/p95/p99 三个百分位（同样用 OFFSET 技巧，避免无 window 函数的 bun:sqlite）。
- `errorBreakdownByStatus(filter)` — `status >= 400` 按状态码分组，附带 sample_error（`MAX(error)`）。

**Settings 的 lock-out 防御沿用 D-004**：`features.auth` 不接受前端提交的值，永远从 `before` 拷贝。SSR 旧路由是同一规则，JSON API 这边也用同一份代码逻辑。

**legacy SSR 处理**

- `/admin/keys`、`/admin/usage`、`/admin/audit`、`/admin/settings` 的 historic mount 全部从 server.ts 删除 → SPA fallback 接管。
- `/admin/traces` 保留（SSE stream + trace 文件下载，SPA 直接消费），但其 index HTML 被 SPA fallback 遮蔽。
- `/admin/legacy/*` 仍可访问完整旧 SSR（含旧 Keys 详情、Usage uPlot 图、Audit 列表、Settings 表单）。计划：用户跑通新 SPA 后下个版本删掉整套 `src/admin/*/page.tsx` + `src/admin/layout.tsx` + `src/admin/assets/*.js`。

**测试迁移**

- `tests/admin-keys.test.ts`：HTML body 断言全部改成 JSON 契约；旧的 flash-cookie 一次性 plaintext flow 改成"POST 返回 plain 字段 → 后续 GET 不再含 plain"。
- `tests/admin-usage.test.ts`：去掉 uPlot `<canvas>` chart-id 断言，改 JSON 字段（`stats.total_requests`, `activity.rpm.length`）。`export.csv` 路径迁移到 `/admin/api/usage/export.csv`，CSV 内容 + 引号转义检查保留。
- `tests/admin-settings.test.ts`：form-urlencoded → JSON PUT，所有 SSRF guard + lock-out + 0600 文件权限 + audit 写入断言保留。
- `tests/audit.test.ts`：两条用 `Accept: application/json` 的旧路径改到 `/admin/api/audit`，behaviour 不变。

**测试结果**：544 pass / 1 fail（仅 1M-event 性能测试 18s 超时，与本次重构无关，存量问题）。

**坑**

1. `bun run --cwd ui build` 在 fresh subshell 跑会丢 PATH（找不到 bun 本体），但 `export PATH="$HOME/.bun/bin:$PATH" && bun run --cwd ui build` 工作。改了脚本路径但没动 PATH 处理 — 仍是开发者本地环境锅。
2. tsdown 在 Bun 1.3.14 上 crash（D-011 提过）依旧存在，prod 构建得跑 CI / Node 22+。SPA 半边（`bun run build:ui`）不受影响。

**遗留**

- 删除全部旧 SSR：`src/admin/{index,layout,login,session,keys,usage,audit,settings,traces}/...` 里的 `page.tsx` + `layout.tsx` + `style.css` + `assets/{keys,usage,traces,uplot}.js` 都还在。下个版本统一清。
- Logs 页的"Copy as cURL"现在只输出占位 stub —— 因为 events 表只存 telemetry 不存完整 request body。完整 cURL 需要从 trace 文件读取（仅 debug-on 的 key 才有），下个版本接进来。
- SSE Live tail 显示 `JSON.stringify(payload).slice(0,240)` 截断，没有按 request/response/metadata 分栏；够看出有事件但不够调试。

---

## D-011 · 2026-05-14 · Admin UI 重构骨架（Phase 1 of 5）

用户反馈："ui页面太差了，全部重构。参考litellm的布局设计。ui呈现的内容太少了。"

**技术决策**：从 hono/jsx SSR 切到 **Vite + React + Tremor SPA**，hono
退化为 JSON API。用户在多选确认中选择了 _"重写成 React + Tremor 单页"_
+ _"全部 6 页都重做"_，但出于风险控制，Phase 1 只做骨架 + Overview：

- 新增 `ui/` 工程（Vite + React 18 + Tremor 3 + Tailwind + react-router + TanStack Query），构建产物落 `dist/ui/`。
- 新增 `src/admin/api/` JSON 端点：`/me`、`/logout`、`/overview`。
- 改 `src/server.ts`：
  - `/admin/_app/*` 服务 vite 产物（`Cache-Control: immutable`）。
  - `/admin/api/*` 走 session + CSRF 中间件，但中间件检测路径前缀返回 **401 JSON** 而不是 302 重定向（SPA 友好）。
  - `/admin/legacy[/...]` 重新挂一份旧 SSR 路由，做迁移期 fallback。
  - 历史路径 `/admin/keys` / `/usage` / 等保留不动（页面级一个个迁）。
  - `/admin/*` catch-all → `dist/ui/index.html`（React Router）。
- 现有 SSR 路由全保留：迁移期间 SPA 用 `<PlaceholderPage>` 把未实现页跳到 `/admin/legacy/<page>`，让用户随时能切回旧版本继续干活。

**遗留**（与本次重构无关，但今天才发现）：

1. **tsdown 在 Bun 1.3.14 上 crash** —— `globalThis.process.getBuiltinModule is not a function`。`bun run build:server` 当前本机失败；半边 `build:ui` 正常。Pre-existing。
2. **eslint 在 MacPorts Node 18 上 crash** —— `Unexpected token 'with'`（import attributes）。Pre-existing；`git stash` 后回 HEAD 也一样。

**测试**：543/544 通过。唯一 fail 是 `usage queries: 1M-event perf > requestsPerMinute over 24h finishes in <1s` —— `git stash` 验证后确认是 pre-existing 的硬件敏感 perf 测试（pristine HEAD 也是 2-3s）。

**回归**：3 处 SSR-HTML 断言因为 `/admin` 现在返回 SPA shell 而不是
Overview SSR。改成断言 SPA shell（`/admin/_app/`、`Copilot API Admin`）
\+ 在 `/admin/legacy` 上断言 SSR Overview 仍然存在。Hono 路由怪癖：
`legacyApp.route("/", indexApp)` 让 `/admin/legacy` 命中、`/admin/legacy/`
不命中（被 catch-all 接走 SPA）—— 加一条 `sessionProtected.get("/legacy/", redirect)` 处理用户手打的尾斜杠。

**Phase 2-5 路线**：Keys → Usage → Logs → Models + Audit + Settings，
每 phase 替换一页对应路由，删除对应 SSR + 测试断言迁 JSON 端点契约测试。
详见 `docs/admin-ui-architecture.zh.md`。

---

## D-010 · 2026-05-14 · 全功能扫尾测试 + 5 个真 bug 修复

接 D-009 之后，把所有没碰过的 feature 挨个过一遍 live probe，找到并修了
5 个真 bug。一共跑了 ~40 个端到端测试场景。

### 修的 bug

#### Bug 1: `/admin/audit` 返回 401（D-010-A）
- 现象：登录 admin 后访问 /admin/audit → 401，其它 admin 页都正常。
- 根因：早期实现把 audit 端点当 API key 鉴权 endpoint 挂载，server.ts:117
  里有 `&& !path.startsWith("/admin/audit")` 的特例，把 audit 排除出
  session bypass 逻辑。结果浏览器只带 sid cookie 访问 → authMiddleware 401。
  导航栏却把它当 WebUI 页面链接。
- 修复：把 audit 改成 session-protected HTML 页（`page.tsx` + `route.tsx`），
  挂在 `sessionProtected.route("/audit", ...)`，删 server.ts 那行特例。
  保留 JSON 兼容：当 `Accept: application/json` 时返回原来的 JSON shape。
  page 实现日期/action 双过滤 + 分页。
- 测试：tests/audit.test.ts 改成 session-cookie 鉴权（loginAndGetCookie 帮手），
  21 pass。Live probe：HTML 列表 200、`?date=2026-05-13` 显示 5 条数据 + 页码
  "21–30 of 2300"、`Accept: json` 返回 JSON。

#### Bug 2: 多选 checkbox 提交只保留最后一个值（D-010-B，影响最大）
- 现象：admin 在 key 详情页同时勾选 `fast` + `opus` 保存 → DB 里只有 `["opus"]`。
- 根因 1：Hono 的 `parseBody()` 默认把同名字段折叠成最后一个值，要 `parseBody({ all: true })`
  才返回数组。
- 根因 2（更隐蔽）：session-middleware.ts 的 `extractCsrfBody()` 先调了 `parseBody()`
  （default = all:false）来抽 csrf_token，Hono 把解析结果**缓存**在 request 对象上。
  下游 handler 再调 `parseBody({ all: true })` 拿到的是缓存里的 flatten 版本。
- 修复：所有 admin handler 的 parseBody 统一用 `{ all: true }` —— session-middleware
  也改了。在 keys/route.tsx 注释里把这条坑写得很清楚。
- 验证：scope POST 后 DB 里 `["fast","opus"]`，两个模型的 API 调用都成功。

#### Bug 3: 范围编辑表单只显示 `*` checkbox，不显示已配置的 alias（D-010-C）
- 现象：连同 Bug 2 一起暴露 —— 即使后端能正确处理多选，前端也只渲染一个
  `*` checkbox，没把 config.models 里的 alias 列出来。
- 根因：detail.tsx 的 EditScopeForm 写死了只有 `*` 一个选项。
- 修复：新增 `availableAliases` prop，由 route 从 `Object.keys(config.models)` 传入。
  额外处理 orphan：key 已勾选但 config 里不存在的 alias，单独渲染并标注
  "not in config — untick to remove"。
- 验证：scope 区段现在渲染 `*`、`fast`、`opus` 三个 checkbox，已选中的 `fast`+`opus`
  显示 `checked`。

#### Bug 4: native /v1/messages 没设 X-Initiator 头（D-010-D）
- 现象：trace 里 `/v1/messages` upstream 请求没有 `x-initiator` 头，
  其它两个 endpoint（chat/completions、responses）都有。
- 根因：create-messages-native.ts 漏了，只有 chat-completions 和 responses
  写了这逻辑。
- 修复：加 `isAgentMessagesCall(payload)` 检测（assistant 历史 / tool_use / tool_result
  任一存在 → "agent"），把头加到 `headers["X-Initiator"]`。
- 验证：单轮 user 请求 → `X-Initiator: user`；多轮带 assistant 历史 → `X-Initiator: agent`。

#### Bug 5: `--no-auth` CLI 参数完全失效（D-010-E，**严重**）
- 现象：`bun run main.ts start --no-auth --host 0.0.0.0` 应该报错拒绝启动，
  实际却以 `[auth] mode=on` 启动。等于安全保护线被绕过 —— `--no-auth` 标志被
  默默无视了。
- 根因：citty 把 `--no-X` 解析为设置 `args.X = false`，而我们的代码读的是
  `args["no-auth"]`。这个 key 永远是 default 值（false），所以 `options.noAuth`
  永远是 false，resolveAuthMode 的不安全分支永远走不到。
- 修复：args 声明改成 `auth: { type: "boolean", default: true }`，
  CLI 用户继续打 `--no-auth`，代码读 `args.auth` 然后传 `noAuth: !args.auth`。
- 验证：
  - `--no-auth --host 0.0.0.0` → 报 REFUSING TO START，exit 2 ✅
  - `--no-auth --host 127.0.0.1` → 启动 mode=off (loopback) ✅
  - `--no-auth --host 0.0.0.0 --i-accept-account-suspension-risk` → 启动 mode=off (acknowledged risk) ✅
  - 不带 flag → mode=on ✅

### 测试覆盖（PASS = ✅，N/A = 上游账户没权限）

| 类别 | 项 | 结果 |
|---|---|---|
| Health | /healthz, /readyz | ✅ |
| Login | login GET → POST → session cookie | ✅ |
| Overview | /admin 状态卡 | ✅ |
| Keys CRUD | create / scope edit (multi-value) / rate_limit / revoke | ✅（修了 Bug 2/3） |
| Debug | enable (24h TTL) / 自动写 trace 不需要 X-Capi-Debug / renew / disable | ✅ |
| Audit | HTML 页 / 日期+action 过滤 / 分页 / JSON 兼容 | ✅（修了 Bug 1） |
| Usage | dashboard / CSV 下载（/admin/usage/export.csv） | ✅ |
| Traces | live tail SSE / JSONL 直接下载 | ✅ |
| Settings | POST → atomic write → hot-reload | ✅ |
| Logout | logout 后 keys 页 302 | ✅ |
| Auth gates | 客户端 key 跨 model 403 / 跨域 POST 403 / 缺 csrf 403 / 客户端 X-Capi-Debug 被剥 | ✅ |
| Rate limit | per-key rate_limit_override 触发 429 | ✅ |
| Tool calling | OpenAI tools / Anthropic tools | ✅ |
| Multi-turn | 工具调用 + tool_result 回放 → assistant 用 tool_result 文本回答 | ✅ |
| X-Initiator | user / agent 双语义 | ✅（修了 Bug 4） |
| Vision | Anthropic image base64 | ✅ |
| Vision | OpenAI image_url（1×1 PNG 被上游拒，路径正确） | ⚠️ 上游 |
| Models | /v1/models 返回 alias | ✅ |
| Embeddings | text-embedding-ada-002 | ✅ |
| Quota proxy | /usage / /token | ✅ |
| Trace integrity | authorization 脱敏 / X-Capi-Debug 不出现 / error body 抓到 | ✅ |
| CLI | admin recover / admin recover --force | ✅ |
| Auth bootstrap | --no-auth + non-loopback 拒绝 / loopback 允许 / accept-risk 允许 | ✅（修了 Bug 5） |
| Responses 成功路径 | /v1/responses gpt-5-codex 等 | ⚠️ 账户没 codex 权限 |
| 后台 sweeper | events / trace / session / debug-TTL 周期任务 | ⏸ 实现+单测都过，没等到周期触发 |

### Bug 5 余波

`--no-auth` 这个标志在 D-010 之前**根本没生效过**，意味着任何
"--no-auth + 0.0.0.0" 组合实际是以 auth=on 启动 —— 但 features.auth 也是 true
（默认 + config 里也是 true），所以是误打误撞被保护。如果有人用过
`--no-auth` + `features.auth=false`（config）+ 0.0.0.0 的组合，那才会
真正裸奔。当前 config 是 auth=true，所以历史使用是安全的。但这个 bug 必须修。

### 总结

- 5 个 bug 修完后所有 feature live OK
- 544 测试全过、lint clean
- bug 影响顺序 严重→轻微：Bug 5 (auth gate 失效) > Bug 2 (scope 多选丢失) > Bug 1 (audit 401) > Bug 3 (UI 只显 *) > Bug 4 (X-Initiator 缺失)
- 所有修改对历史 API 兼容（audit JSON shape 保留；session-middleware/keys-route 的 parseBody 改动对调用者透明）

---

## D-009 · 2026-05-13 · 实测 E2E 一遍跑通 + 修掉两个真bug

完成 #25/#26/#28/#29，跑了 9 条端到端真实探测，把发现的两个真 bug 修了。

### 测试覆盖

| 路由 | 模式 | 模型 | 结果 |
|---|---|---|---|
| `/v1/chat/completions` | 非流 | gpt-4o-mini | ✅ 200 |
| `/v1/chat/completions` | 流式 | gpt-4o-mini | ✅ 200，5 chunk |
| `/v1/messages` | 非流 NATIVE | claude-sonnet-4.5 | ✅ 200，thinking+signature |
| `/v1/messages` | 流式 NATIVE | claude-sonnet-4.5 | ✅ 200，6 events |
| `/v1/messages` | 非流 NATIVE | claude-opus-4.5 | ✅ 200，msg_vrtx_（Vertex 后端） |
| `/v1/messages` | 非流 TRANSLATE | gpt-4o-mini | ✅ 200，Anthropic 形 |
| `/v1/responses` | 非流 | gpt-5/gpt-5-codex/etc | ⛔ 上游 400（账户没开 Responses 权限），路由本身正确 |
| Settings POST + hot-reload | — | — | ✅ 写盘 + 自动 reload |
| 新 alias `opus` 通过 native /v1/messages | 非流 | opus → claude-opus-4.5 | ✅ 200 |

Trace 文件 `~/.local/share/copilot-api/traces/traces-YYYY-MM-DD.jsonl` 包含全部 4 段（client req/upstream req/upstream res/client res），头里 `authorization` 已脱敏。

### 修的 bug

#### Bug 1: `watchConfig()` 实现了但启动时根本没装（D-009-A）
- 现象：Settings 页存盘成功，`getConfig()` 返回的还是旧值，要重启进程才能生效。
- 根因：`src/lib/config-store.ts` 的 `initConfig()`/`watchConfig()` 写完了、单测也过了，但 `src/start.ts` 只调了 `loadConfig()` 一次性读取，没装 fs.watch。
- 修复：`start.ts` 改用 `initConfig(onChange)`，`onChange` 打一行日志显示 reload 后的关键字段；返回的 `dispose` 加进 `installShutdownHandlers([...])`。
- 验证：Settings POST → 日志立刻出现 `config.json reloaded (models=2, telemetry=true, debug=true, traces_days=7)`，新增 alias `opus` 立即可用。

#### Bug 2: trace 上游错误响应 body 被丢（D-009-B）
- 现象：上游 4xx 时 trace 里 `upstream_res.body` 是空的。
- 根因：`payload.stream || !response.ok ? undefined : await response.clone().text()` —— 把 `!response.ok` 也排除了。我当时担心 error 响应 body 会被 `HTTPError` 吞掉，所以双跳过。
- 修复：去掉 `!response.ok` 分支，只对 streaming 跳过（streaming body 是 SSE 流，被 `events()` 消费，不能 `clone().text()`）。错误 body 都很小（一般 < 500B），抓出来对 debug 极其有用。
- 三个 helper 同步改：`create-chat-completions.ts`、`create-messages-native.ts`、`create-responses.ts`。
- 验证：再跑一次 `/v1/responses` gpt-5-codex 探测，trace 里 `upstream_res.body = {"error":{"message":"The requested model is not supported.",...}}` 138 字节。

### 顺便确认

- **Settings UI** 防呆 OK：`features.auth` 真的不渲染，CSRF Sec-Fetch-Site 校验真的拦了我两次（一次没 Origin、一次字段名 `csrf` 而非 `csrf_token`），csrf_token cookie 双提交跑通。
- **per-key usage** 详情页正确显示 24h/7d/30d 三个窗口、最近 20 条调用，每条带 model/status/latency/tokens/error。
- **alias 解析链**：client `model: opus` → `resolveAlias()` → upstream `model: claude-opus-4.5` → `/v1/messages` → 真 Anthropic via Vertex AI（`msg_vrtx_` 前缀）。

### 后续（不阻塞）

- Responses API 测不了非错误路径（账户没权限），等以后能拿到 codex 模型再补
- `features.debug` 配置项目前是 dead UI flag —— 实际是 per-key `debug_enabled` + admin `X-Capi-Debug` 头开关，文档已说明（见 D-008 的 explore 结果），暂不动。

---

## D-008 · 2026-05-13 · Copilot 上游真实行为摸底

通过对生产 GitHub Copilot 上游的 8 条真实请求探测（issue #36 trace 中间件
配合 admin key 发出），确认了 Anthropic 协议在 Copilot 上的实际行为。

### 关键确认

1. **Copilot 上游 = 真 Anthropic via AWS Bedrock**。响应 `id` 全部以
   `msg_bdrk_` 开头。这意味着 Anthropic 协议**完全保真**。
2. **thinking + signature 双向闭环工作**：上游返回真签名；多轮回放被接受。
3. **`cache_control` 字段被接受**，缓存创建成功（usage 显示 `cache_creation_input_tokens`），
   但**跨请求命中疑似不工作**（同一份 prompt 第二次发还是 cache_creation）。
   推测是 Bedrock 跨区路由或 Copilot 中间层注入不一致字段所致。
4. **`anthropic-beta` headers 接受**：`interleaved-thinking-2025-05-14`、
   `fine-grained-tool-streaming-2025-05-14`、`claude-code-20250219,oauth-2025-04-20`
   全部 200。
5. **`thinking.budget_tokens` 必须 ≥ 1024**，上游强制。
6. **响应 `model` 字段被改写**：`claude-sonnet-4.5` → `claude-sonnet-4-5-20250929`。

### 决策影响

| 之前的猜测 | 改成 |
|---|---|
| 代理层 strip cache_control（怕上游 400） | **透传**。字段接受，缓存可能不命中但不会报错 |
| 强制 `thinking: {type: "disabled"}` | **透传**。signature 是真的 |
| 代理层伪造 signature 兜底 | **不需要**。上游就是真 Anthropic |

→ **native passthrough 路径几乎不用改**，只剩 `/v1/chat/completions` 路径
需要剥 Anthropic 独有字段（thinking / cache_control / top_k / metadata）
以防 OpenAI 路径上游收到这些无效字段。

详见：`docs/probe-results-2026-05-13.md`（测试脚本输出）

---

## D-007 · 2026-05-13 · LiteLLM 调研结论 — 端点分流不可避免

调研 LiteLLM 的 OpenAI ↔ Anthropic 翻译实现，发现：

- LiteLLM 自己**承认** thinking signature 翻译不可行（流式 chunk 直接
  raise，多轮场景丢顶层 thinking）。
- Issue #24985 / #26916 / #15601 / #22398 / #27512 全是翻译失败的痕迹。
- 它的策略是"承认不可逆 + 加 strip+retry 兜底"，不是"做对翻译"。

### 决策

- `/v1/messages` + claude → **native passthrough**（已实现）
- `/v1/chat/completions` + claude → **OpenAI 协议直通上游，剥 Anthropic
  独有字段**（待 issue #37 实施）
- 不尝试在 `/v1/chat/completions` 路径上保留 thinking signature
  （从 LiteLLM 多年踩坑看，这条路死定）

可抄的细节：
- cache_control 在 OpenAI 路径上**作为扩展字段接受但 strip**（非 Claude 模型）
- `anthropic-beta` header 用**合并而不是覆盖**（LiteLLM #22398 踩过）
- thinking_blocks / cache_*_tokens 挂 `provider_specific_fields` 扩展属性

---

## D-006 · 2026-05-13 · OpenClaw 客户端定位 — 必须原生

`openclaw/openclaw` 手写 fetch + 手写 SSE 解析（不走 SDK），对协议保真
度要求**比走 SDK 的客户端更高**。它的 transport 显式消费 `thinking_delta`
+ `signature_delta`，并把 signature 在多轮间闭环回写。

### 决策

- OpenClaw、Claude Code、Hermes 三家都归类为 **"必须 native passthrough"**
- 这就是 `/v1/messages` 端点的默认行为
- 翻译路径只对 LiteLLM / OpenRouter / Continue.dev 这类 OpenAI-shape
  聚合器开放（通过 `/v1/chat/completions` 进入）

---

## D-005 · 2026-05-13 · 按端点区分 Claude 模型

模式判定 **不**看 config 标志，**只**看请求进入的端点：

```
POST /v1/messages           + claude-*   → native passthrough
POST /v1/messages           + 其他       → translate Anthropic→Responses
POST /v1/chat/completions   + claude-*   → OpenAI 协议直通 + strip Anthropic 字段
POST /v1/chat/completions   + 其他       → OpenAI 直通
POST /v1/responses          + 任意       → Responses 直通
```

### 理由

- 客户端选 `/v1/messages` = 它能处理 Anthropic shape → 给它原生
- 客户端选 `/v1/chat/completions` = 它只懂 OpenAI shape → 给它翻译（必然有损）
- 不需要 config 字段，operator 不用思考
- 极端情况（同一客户端两边都用）可以靠**端点**自己分流，不需要别名

### 已实现状态

- `/v1/messages` + claude → native：✅ 实现（issue #38–#46）
- `/v1/chat/completions` + claude → 当前是"上游直通 OpenAI"，**没显式剥 Anthropic 字段**
  → issue #37 补这一步

---

## D-004 · 2026-05-13 · 没有 Settings UI 是已知缺口

`/admin/settings` 在 nav 里有链接但路由没挂。**决定补**（task #24）。

### 决定不做的事

- ❌ 不在 UI 暴露 `features.auth` 开关（自我锁出风险，CLI/文件改）
- ❌ 不做 model alias 的图形化拖拽编辑器（纯表单够用）
- ❌ 不做"立即清理"按钮（force purge events / traces）—— 太危险

---

## D-003 · 2026-05-13 · Bun 的 TransformStream.cancel 不触发（关键陷阱）

Bun 当前版本（1.3.13）的 `TransformStream.cancel` 回调在**下游 cancel
时不触发**。这意味着用 `pipeThrough(TransformStream(...))` 包装 SSE
流时，客户端中途断开会**静默丢失 telemetry/trace 记录**。

### 决定

所有需要在流关闭后做埋点的地方都改用**手写 ReadableStream**：

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

`recorded` 标志保证 fire 在 EOF / cancel / pull-error 三种竞态下只跑一次。

应用位置：`src/middleware/telemetry.ts`、`src/middleware/trace.ts`、
`src/admin/traces/route.tsx`（download）、`src/admin/usage/route.tsx`（CSV export）。

---

## D-002 · 2026-05-13 · `--no-auth` 不再静默允许

v0.7 默认 `--no-auth`，无脑暴露端口。v0.8 改成：

- `--no-auth` + 环回 host：允许，黄色警告
- `--no-auth` + 非环回 host：**拒绝启动**，必须显式 `--i-accept-account-suspension-risk`
- 默认 host 从 `0.0.0.0` 改成 `127.0.0.1`
- Docker entrypoint 自动注入 `--host 0.0.0.0` 让 `docker run -p` 仍然工作

理由：暴露的 Copilot 端口任何人都能用，会**烧光用户的 Copilot 配额**，
甚至触发 GitHub 异常检测。这一变更见 issue #33。

---

## D-001 · 2026-05-13 · `features.auth` 默认值翻成 true

schema 默认值从 `false` 改成 `true`，配合 D-002 的安全门。

副作用：所有 v0.7 测试里 mock 配置时如果省略 `features.auth` 字段，会
默认成 auth-on，导致 `/v1/models` 请求 401。修复方式：在所有这类
test fixture 里显式设 `features.auth: false`（适用于不关心认证的测试）
或显式 `auth: true` 并提供有效 sk-cap- key（适用于认证测试）。

`setRuntimeAuthOverride(false)` 仅在 CLI 显式传 `--no-auth` 时调用，
配置文件 `features.auth` 是权威，仅 CLI 覆盖。

---

> **后续条目继续按时间逆序追加在最上面。**
