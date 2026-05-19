# HANDOFF — copilot-api-pro 项目文档

> 接手指南。新 agent 看这一份 + `docs/implementation-overview.zh.md` + `docs/decisions-log.zh.md` 顶上几条就够了。
>
> 这不是 changelog。是**项目当前状态的完整快照**。

---

## 1. 项目是什么

`copilot-api-pro`（fork 自 `ericc-ch/copilot-api`）——把 GitHub Copilot 包装成 OpenAI / Anthropic 兼容的 HTTP API，让 Claude Code、Cline、Continue、Cursor 之类的客户端可以走 Copilot 配额。

它本质是一个**反向代理 + 协议翻译层 + 多租户管理面**：

```
                    ┌─────────────────────────────────────────┐
                    │ copilot-api-pro :4141                   │
   Claude Code      │                                          │
   Cline            │  ┌─────────────┐    ┌──────────────┐    │      GitHub Copilot
   Continue   ────→ │  │ auth + telemetry│ │ alias / route │ ──┼─→  api.*.githubcopilot.com
   Cursor           │  │ + trace        │ │ + translation │    │
   curl             │  └─────────────┘    └──────────────┘    │
                    │                                          │
                    │  + admin SPA at /admin (React + Tremor)  │
                    │  + SQLite for keys/events/sessions/audit │
                    │  + JSONL traces with redaction           │
                    └─────────────────────────────────────────┘
```

### 上层 API 暴露

| 路径 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | 主流 |
| `POST /v1/responses` | OpenAI Responses API | codex, gpt-5.x，单独走 |
| `POST /v1/messages` | Anthropic Messages | Claude Code 走这个 |
| `POST /v1/messages/count_tokens` | Anthropic | Claude Code 用来预估上下文 |
| `POST /v1/embeddings` | OpenAI | text-embedding-* |
| `GET /v1/models` | OpenAI | 列 alias |
| `GET /admin/*` | 自家 | SPA + JSON API + login |

### 下层 Copilot 端点

Copilot 自己同时支持三种格式：
- `/chat/completions`（OpenAI 兼容）
- `/responses`（OpenAI Responses，强制走这个的有 codex / o-pro / gpt-5.x）
- `/v1/messages`（Anthropic 兼容，Claude 系列走这个保留 thinking 块）

哪个 model 走哪条由 `src/lib/model-routing.ts:getModelMode()` 决定，基于 Copilot catalog 里的 `supported_endpoints` 字段（**不**信 `capabilities.type`，那个字段对 codex 撒谎）。

---

## 2. 怎么跑

### 开发

```bash
# 一次性
~/.bun/bin/bun install
~/.bun/bin/bun install --cwd ui    # SPA 依赖

# 启动
ADMIN_INSECURE_HTTP=true \
  ~/.bun/bin/bun run ./src/main.ts start --host 0.0.0.0 --port 4141 -v
```

- 第一次启动会 OAuth 登录 GitHub，token 写到 `~/.local/share/copilot-api-pro/github_token`
- `bun run src/main.ts` 是源码模式：改 handler / lib 大部分文件**不用重启**，下次请求就生效
- 重启**必要**的情况：schema 改了 / 加新 migration / middleware 挂载点变了 / import 新模块
- UI 改了要 `cd ui && ~/.bun/bin/bun run build`，输出到 `dist/ui/`，server 静态服务

### 用 bunx 一行装（生产）

```bash
bunx github:HXYerror/copilot-api-pro start --host 0.0.0.0 --port 4141 -v
```

仓库已经 commit 了 `dist/`（`prepack` build 一次，跟着 git 走），所以 bunx 无需 build。

### Build / test / lint

```bash
~/.bun/bin/bun test            # ~9s, 当前 580+/581 passing（1 flake）
~/.bun/bin/bun run lint        # ESLint
~/.bun/bin/bun run typecheck   # tsc（UI JSX 报错是预期，root tsconfig 不含 ui）
~/.bun/bin/bun run build       # build:server (tsdown) + build:ui (vite)
```

### Python 探测脚本

```bash
COPILOT_API_KEY=sk-cap-... python3 scripts/test_models.py \
  --base http://127.0.0.1:4141 \
  --with-thinking      # 给 Claude 模型再发 4 个 thinking level
```

打印每个 alias 的可达性 + 实际触发的路由 + token 使用。修完 routing / token 抓取后总要跑一遍。

---

## 3. 数据持久化

`~/.local/share/copilot-api-pro/`：

