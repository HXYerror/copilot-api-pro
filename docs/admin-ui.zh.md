# Admin UI 架构（React + Tremor SPA）

## 背景

原 `/admin` 由 hono/jsx 服务端渲染，单层 layout + 单一 CSS，信息密度低、视觉乏力。从 v0.7+ 起改造为 **React SPA**，hono 退化为 JSON API。本文档记录 Phase 1 落地的架构，后续 Phase 2-5 在此基础上逐页迁移。

## 顶层布局

```
请求路径                    服务方
────────────────────────────────────────────────
GET  /admin/_app/*          Vite 构建产物 (dist/ui/assets/...)
GET  /admin/api/*           JSON 端点（session 认证）
POST /admin/api/*           同上 + CSRF
GET  /admin/login           SSR HTML 登录页（保留）
POST /admin/login           form 处理 → 302 /admin
GET  /admin/legacy[/...]    旧 SSR 页面（迁移期保留）
GET  /admin/keys, /usage,   旧 SSR 页面（历史路径，迁移完成后会删）
     /audit, /traces,
     /settings
GET  /admin/[anything else] dist/ui/index.html（SPA 路由回退）
```

## 工程结构

```
copilot-api/
├── src/
│   ├── server.ts                Hono 路由表（含 SPA 静态 + 回退 + legacy 挂载）
│   ├── admin/
│   │   ├── api/                 ← 新增：JSON 端点
│   │   │   ├── route.ts         汇总 mount
│   │   │   ├── me.ts            GET /admin/api/me
│   │   │   ├── logout.ts        POST /admin/api/logout
│   │   │   └── overview.ts      GET /admin/api/overview
│   │   ├── session-middleware.ts  /admin/api/* 分支：返回 401 JSON 代替 302
│   │   └── ... (旧 SSR 页面保留)
│   └── lib/, services/, ...     (未变)
├── ui/                          ← 新增：Vite + React 工程
│   ├── package.json
│   ├── vite.config.ts           base="/admin/_app/", outDir="../dist/ui"
│   ├── tailwind.config.js       Tremor 配色 token
│   ├── postcss.config.js
│   ├── index.html
│   └── src/
│       ├── main.tsx             React 入口
│       ├── App.tsx              路由表
│       ├── index.css            Tailwind base/components/utilities
│       ├── api/
│       │   ├── client.ts        fetch + CSRF + 401 重定向
│       │   └── types.ts         JSON 响应类型
│       ├── layout/
│       │   ├── AppShell.tsx     侧栏 + 顶栏 + Outlet
│       │   ├── Sidebar.tsx      LiteLLM 风格分组导航
│       │   └── TopBar.tsx       页面标题 + me 信息 + 登出
│       └── pages/
│           ├── Overview.tsx     KPI×6 + AreaChart + DonutChart + BarList + Recent
│           └── Placeholder.tsx  未迁移页面跳 legacy
└── dist/
    ├── main.js                  tsdown 产物（服务器）
    └── ui/                      vite 产物（SPA 静态资源）
```

## 数据流

```
Browser
  └── GET /admin/  ─────────────► hono → fs.readFileSync(dist/ui/index.html)
       │
       └── HTML 加载 → <script src="/admin/_app/assets/index-*.js">
            │
            └── React app boot
                 ├── BrowserRouter basename="/admin"
                 ├── QueryClient (TanStack Query)
                 └── 首屏: <Overview />
                      └── useQuery({ queryFn: api<OverviewResponse>("/overview") })
                           └── fetch("/admin/api/overview", { credentials: same-origin })
                                ├── 200 → render
                                └── 401 → window.location = "/admin/login"
```

## 鉴权 / CSRF