| 文件 | 内容 |
| --- | --- |
| `github_token` | OAuth refresh token，文件权限 0600 |
| `copilot-api.db` | SQLite，所有元数据（keys / sessions / events / audit） |
| `config.json` | model alias 表 + retention + features 开关，hot-reload |
| `traces/traces-YYYY-MM-DD.jsonl` | 全量 request/response 抓取，仅 debug-enabled key 或全局 debug 开时写 |
| `audit-YYYY-MM-DD.jsonl` | admin 操作审计日志 |

`src/lib/migrations/*.sql` 自动跑，目前 8 条：

```
001_init.sql                — keys（plain text, 早期）
002_keys.sql                — 改成 hash, 加 allowed_models / rate_limit_override
003_sessions.sql            — admin session 表
004_debug_expires.sql       — per-key debug TTL 列
005_events.sql              — telemetry events 表
006_thinking_level.sql      — 提取 thinking config 存进 events
007_cache_tokens.sql        — copilot_usage 里的 cache_read / cache_write
008_reasoning_tokens.sql    — OpenAI /responses 的 reasoning_tokens
```

---

## 4. 代码地图

### `src/`

```
main.ts              — citty CLI 入口（start / auth / debug / check-usage 子命令）
start.ts             — 启动逻辑：load config, init DB, run migrations, bind port
server.ts            — Hono server 装配。所有 middleware 在这里串
lib/
  paths.ts           — APP_DIR, tracesDir(), ensurePaths()
  config-store.ts    — ConfigSchema (zod), getConfig/saveConfig, watchConfig
  db.ts              — bun:sqlite，WAL，migration runner
  state.ts           — process-lifetime state (copilotToken, models cache, ...)
  alias.ts           — resolveAlias / resolveUpstream
  default-model.ts   — D-013 默认模型拦截
  model-routing.ts   — chat / responses 路由分类
  copilot-usage.ts   — token 计数权威 source (copilot_usage.token_details)
  tokenizer.ts       — gpt-tokenizer 包装
  api-config.ts      — copilotHeaders（agent UA 等）
  rate-limit.ts      — per-key 速率限制
  approval.ts        — manual-approve 模式
  utils.ts
middleware/
  auth.ts            — Bearer / NO_AUTH_SENTINEL，scope 检查
  telemetry.ts       — 写 events 表
  trace.ts           — 写 JSONL trace + 暴露 trace_capture_upstream callback
routes/
  chat-completions/handler.ts
  messages/handler.ts          ← Claude 路径
  messages/count-tokens-handler.ts
  messages/stream-translation.ts
  messages/non-stream-translation.ts
  messages/anthropic-to-responses.ts ← Anthropic → Responses 适配器
  messages/responses-to-anthropic.ts ← Responses → Anthropic 适配器
  responses/handler.ts
  embeddings/route.ts
  models/route.ts
  token/route.ts
  usage/route.ts
services/
  keys.ts             — keys 表 CRUD + isDebugActive
  events.ts           — recordEvent / countEvents / purgeEventsOlderThan
  audit.ts            — append-only JSONL audit
  retention.ts        — 按 days 删 events / audit / traces
  debug-ttl-sweeper.ts — 周期性关掉过期的 debug
  trace-writer.ts     — JSONL writer + 红黑名单 redact
  trace-redact.ts     — bearer/cookie/api-key/jwt 8 个正则 + assertion
  trace-broadcaster.ts — SSE live tail 给 admin SPA
  copilot/
    token.ts           — copilot token 刷新
    get-models.ts      — Copilot catalog
    create-chat-completions.ts
    create-responses.ts
    create-messages-native.ts  ← Anthropic 端点直连，含 anthropic-beta header
    native-models.ts   — isNativeAnthropicModel
    create-embeddings.ts
  github/             — OAuth + device flow
  version-cache.ts    — VSCode / Copilot Chat version probe
  get-vscode-version.ts
  get-copilot-chat-version.ts
admin/
  index.ts           — / catch-all → dist/ui/index.html
  login.tsx          — POST /admin/login（legacy SSR HTML form 仍存）
  session.ts         — sessions 表 CRUD + sliding TTL
  csrf.ts            — HMAC double-submit
  session-middleware.ts — sessionMiddleware + requireAdminSession
  api/
    route.ts         — /admin/api 子树挂载
    me.ts            — GET /admin/api/me
    login.ts         — POST /admin/api/login
    logout.ts
    overview.ts      — KPI 卡 + 24h 时序
    keys.ts          — GET / POST / PATCH 各种
    logs.ts          — events 表 query + /admin/api/logs/:id/trace
    usage.ts         — Usage page 数据复合
    audit.ts
    settings.ts      — PUT 走 ConfigSchema 校验
    models.ts        — 列 alias + 24h usage join
  usage/queries.ts   — SQL 查询层
  traces/route.ts    — SSE live tail + 文件下载
```