- **登录**：HTML 表单 POST `/admin/login` 不变。返回两个 cookie：`sid`（HttpOnly）+ `csrf`（非 HttpOnly，前端 JS 可读）。
- **SPA 调用 API**：每个非 GET 请求由 `ui/src/api/client.ts` 自动注入 `X-CSRF-Token: <从 csrf cookie 读出>` + `Sec-Fetch-Site: same-origin`。
- **未鉴权访问 /admin/api/***：`sessionMiddleware` 检测路径前缀，返回 `401 { error: "..." }` 而非原本的 302 重定向。SPA 端 `api()` 看到 401 自动 `window.location = "/admin/login"`。
- **登出**：SPA 调 `POST /admin/api/logout` 返回 JSON `{ ok: true }`；旧 SSR 表单仍用 `POST /admin/session/logout` 走 303 重定向（两套并存）。

## 构建

```
bun run build              # 完整构建：先 server，再 SPA
bun run build:server       # tsdown → dist/main.js
bun run build:ui           # vite build → dist/ui/

bun run dev                # 服务器 watch 模式
bun run dev:ui             # vite build --watch（增量打包到 dist/ui/）
```

**两个 watcher 共用一个端口** ─ 不需要 dev proxy。SPA 修改后 vite 增量重新生成 `dist/ui/assets/index-*.js`，浏览器刷新即可（短期未上 HMR；Tremor 重新热替换的代价较高，需要时再加 vite dev server + 反向代理）。

## SPA 路由表

| Path                | 当前组件               | Phase |
| ------------------- | ---------------------- | ----- |
| `/admin/`           | `<Overview />`         | 1 ✅  |
| `/admin/keys`       | `<KeysList />`         | 2 ✅  |
| `/admin/keys/:id`   | `<KeysDetail />`       | 2 ✅  |
| `/admin/usage`      | `<Usage />`            | 3 ✅  |
| `/admin/logs`       | `<Logs />`             | 4 ✅  |
| `/admin/audit`      | `<Audit />`            | 5 ✅  |
| `/admin/models`     | `<Models />`           | 5 ✅  |
| `/admin/settings`   | `<Settings />`         | 5 ✅  |

所有 6 页（含 Models 新页）已迁移完毕。`<PlaceholderPage />` 仅在 404 时作为兜底。

## Overview 页内容

- 顶部状态条：auth_mode_label · bind_address · VS Code 版本 · Copilot Chat 版本
- 6 KPI 卡：Requests 24h · Prompt tokens 24h · Completion tokens 24h · Error rate 24h · p95 latency 24h · Active keys + Debug count
- **AreaChart**：24h 请求数堆叠（按模型 top 6 + other）
- **DonutChart**：24h 模型请求占比（top 5 + other）
- **BarList**：24h tokens 最高的 5 个 key
- **List**：最近 10 次调用（点跳 Logs）

来源：单个 `GET /admin/api/overview` 端点；服务端复用 `queries.ts` 的 `requestsPerMinute / topKeysByTokens / topModelsByRequests / p95LatencyPerHour` + 直接 SQL。

## 服务端 API 端点

Phase 1：

| 方法 | 路径                  | 说明                            |
| ---- | --------------------- | ------------------------------- |
| GET  | `/admin/api/me`       | 当前会话 + auth mode + bind     |
| POST | `/admin/api/logout`   | 删除 session + 清 cookie        |
| GET  | `/admin/api/overview` | 仪表盘单次拉取的全部数据        |

Phase 2 — Keys：

| 方法 | 路径                              | 说明                                |
| ---- | --------------------------------- | ----------------------------------- |
| GET  | `/admin/api/keys`                 | 分页列表 + 概要                     |
| POST | `/admin/api/keys`                 | 创建（返回 `plain` 仅此一次）       |
| GET  | `/admin/api/keys/:id`             | 详情 + 24h/7d/30d 用量 + 最近 20 次 |
| POST | `/admin/api/keys/:id/revoke`      | 撤销                                |
| POST | `/admin/api/keys/:id/scope`       | 更新 allowed_models / rate          |
| POST | `/admin/api/keys/:id/debug`       | 启用 / 禁用 / 续期 debug 模式       |

Phase 3 — Usage：

| 方法 | 路径                              | 说明                                  |
| ---- | --------------------------------- | ------------------------------------- |
| GET  | `/admin/api/usage`                | range/key/model 过滤的完整 dashboard  |
| GET  | `/admin/api/usage/export.csv`     | 流式 CSV 导出                         |

Phase 4 — Logs：

| 方法 | 路径                              | 说明                                  |
| ---- | --------------------------------- | ------------------------------------- |
| GET  | `/admin/api/logs`                 | events 表分页 + 过滤                  |
| GET  | `/admin/api/logs/traces`          | 已落盘的 trace 文件列表               |
| GET  | `/admin/traces/stream`            | SSE 实时流（沿用旧端点）              |
| GET  | `/admin/traces/:date.jsonl`       | 下载 trace 文件（沿用旧端点）         |

Phase 5 — Models + Audit + Settings：

| 方法 | 路径                              | 说明                                  |
| ---- | --------------------------------- | ------------------------------------- |
| GET  | `/admin/api/models`               | alias 列表 + 24h 用量 join            |
| GET  | `/admin/api/models/:alias`        | 单 alias 详情（最近 20 + 24h 错误）   |
| GET  | `/admin/api/audit`                | 时间线 + 小时柱状聚合 + 过滤          |
| GET  | `/admin/api/settings`             | 当前 config.json                      |
| PUT  | `/admin/api/settings`             | 写回 config（auth 字段强制保留）      |

## CSP

```
default-src 'self';
frame-ancestors 'none';
form-action 'self';
img-src 'self' data:;
style-src 'self' 'unsafe-inline'
```

React/Tremor/Tailwind 生产构建不需要 `unsafe-eval`。Tremor 部分组件用 inline `<style>` 因此保留 `'unsafe-inline'`（与旧 SSR 一致，未放宽）。

## 已知遗留

1. **tsdown 在 Bun 1.3.14 上 crash**：`globalThis.process.getBuiltinModule is not a function`。`bun run build:server` 当前在本机环境失败，但 SPA 半边（`build:ui`）正常。这是 tsdown 0.15.6 + Bun 1.3 的不兼容，与本次重构无关；解决前 prod 部署需在 CI 环境跑（CI 用 Node 22+）。
2. **eslint 在 Node 18 上 crash**：`Unexpected token 'with'`（import attributes）。MacPorts Node 18 不支持。同样是环境问题，不是代码问题。
3. **uPlot/raw JS 静态资源**：`src/admin/assets/{keys,usage,traces,uplot}.js` 仍被 legacy SSR 页面引用。Phase 5 删除 SSR 时一并清理。