### `ui/`（React + Tremor + Vite SPA）

```
src/
  main.tsx              — React 入口
  App.tsx               — Router 装配
  layout/
    AppShell.tsx        — 左侧栏 + 顶部条
    Sidebar.tsx
    NavGroup.tsx
  api/
    client.ts           — fetch 包装：CSRF 自动附 + 401 重定向
    types.ts            — 跟 server 共用的 JSON shape
  hooks/useApi.ts       — TanStack Query 包装
  pages/
    Overview.tsx
    Keys/{List, Detail, NewDrawer, EditScopeDrawer}.tsx
    Usage.tsx
    Logs.tsx            — 主表 + Detail Drawer + Live tail SSE
    Models.tsx
    Audit.tsx
    Settings.tsx
  components/
    TraceStructured.tsx — 把 trace body 渲染成结构化卡片
    sse-aggregator.ts   — Anthropic / OpenAI SSE → 合成 JSON
```

### `scripts/`

```
test_models.py        — 探每个 alias，Claude 加 --with-thinking 测 4 个 level
```

### `dist/`（committed）

`prepack` 触发 build，仓库里直接带 `dist/main.js`（带 bun shebang）+ `dist/ui/`，给 bunx 一行装用。

---

## 5. 关键功能模块（按重要性）

### 5.1 路由分类（chat vs responses）

文件：`src/lib/model-routing.ts`

Copilot 的 model 不是每个都支持每个端点。`gpt-5-codex` 必须走 `/responses`，`gpt-4o` 可以走 `/chat/completions`。识别靠的是 Copilot catalog 里的 `supported_endpoints` 字段（**不**信 `capabilities.type='chat'`，那个对 codex 撒谎）。

```ts
const supported = state.models?.data.find(m => m.id === id)?.supported_endpoints
if (supported?.includes("/responses") && !supported?.includes("/chat/completions"))
  return "responses"
```

### 5.2 Alias 双向重写

文件：`src/lib/alias.ts`

`config.models` 是 alias → upstream 映射。

```json
{
  "models": {
    "fast":             { "upstream": "gpt-4o-mini", "enabled": true, "allowed_keys": ["*"] },
    "claude-opus-4-7":  { "upstream": "claude-opus-4.7-1m-internal", ... }
  }
}
```

- **Ingress** (client → upstream): `resolveAlias("fast")` → `"gpt-4o-mini"`
- **Egress** (response → client): client 看到的 model 字段被重写回 `"fast"`

每次响应都改写（包括 SSE 每个 chunk），保证 client 永远看不到 Copilot 真实 model id。

`/v1/models` 也按 alias 表过滤，只列 enabled 的 alias。

### 5.3 默认模型拦截（D-013）

文件：`src/lib/default-model.ts`

`config.default_model_alias` 设上之后，没注册的 alias 自动 rewrite 到默认。设没设 + 找没找到 / 找到了的所有分支详见 D-013。

### 5.4 Auth + scope

文件：`src/middleware/auth.ts`

- `Authorization: Bearer sk-cap-...`，跟 SHA256(hash) 对 `keys` 表
- `key.allowed_models: ["*"]` 或 `["fast", "claude-opus-4-7"]`
- 当请求 `model` 不在 allowed 里：HTTP 403 `model_not_allowed`
- scope check 用 **effective alias**（fallback 之后），所以不能用没注册的 alias 绕开
- `--no-auth` 在 v0.8 之后有安全闸：非 loopback host 必须显式 `--i-accept-account-suspension-risk`

### 5.5 Admin Plane

文件：`src/admin/`

- **Session**: `sid` cookie + DB-backed sessions 表（不是 in-memory）+ sliding TTL
- **CSRF**: HMAC double-submit（cookie + header 同值），fallback 到 DB 里 stored csrf_token（跨 server 重启可用）
- **Sec-Fetch-Site**: 验证 `same-origin`，`ADMIN_INSECURE_HTTP=true` 时跳过（LAN HTTP 时）
- **CSP**: `default-src 'self'; style-src 'self' 'unsafe-inline'`（够用，prod 不需要 unsafe-eval）

API 全在 `/admin/api/*`，SPA 在 `/admin/`，登录页 `/admin/login`。

### 5.6 Telemetry + Trace

**Telemetry** (`src/middleware/telemetry.ts`)：每个 API 请求一行 `events` 表。永远写，无关 debug。字段：
- ts / key_id / model（client alias）/ upstream_model / status / latency_ms / error tag
- prompt_tokens / completion_tokens / cache_read_tokens / cache_creation_tokens / reasoning_tokens
- thinking_level（output_config.effort 等原始值）

来源：handler 通过 `c.set("usage", readCopilotUsage(response))` stash，源全部来自 `copilot_usage.token_details`（权威）。

**Trace** (`src/middleware/trace.ts`)：完整 req/res body 抓取，**只有 debug 开时**写。落到 JSONL：

```
traces/traces-YYYY-MM-DD.jsonl
```

每条一行，redact 过 Authorization / Cookie / api_key / 4 类 JWT pattern。

激活方式三选一：
1. `config.features.debug = true`（全局，影响所有 key）
2. 单个 key debug_enabled + debug_expires_at（admin UI 翻牌，24h TTL）
3. admin tier + `X-Capi-Debug: 1` header（一次性，header 在 auth 层被 strip 不会泄漏给 upstream）

### 5.7 Thinking / Reasoning（最复杂的一块）

详见 `docs/decisions-log.zh.md` D-014。要点：

| 路由 | 控制 thinking 的字段 | thinking 内容 | thinking token 数 |
| --- | --- | --- | --- |
| `/v1/messages` (Claude) | `thinking:{type:adaptive}` + `output_config:{effort: low\|medium\|high\|xhigh}` + beta `effort-2025-11-24` | **加密**（只暴露 signature blob，几百字节～几 KB） | **不暴露**（混在 output_tokens） |
| `/chat/completions` (Claude) | `reasoning_effort: low\|medium\|high\|xhigh` | 不暴露 `reasoning_content` | 不暴露 |
| `/v1/responses` (gpt-5) | `reasoning:{effort:...}` | reasoning item 加密 | **`usage.output_tokens_details.reasoning_tokens`** ✓ |

**proxy 必须做**：

1. 把客户端的 `anthropic-beta` header **透传**给 Copilot，否则 `effort-2025-11-24` 这个 beta gate 关着，Copilot 把 `output_config.effort` 当 noop（这是踩过的坑，写在 D-014）
2. 旧 `thinking:{type:enabled, budget_tokens:N}` 协议要翻译成 `{adaptive} + output_config:{effort}`（按 budget 大小映射 low/medium/high/xhigh）

明文 thinking 永远拿不到。Copilot 服务端硬性策略。

### 5.8 SSE 聚合（UI 端）

文件：`ui/src/components/sse-aggregator.ts`

Trace 里 response body 是 Anthropic SSE 流（`event: message_start\n data: {...}\n\n` 序列），UI 结构化视图工作在 JSON 对象上。Aggregator 重建出最终 message：

- `text` 块：拼接所有 `text_delta`
- `thinking` 块：拼接 `thinking_delta` + 累加 `signature_delta`
- `tool_use` 块：拼接 `input_json_delta`，stop 时 JSON.parse
- `message_delta` 合并 stop_reason + usage

识别 Anthropic（有 `message_start` event）+ OpenAI chat completion 两种 stream 格式。失败返回 null，UI fallback raw view。

测试 `tests/sse-aggregator.test.ts` 17 个用例覆盖各分支。

---

## 6. 测试

```bash
~/.bun/bin/bun test
```

31 个 test 文件，~580 用例。当前**唯一已知 fail** 是 `tests/config-store.test.ts: watchConfig() > fires callback on file change`，pre-existing flake（fs.watch 时序）。

### 主要测试覆盖

| 文件 | 覆盖 |
| --- | --- |
| `tests/auth.test.ts` | Bearer 验证、no-auth 闸、scope check |
| `tests/keys.test.ts` | keys 表 CRUD、hash、debug TTL |
| `tests/admin-*.test.ts` | admin JSON API（keys / settings / usage / audit） |
| `tests/config-store.test.ts` | zod schema、atomic write、watchConfig、setRuntimeAuthOverride |
| `tests/model-routing.test.ts` | mode classifier + `/v1/chat/completions` 拦 responses-only model |
| `tests/telemetry.test.ts` | events 表写入、retention sweep、usage_unknown 判定 |
| `tests/trace.test.ts` | 抓取激活条件 + redact + JSONL append |
| `tests/trace-redaction-fuzz.test.ts` | 8 个 redact 规则的 corner case |
| `tests/responses-route.test.ts` | /v1/responses 端到端 |
| `tests/native-passthrough.test.ts` | /v1/messages native 路径 + `buildUpstreamPayload` budget→effort 映射 |
| `tests/anthropic-{to-responses,response,request}.test.ts` | 双向翻译 |
| `tests/responses-{stream-translation,to-anthropic,translation}.test.ts` | SSE 翻译 |
| `tests/usage-queries.test.ts` | dashboard SQL |
| `tests/default-model.test.ts` | D-013 5 个分支 |
| `tests/sse-aggregator.test.ts` | UI SSE 聚合 17 个用例 |

---

## 7. 容易踩的坑

### 跑 Copilot

- **必须有 GitHub Copilot 订阅**（individual / business / enterprise）
- 第一次 `start` 没 token 会走 OAuth device flow，浏览器输 code
- Copilot 端点会因 GitHub 账号类型不同走不同的 endpoint（个人 `api.individual.githubcopilot.com`，企业 `api.enterprise.githubcopilot.com`）。我们从 `/copilot_internal/v2/token` 的 response 里读 endpoints
- **不要把 `--no-auth` 暴露公网**。GitHub 异常检测会封号，看 README 顶上的 warning

### 服务器

- 改 schema (`ConfigSchema` / `EventRow`) / migration / middleware 挂载 / import → 重启
- 改 handler / lib / route → bun 模式下不用重启
- 改 UI → `cd ui && bun run build`，浏览器 Cmd-Shift-R

### Trace

- trace 文件是 **local date** 命名（`traces-YYYY-MM-DD.jsonl`），但每行 `ts` 是 UTC ms。logs API `/admin/api/logs/:id/trace` 用 local date 算路径，匹配行用 `key_id + ±2s` 窗口
- retention 默认 7 天，`config.retention.traces_days = 0` 关闭持久化（但 SSE live tail 仍然 broadcast）

### Thinking

- adaptive 模式简单问题不思考是**正常**的（不是 bug）
- 明文 thinking 永远拿不到（Copilot 加密）
- thinking_tokens 只在 `/responses` 路由有
- `anthropic-beta` header 必须 forward client 的全套 flags

### CSRF

- secret 每次启动 `randomBytes(32)` 是故意的（限制重放窗口）
- DB 里 `sessions.csrf_token` 是 fallback，保证跨重启不踢人
- LAN HTTP 时 `ADMIN_INSECURE_HTTP=true`：drop Secure flag from cookies、跳过 Sec-Fetch-Site 检查

### Lint

- 我们的 ESLint 配置很严（`@echristian/eslint-config`），新文件保持 0 warning
- 旧文件的 `max-lines-per-function` / `complexity` 是 pre-existing baseline，不要为了 fix 这些去重构（容易引入 bug）
- `bun run lint --fix` 会自动修 prettier

---

## 8. 各路文档索引

| 文档 | 作用 |
| --- | --- |
| `README.md` | 用户视角，怎么装、怎么用 |
| `HANDOFF.md`（本文件） | agent / dev 接手地图 |
| `docs/implementation-overview.zh.md` | 详细的功能模块逐个走（1200 行） |
| `docs/admin-plane.zh.md` | admin 这一块（auth / keys / sessions / CSRF / audit）的 1000 行手册 |
| `docs/admin-ui.zh.md` | SPA 的路由、JSON API、CSRF 流 |
| `docs/decisions-log.zh.md` | 时间倒序的决策记录。重要：D-013 默认模型、D-014 thinking 调研、D-001/D-002 auth 闸的演化 |
| `docs/prd/native-anthropic-passthrough.md` | Native Anthropic 端点 PRD |
| `docs/prd/vscode-header-simulation.md` | UA / editor-version 模拟方案 |

---

## 9. 接手清单（5 分钟摸清状况）

1. 读 `docs/decisions-log.zh.md` 顶上 5 条（D-014 / D-013 / D-012 / D-011 / D-010）
2. `~/.bun/bin/bun test` 跑一遍，记下 baseline pass 数
3. 启服务 + 浏览器开 `/admin/` 看 6 个页面
4. 跑 `python3 scripts/test_models.py --with-thinking` 看每个 alias 通不通
5. 翻 `git log --oneline | head -50` 看最近的 commit 主题

完了。

---

## 10. 一句话总结

**这不是个"包装层"**。它是一个完整的 Copilot 反向代理 + 多租户 admin plane：

- **协议翻译**：Anthropic ↔ OpenAI ↔ Responses 三向
- **流量管理**：alias、auth、scope、rate limit、default fallback
- **可观测**：telemetry events、JSONL traces、SSE live tail、redaction
- **多租户**：keys 表、scope 白名单、per-key rate / debug
- **运维 UI**：完整的 React SPA，6 个页面

下一个 agent 接手时心理预期：**这是个产品级 codebase，不是 hack**。改之前先翻 decisions-log，看有没有这事的历史背景。
