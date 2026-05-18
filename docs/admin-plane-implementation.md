# Admin Plane — Implementation Notes (v0.8)

> Source of truth for "what was actually built" across issues #28–#36 +
> epic #23. Pair this with `CHANGELOG.md` for the user-facing summary.

Every section follows the same layout: **schema → service → middleware →
HTTP surface → tests → security calls**. Cross-references use `path:line`
where helpful.

---

## 0. Topology

```
┌─────────────────────── HTTP entry ───────────────────────┐
│ logger() → cors()                                        │
│                                                          │
│ ───── public (no auth) ─────                             │
│   GET /                          server.ts:37            │
│   GET /healthz                   server.ts:40            │
│   GET /readyz                    server.ts:43            │
│   GET /admin/assets/*            server.ts:60 (static)   │
│   *   /admin/login               loginApp                │
│                                                          │
│ ───── API-key auth mount ─────                           │
│   server.use("*", path-skip → authMiddleware)            │
│                                                          │
│ ───── telemetry mount ─────                              │
│   server.use("*", path-skip → telemetryMiddleware)       │
│                                                          │
│ ───── trace mount ─────                                  │
│   server.use("*", path-skip → traceMiddleware)           │
│                                                          │
│ ───── admin API ─────                                    │
│   /admin/audit         (admin-tier API key)              │
│                                                          │
│ ───── session-protected admin WebUI ─────                │
│   /admin/* (sessionMiddleware + requireAdminSession)     │
│     /admin (overview)                                    │
│     /admin/keys                                          │
│     /admin/usage                                         │
│     /admin/traces                                        │
│                                                          │
│ ───── proxy routes ─────                                 │
│   /chat/completions, /v1/chat/completions                │
│   /messages,         /v1/messages                        │
│   /embeddings,       /v1/embeddings                      │
│   /responses,        /v1/responses                       │
│   /models,           /v1/models                          │
│   /usage,            /token                              │
└──────────────────────────────────────────────────────────┘
```

Mount order matters: auth runs before telemetry (telemetry needs
`c.var.key`), telemetry runs before trace (so a trace row carries the
same `key_id` as the event row), trace runs before the route handlers
(so it can wrap the response body).

Path-skip predicate (`server.ts:107-114` and similar):

```ts
if (path === "/admin" || (path.startsWith("/admin/") && !path.startsWith("/admin/audit"))) {
  return next()  // session WebUI does its own auth
}
return authMiddleware(c, next)
```

`/admin/audit` is the only `/admin/*` path that runs through the API-key
auth chain (it's an admin API, not a WebUI page).

---

## 1. Schema (`src/lib/migrations/`)

`bun:sqlite` + WAL, PRAGMA `user_version` migration runner
(`src/lib/db.ts:108-156`). Each `.sql` file is wrapped in
`BEGIN EXCLUSIVE ... COMMIT` and the version is interpolated (not bound,
because `PRAGMA` doesn't accept bound parameters).

### 001_init.sql

Placeholder for older versions. Empty.

### 002_keys.sql (issue #28)

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

- `hash` is `SHA-256(plaintext)` hex — the plaintext NEVER touches the
  DB. The UNIQUE constraint also creates an index for `findKeyByHash`.
- `json_valid(allowed_models)` rejects malformed JSON at INSERT time;
  service-layer validation (`validateAllowedModels`) further rejects
  URL-shaped model names to prevent SSRF.
- Soft delete: revocation sets `revoked_at`; the row stays for audit.

### 003_sessions.sql (issue #31)

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

- `id` = `crypto.randomBytes(32).toString("hex")` — 256 bits of entropy.
- `ON DELETE CASCADE` from keys: if a key row is hard-deleted (rare;
  normally we soft-delete via `revoked_at`), all its sessions drop too.
- `csrf_token` is stored but **the running middleware does NOT verify
  against it** — it verifies the HMAC-SHA256 derivative. The column is
  retained because future PRs may persist the CSRF secret (see crew F3
  for #34 — currently in-memory only).

### 004_debug_expires.sql (issue #32)

```sql
ALTER TABLE keys ADD COLUMN debug_expires_at INTEGER;
```

24-hour TTL on `debug_enabled=1`. The sweeper (`src/services/
debug-ttl-sweeper.ts`) auto-disables expired rows every 60 s.

### 005_events.sql (issue #34)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT NOT NULL,             -- '__noauth__' sentinel for --no-auth
  model TEXT NOT NULL,              -- client-facing alias name
  upstream_model TEXT NOT NULL,     -- post-alias-resolution name
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  status INTEGER NOT NULL,          -- HTTP status code
  latency_ms INTEGER NOT NULL,
  error TEXT,                       -- short fixed-vocabulary tag
  usage_unknown INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_events_ts        ON events(ts);
CREATE INDEX idx_events_key_ts    ON events(key_id, ts);
CREATE INDEX idx_events_model_ts  ON events(model, ts);
```

- No FK on `key_id` so the `__noauth__` sentinel doesn't break inserts.
- `error` is a low-cardinality TAG (`bad_request`, `rate_limited`,
  `client_aborted`, …), NEVER the response body — see
  `src/middleware/telemetry.ts:statusToErrorTag`.

---

## 2. Service layer

### 2.1 `keys.ts` (issue #28, expanded in #32)

#### Key generation

`generateKey()` — 33 random bytes (264 bits) → base32 (no padding) → 52
chars → `sk-cap-` + 52 = 59-char token. 264 ≥ 256 bits = comfortably
above NIST's "no need to salt" threshold, which is why we use unsalted
SHA-256 for the at-rest hash.

```
sk-cap-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
       └────────────── 52 base32 uppercase chars ──────────┘
```

#### `validateAllowedModels`

Rejects empty arrays. Each model name must match `/^\w[\w.:-]*$/` or be
the wildcard `*`. This is the same regex used by the config-store for
upstream IDs, and it's the SSRF-prevention guard (no URLs, no slashes).

#### `resolveRateLimit`

Per-key overrides are capped at 10× the global default (default 60 s →
cap 600 s). Negative or non-integer values throw.

#### `createKey`

Single-statement INSERT. Returns `{ plain, row }` — the plaintext is
returned ONCE to the caller and never touches the DB. Callers in
`bootstrap.ts` and `admin/keys/route.tsx` are responsible for
surfacing it exactly once.

#### `setDebugEnabled(id, enabled)`

Combined toggle + TTL refresh:

```sql
UPDATE keys
   SET debug_enabled = ?,
       debug_expires_at = ?   -- now+24h when enabled, NULL when disabled
 WHERE id = ?
```

#### `isDebugActive(row, now)` — **single source of truth**

```ts
if (row.debug_enabled !== 1) return false
if (row.revoked_at !== null) return false
if (row.debug_expires_at !== null && row.debug_expires_at <= now) return false
return true
```

Crew review of #32 found that comparing `row.debug_enabled === 1`
directly across the codebase was stale-prone (the sweeper runs every 60
s; in that window a row could have `debug_enabled=1` and
`debug_expires_at <= now`). This helper is now used everywhere — list
view, detail page, banner, trace middleware.

#### `countActiveDebugKeys()` — TTL-aware

```sql
SELECT COUNT(*) FROM keys
 WHERE debug_enabled = 1
   AND revoked_at IS NULL
   AND (debug_expires_at IS NULL OR debug_expires_at > ?)
```

Powers the red banner on every admin page.

#### `listKeys(limit=50, offset=0)`

Returns `{ rows, total }` for paginated display. ORDER BY `created_at
DESC, id` so the newest keys come first. Verified by the 1000-row perf
test (`tests/admin-keys.test.ts:181-204`) to complete in <100 ms.

#### `updateKeyScope(id, allowedModels, rateLimitOverride)`

Re-validates models, refuses to update revoked keys. Tier is immutable
post-create.

### 2.2 `audit.ts` (issue #30)

JSONL append at
`~/.local/share/copilot-api/audit-YYYY-MM-DD.jsonl`, mode 0600,
`O_WRONLY | O_CREAT | O_APPEND`. Daily rotation by filename. Retention
sweeps on startup.

`audit(event)` fills `ts` automatically and forwards to `appendAudit`.
Errors are caught and logged via `consola.error` — telemetry/audit
failures are best-effort, never propagated.

`AuditEvent` shape:

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
  target?: string            // resource id, OR 8-hex-prefix of bearer hash
  before?: object
  after?: object             // includes bind_address for server.start_no_auth
  ip?: string
  user_agent?: string
}
```

**Security calls:**
- `auth.reject` events record only the first 8 hex chars of
  `SHA-256(bearer)`. Never the bearer itself.
- A trace-write failure NEVER rolls back the mutation that triggered
  it (decision: operational integrity > audit completeness — documented
  in #32 review fix `safeAudit`).

### 2.3 `events.ts` + `retention.ts` (issue #34)

```ts
recordEvent(row): void                  // best-effort INSERT
countEvents(): number
purgeEventsOlderThan(cutoffMs): number   // chunked DELETE, 1000/batch
                                         // + await setImmediate between
startEventRetention(): cancel             // hourly, wall-clock anchored
```

The retention sweeper anchors to the wall-clock hour:

1. On startup, compute `msUntilNextHour()` and run the first sweep
   then.
2. Subsequent ticks every 3,600,000 ms.
3. **Suspend-resume detection**: if `Date.now() - lastTickTs >
   1.25 × HOUR_MS`, log "system likely resumed from suspend" and run a
   catch-up sweep immediately.
4. Reads `retention.events_days` on every tick so a hot-reload of
   `config.json` takes effect on the next sweep without a restart.

Cancel handle is returned and wired into the SIGINT/SIGTERM shutdown
hook in `start.ts`.

### 2.4 `debug-ttl-sweeper.ts` (issue #32)

```sql
SELECT id FROM keys
 WHERE debug_enabled = 1
   AND debug_expires_at IS NOT NULL
   AND debug_expires_at <= ?    -- now
```

For each expired row, runs a bulk UPDATE setting `debug_enabled=0,
debug_expires_at=NULL` and emits one `key.debug_expired` audit event
per row. Runs every 60 s.

### 2.5 Trace pipeline (issue #36)

The three modules are deliberately separated so the unit tests can
exercise each in isolation:

```
trace.ts middleware
     │
     ├── trace-redact.ts  (pure functions, no IO)
     │   redactHeaders / redactBody / assertRedacted
     │
     ├── trace-writer.ts  (sync O_APPEND to JSONL)
     │   writeTrace      ← runs assertRedacted before persistence
     │
     └── trace-broadcaster.ts  (in-process SSE pub-sub)
         broadcastTrace(line) / subscribe(opts)
```

#### `trace-redact.ts`

Two-pass defence-in-depth:

1. `redactBody(body)` — replaces matches of `BODY_PATTERNS`:
   - `gh[oprsu]_[A-Za-z0-9]{20,}` — classic GitHub tokens
   - `github_pat_\w{20,}` — fine-grained PATs
   - `eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+` — JWT shape (Copilot bearer)
   - `Iv\d+\.[A-Fa-f0-9]{16,}` — GitHub App client id (Iv1.*, Iv23.*)
   - `sk-cap-[A-Z2-7]{52}` — **this proxy's own tokens** ← added in
     the #36 review fix; otherwise a user pasting their own key into a
     prompt would leak it verbatim
   - `sk-ant-[\w-]{40,}` — Anthropic API keys
   - `sk-[\w-]{40,}` — OpenAI-style keys
   - `\bAKIA[A-Z0-9]{16}\b` — AWS access key id
   - `(?<=://)[^:/@\s]+:[^@\s]{1,200}(?=@)` — basic-auth in URLs

2. `assertRedacted(line)` — **independent** post-redact check:
   - Re-runs `BODY_PATTERNS` (catches substitution bugs)
   - Plus `POST_REDACT_HEURISTICS`:
     - `\bbearer\s+[\w+./~=-]{32,}` — any opaque token after `bearer `
     - `\b(api[_-]?key|token|secret|password)["':=]+...{32,}`

   If either throws, the writer drops the trace entirely. This catches
   secret families we haven't enumerated (e.g., a custom partner API key
   with no recognisable prefix).

`REDACTED_HEADERS` = `{authorization, x-api-key, cookie, set-cookie,
proxy-authorization, x-github-token, x-vscs-token, x-capi-debug}` —
case-insensitive match (Headers normalizes to lowercase; the plain-
object branch lowercases the key first).

#### `trace-writer.ts`

```ts
writeTrace(event: TraceEvent): void
```

1. Build the JSONL text via `redactHeaders` + `redactBody` + JSON.stringify.
2. Run `assertRedacted` on the output. If throws → log + drop.
3. If `getConfig().retention.traces_days <= 0` → return (in-memory only).
4. `fs.mkdirSync(tracesDir(), { recursive: true, mode: 0o700 })`.
5. Open `traces/traces-YYYY-MM-DD.jsonl` with `O_WRONLY | O_CREAT |
   O_APPEND`, mode 0o600. Write. Close.
6. Push the redacted text to `broadcastTrace(text)`.

The dir mode + file mode ensure that only the proxy user can read the
captured prompts.

#### `trace-broadcaster.ts`

Single-process pub-sub for `/admin/traces/stream`. Internal state:

```ts
const subscribers = new Set<Subscriber>()   // cap 4
const ring: Array<RingEntry> = []           // last 100 frames for replay
let monotonicId = 0
```

`subscribe(opts)` reserves a slot **synchronously** by adding a
`Subscriber` with a `PLACEHOLDER_CONTROLLER` to the set, then sets up a
`ReadableStream` whose `start()` callback swaps in the real controller.
This closes the check-then-act race that crew review of #36 flagged
(R4) where two near-simultaneous `subscribe()` calls could both pass
`size >= 4` on the same value.

Per-subscriber queue is bounded at 1 MB (`MAX_QUEUE_BYTES`); drop-oldest
when overflowed. Heartbeat frame (`: ping\n\n`) every 15 s. The
heartbeat interval handle is cleared on close.

`Last-Event-ID` reconnect support: if the client sends the header, the
broadcaster replays any entries in `ring` with `id > lastEventId`. IDs
reset on restart (documented limitation: clients lose up to ring-size
events).

#### `trace-retention.ts`

Hourly sweep:

```ts
purgeOldTraces()    // age-based: delete files older than traces_days
enforceSizeCap()    // size-based: keep total ≤ traces_max_bytes
                    // delete oldest day first, warn if eviction triggers
                    // INSIDE the retention window
startTraceRetention(): cancel
```

`enforceSizeCap` orders files by date ASC, sums their bytes, drops the
oldest until total ≤ cap. A warn-level log fires if eviction triggers
before `traces_days` — that's the alarm condition for "size growth
is outrunning your retention policy".

---

## 3. Middleware

### 3.1 `auth.ts` — Bearer + per-key rate limit + model scope (issue #29)

```ts
authMiddleware:
  // 1. Strip sensitive client headers immediately, before any branch.
  c.req.raw.headers.delete("x-api-key")
  c.req.raw.headers.delete("cookie")

  // 2. No-auth mode: stub a NO_AUTH_SENTINEL key with id "__noauth__".
  if (!getConfig().features.auth) {
    c.set("key", NO_AUTH_SENTINEL)
    return next()
  }

  // 3. Authorization header required. Bearer scheme is case-insensitive
  //    (RFC 7235 §2).
  const authHeader = c.req.header("Authorization")
  if (!authHeader) { auditReject(c); return reject401(...) }

  const bearer = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7)
    : authHeader
  c.req.raw.headers.delete("authorization")  // strip before upstream

  // 4. SK_CAP_RE = /^sk-cap-[A-Z2-7]{52}$/  — full-shape validation,
  //    avoids upstream rejecting a malformed prefix as our own key.
  if (!SK_CAP_RE.test(bearer)) {
    const prefix = sha256(bearer).slice(0, 8)
    auditReject(c, prefix)             // log only 8-char hash prefix
    return reject401("Use a sk-cap-* key issued by this server")
  }

  // 5. DB lookup (hash compare).
  const hash = sha256(bearer)
  const row = findKeyByHash(hash)
  if (!row || row.revoked_at !== null) {
    auditReject(c, hash.slice(0, 8))
    return reject401("Invalid API key")
  }

  // 6. X-Capi-Debug — strip unconditionally; only admin tier may set the
  //    `debug_via_header` context flag (consumed by traceMiddleware).
  const debugHeader = c.req.header("x-capi-debug")
  c.req.raw.headers.delete("x-capi-debug")
  if (debugHeader === "1" && row.tier === "admin") {
    c.set("debug_via_header", true)
  } else if (debugHeader !== undefined && row.tier !== "admin") {
    consola.warn("[auth] Stripped X-Capi-Debug from client-tier request")
  }

  // 7. Per-key rate limit (token-bucket-ish: lastTs + windowMs eviction).
  try {
    checkKeyRateLimit(row.id, row.rate_limit_override)
  } catch (err) {
    if (err instanceof HTTPError) return new Response(err.response.body, ...)
    throw err
  }

  c.set("key", row)
  return next()
```

`isModelAllowed(allowedModelsJson, model)`:
- `JSON.parse` the column.
- `Array.isArray` guard before `.some()` — crew review caught that
  `"*"`.includes("*")` returns true on a non-array, which would have
  let any non-admin key bypass the scope check by sending a JSON
  string `"*"` in `allowed_models`. The Array.isArray gate kills it.

### 3.2 `telemetry.ts` (issue #34)

Records one row per request. Shape:

```
key_id          c.get("key")?.id  ?? "__noauth__"
model           snapshot from POST body (capped read; see below)
upstream_model  c.get("upstream_model") ?? model
prompt_tokens   c.get("usage")?.prompt_tokens
completion_tokens c.get("usage")?.completion_tokens
status          c.res.status
latency_ms      Date.now() - start
error           statusToErrorTag(status)  // fixed vocabulary
usage_unknown   1 if both token columns are null else 0
```

**Body model snapshot** (post-#34 review fix R2): the previous version
called `await req.clone().text()` which materialised the entire request
body in memory just to read the `model` field. The fix uses a streaming
reader capped at 16 KB and bails out as soon as a `"model": "..."`
regex match is found. Otherwise a vision payload (multi-MB base64)
would be double-buffered for every request.

**Streaming-response instrumentation** (post-#34 review fix R1): the
original code used `pipeThrough(TransformStream(... flush() {...} ))`
to fire the telemetry insert on stream close. Crew review found that
**Bun's `TransformStream.cancel` callback is not invoked on downstream
cancel**, so a client disconnect mid-SSE silently dropped the trace.
The fix replaces `pipeThrough` with a hand-rolled `ReadableStream`:

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

A `recorded` flag guards `fire()` so it runs exactly once across EOF /
cancel / pull-error races. When `aborted=true` and status < 400, the
event row's `error` column is set to `"client_aborted"` so the
dashboard can distinguish a client hang-up from an upstream error.

### 3.3 `trace.ts` (issue #36)

Activates when EITHER:
- `isDebugActive(c.get("key"))` (key has `debug_enabled=1` AND not
  revoked AND `debug_expires_at > now`), OR
- `c.get("debug_via_header")` (set by auth middleware when an admin-
  tier key passes `X-Capi-Debug: 1`).

Same `ReadableStream` wrapping pattern as `telemetry.ts` for streaming
bodies. 256 KB cap per leg; anything past that is `[TRUNCATED]`. v1
captures **client → proxy → client** only; capturing the proxy → GitHub
leg requires plumbing through each helper in `src/services/copilot/*`
(TODO comment in `middleware/trace.ts`).

### 3.4 `session-middleware.ts` (issue #31)

```ts
sessionMiddleware:
  // 1. HTTPS-or-loopback guard. X-Forwarded-Proto only trusted when
  //    process.env.TRUST_PROXY === "true".
  if (!isRequestAllowed(c)) return c.text("HTTPS required ...", 403)

  // 2. Session lookup.
  const sid = extractSessionId(cookieHeader)
  if (!sid) return c.redirect("/admin/login", 302)

  // 3. CSRF — for non-GET methods, BEFORE the DB session lookup so a
  //    stolen sid can't be probed via the expiry-slide write.
  if (!["GET","HEAD"].includes(method)) {
    if (fetchSite !== "same-origin") return 403
    const tokenHeader = c.req.header("x-csrf-token")
    const tokenBody   = await extractCsrfBody(c)   // form-body fallback
    const effective   = tokenHeader ?? tokenBody
    const tokenCookie = extractCsrfCookie(cookieHeader)
    if (!effective || !tokenCookie) return 403
    if (!verifyCsrfToken(sid, effective) || !verifyCsrfToken(sid, tokenCookie))
      return 403
  }

  const session = getSession(sid)        // also slides expiry
  if (!session) { clear cookie; redirect to /admin/login }
  c.set("session", session)
  await next()

  // 4. Sliding window: refresh Max-Age on every authenticated response
  //    so the browser cookie stays in sync with the server-side expiry.
  c.res.headers.append("Set-Cookie", sessionCookieValue(session.id))
```

**`requireAdminSession`** (post-#35 review fix F-6): re-looks-up
`session.key_id` in the keys table on every request and tears the
session down if the key is missing, revoked, or non-admin. Defense in
depth against a regression in `login.tsx` that would otherwise silently
accept client-tier keys.

`csrf.ts`:

```ts
generateCsrfToken(sessionId): string
  = base64url(HMAC-SHA256(sessionId, CSRF_SECRET))
verifyCsrfToken(sessionId, token): boolean
  = timingSafeEqual(expected, token)
```

`CSRF_SECRET = crypto.randomBytes(32)` at module load. Known
limitation: process restart invalidates all existing CSRF tokens; users
have to re-login. Documented in the module header.

---

## 4. HTTP surface

### 4.1 `loginApp` — POST/GET /admin/login

- GET: server-rendered form (key + login button). Error messages via
  `?error=missing|invalid`.
- POST:
  1. `findKeyByHash(sha256(plaintext))`.
  2. Reject if not found, revoked, or non-admin.
  3. **Invalidate previous sessions for the same key**:
     `DELETE FROM sessions WHERE key_id = ?` (post-#31 review fix).
     Prevents stolen-session persistence after re-login.
  4. `createSession(keyRow.id)` → new sid + csrf cookie pair.
  5. 303 → `/admin`.

Cookie attributes:

```
sid=<32-byte-hex>;  HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=28800
csrf=<hmac>;        Secure;   SameSite=Strict; Path=/admin
```

(CSRF cookie is **not** `HttpOnly` — JS/forms need to read it for the
double-submit pattern. CSRF cookie missing `Secure` was the crew F-5
finding for #31; fixed.)

### 4.2 Admin keys page — `/admin/keys`

| Method | Path                      | Action                              |
|--------|---------------------------|-------------------------------------|
| GET    | `/admin/keys`             | list, paginated 50/page             |
| GET    | `/admin/keys/new`         | create form                          |
| POST   | `/admin/keys/new`         | create key + flash plaintext token  |
| GET    | `/admin/keys/created?flash=X` | one-time plaintext view (consumed)|
| GET    | `/admin/keys/:id`         | detail / edit page                  |
| POST   | `/admin/keys/:id/revoke`  | soft delete                          |
| POST   | `/admin/keys/:id/scope`   | update allowed_models + rate limit  |
| POST   | `/admin/keys/:id/debug`   | enable/disable/renew debug          |

**Flash store** is process-lifetime in-memory `Map<token, {plain, keyId,
expires}>`. 5-minute TTL. One-time consume (`Map.delete` after read).
The token in the URL is `crypto.randomUUID()` (122 bits). If the user
hits Refresh, the URL gets a 410 Gone with an explicit "plaintext no
longer available" error message — NOT a silent redirect (post-#32
review fix F-3).

**Debug confirmation** is now a **server-side gate** (post-#32 review
fix R2): the form submits `debug_enabled=1` AND `debug_confirm=yes`.
The latter is set by JS in `keys.js` after the modal is acknowledged.
Without JS the operator can't enable debug at all. The CSP
(`default-src 'self'`) blocks inline scripts AND inline `onclick`
handlers, so the entire interactivity is in
`src/admin/assets/keys.js` and wired via `addEventListener`.

**Renew button** (post-#32 review fix R1): originally shared a form
with the Disable button that always submitted `debug_enabled=0`,
silently disabling instead of refreshing the TTL. The fix uses two
separate forms; the renew form posts `action=renew` and the handler
calls `setDebugEnabled(id, true)` regardless of the `debug_enabled`
field.

### 4.3 Usage dashboard — `/admin/usage` (issue #35)

`queries.ts` exports pure SQL helpers:

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

p95 is computed by splitting into hour buckets, counting per bucket,
and picking the (0.95 × count)-th row by latency_ms. Two queries per
bucket; the planner still uses `idx_events_ts` for the range scan.

**CSV export** at `/admin/usage/export.csv`:

- Pull-based `ReadableStream` (post-#35 review fix F-2) — `pull()`
  calls `iter.next()` one row at a time, applying backpressure when
  the client is slow.
- `cancel()` calls `iter.return?.()` to finalise the SQLite iterator,
  releasing the read transaction so WAL checkpoints can proceed.
- RFC 4180 quoting via `csvField(value)`:
  - Quote if the value contains `,`, `"`, `\r`, or `\n`. Embedded `"`
    is doubled (`"a""b"`).
  - **Formula-injection guard** (post-#35 review fix F-1): if the value
    starts with `=`, `+`, `-`, `@`, `\t`, or `\r`, prepend an apostrophe.
    Excel/Numbers/LibreOffice render the apostrophe as text-suppression
    rather than a literal character — defeats `=cmd|'/c calc'!A1` style
    payloads in model names.

**Custom range cap** (post-#35 review fix F-9): `parseFilter` clamps
the custom window to 90 days even though events themselves are already
retention-bounded — caps the WHERE-clause scan range so a bad request
can't pin a long read transaction.

**JSON data island** in `page.tsx` is wrapped in `<script
type="application/json" id="usage-data">`. All HTML special chars (`<`,
`>`, `&`, U+2028, U+2029) are escaped to their `\uXXXX` form in the
JSON before embedding (post-#35 review fix F-3). `JSON.parse` decodes
them transparently; the HTML tokenizer sees an opaque payload.

### 4.4 Traces — `/admin/traces` (issue #36)

| Method | Path                            | Action                              |
|--------|---------------------------------|-------------------------------------|
| GET    | `/admin/traces`                 | live-tail page (loads `traces.js`)  |
| GET    | `/admin/traces/stream`          | SSE feed via broadcaster.subscribe  |
| GET    | `/admin/traces/:filename`       | streamed JSONL download             |

**Path-traversal guard** (post-#36 review fix R3):

1. `filename` must end in `.jsonl`; strip the extension.
2. `date` must match `^\d{4}-\d{2}-\d{2}$`.
3. Build `fullPath = path.join(tracesDir(), `traces-${date}.jsonl`)`.
4. Lexical check: `fullPath.startsWith(tracesDir() + path.sep)`.
5. **Symlink check (defense in depth)**:
   `resolved = fs.realpathSync.native(fullPath)`. If `resolved` doesn't
   start with `tracesDir() + path.sep`, reject with 400.
6. ENOENT in step 5 → 404. Other errors → 400.

**Streamed download** (post-#36 review fix R5): the original code did
`fs.readFileSync(fullPath, "utf8")`, which would freeze the event loop
for a 100 MB file. The fix wraps `fs.createReadStream` into a Web
`ReadableStream` with `pause()`/`resume()` backpressure and a `cancel()`
that destroys the Node stream.

### 4.5 Auth-mode safety guard (issue #33)

`src/lib/auth-mode.ts`:

```ts
resolveAuthMode({ noAuth, acceptRisk, host, port, configAuth }): AuthModeResult
```

Three labels:

- `"on"` — auth enabled, no further checks.
- `"off (loopback)"` — auth disabled via `--no-auth` or
  `features.auth=false`, AND host is loopback (`127.0.0.1`, `::1`,
  `localhost`, or RFC4291-long-form IPv6 loopback). Allowed with a
  yellow warning.
- `"off (acknowledged risk)"` — non-loopback bind, only when
  `--i-accept-account-suspension-risk` is set. Allowed with a red
  warning.

Anything else **throws** with a descriptive error pointing at the
README. The CLI catches the throw and `process.exit(2)`. The
resolution runs BEFORE `applyOptions` so we don't init the DB or fetch
upstream tokens on a refused start.

`isLoopbackHost(host)` handles:
- `localhost`, `127.x.y.z` (with per-octet 0-255 bound),
- `::1`, `[::1]`, `0:0:0:0:0:0:0:1`, the fully zero-padded form,
- `::ffff:127.0.0.1` (IPv4-mapped IPv6 loopback)
- `LOCALHOST` (case-insensitive), `127.0.0.1\n` (trim)
- Rejects look-alikes: `128.x.x.x`, `127.0.0.999`,
  `127.0.0.1.attacker.com`, `127.0.0.1:80` (port suffix), `127.0.0.1/24`

`formatBindAddress(host, port)` wraps IPv6 in brackets per RFC 3986 so
`::1` formats as `[::1]:4141`, not the ambiguous `::1:4141`.

`setRuntimeAuthOverride(boolean)` in `config-store.ts` — only invoked
when the CLI explicitly passed `--no-auth` (post-#33 review fix R2).
Otherwise the config file's `features.auth` is authoritative. Default
flipped from `false` to `true` in the schema.

---

## 5. Test infrastructure

525 tests across 27 files. Each test file follows the same lifecycle:

```ts
beforeEach: (
  fresh tmp dir → fresh DB → loadConfig(temp) → reset any module-level state
)
afterEach: (
  closeDb → resetDb → rm tmp dir → loadConfig("__nonexistent__") so the
  in-memory config doesn't leak features.auth=true into the next file
)
```

Per-feature test files:

| File | Tests | Coverage |
|------|------:|----------|
| `keys.test.ts` | 35 | generation, hash, validation, paging, debug TTL |
| `auth.test.ts` | 22 | 401 / 403 paths, model scope, WWW-Authenticate, no-auth mode |
| `audit.test.ts` | 25 | mode 0600, append-not-truncate, retention, auth.reject doesn't log token |
| `admin.test.ts` | 38 | CSRF, sessions, login, cookie flags, HTML structure, healthz/readyz |
| `admin-keys.test.ts` | 37 | flash store non-replayable, revocation propagates, debug confirm, perf on 1000 keys, XSS-in-label escaping |
| `auth-mode.test.ts` | 16 | loopback variants, IPv6 long-form, --no-auth + ack permutations |
| `config-store.test.ts` | 30 | schema defaults, runtime override, watchConfig hot-reload |
| `telemetry.test.ts` | 14 | row shape per status code, streaming with/without usage, abort regression (R1), spy on recordEvent failure |
| `usage-queries.test.ts` | 24 | aggregates, EXPLAIN uses indices, RFC 4180 round-trip, formula-injection, 1M-row perf (skipIf CI) |
| `admin-usage.test.ts` | 11 | session redirect, chart island, CSP, CSV mime + body |
| `trace-redaction-fuzz.test.ts` | 21 | 1000-input property test, every issuer pattern, post-redact heuristic catches unknown shapes |
| `trace.test.ts` | 22 | file perms 0600, traces_days=0 no-op, retention sweep + 1GB cap, path traversal (URL-encoded, symlink), broadcaster fan-out + cap + drop-oldest, middleware enable via X-Capi-Debug |
| + 14 pre-existing test files (model routing, native messages, etc.) | rest | unchanged |

---

## 6. CSP & client-side JS

CSP applied to every `/admin` response:

```
default-src 'self';
frame-ancestors 'none';
form-action 'self';
img-src 'self' data:;
style-src 'self' 'unsafe-inline'
```

Other security headers: `X-Frame-Options: DENY`, `Referrer-Policy:
no-referrer`, `X-Content-Type-Options: nosniff`.

`script-src` is NOT set explicitly, which means it inherits
`default-src 'self'` — no inline scripts, no inline event handlers
(no `onclick="..."` etc.). All interactivity is in three external
files:

- `src/admin/assets/keys.js` — debug-confirmation modal, key created
  banner copy-button, "I have copied" gate + beforeunload warning
- `src/admin/assets/usage.js` — reads the JSON island, instantiates
  three uPlot charts
- `src/admin/assets/traces.js` — opens EventSource, appends lines to
  the `<pre>` element

`src/admin/assets/uplot.min.js` is vendored uPlot 1.6.32 (MIT,
~50 KB minified, fetched from jsdelivr at build time of the agent
worktree).

---

## 7. CLI surface (`src/start.ts`)

```
start [--port 4141]
      [--host 127.0.0.1]                            # default loopback only
      [--no-auth]                                    # legacy unauth, gated
      [--i-accept-account-suspension-risk]          # required for non-loopback no-auth
      [--account-type individual|business|enterprise]
      [--manual]                                     # human approval per request
      [--rate-limit <seconds>]
      [--wait]                                       # wait vs error on rate limit
      [--github-token <token>]                       # skip interactive auth
      [--claude-code]                                # emit ANTHROPIC_* env script
      [--show-token]
      [--proxy-env]
      [--verbose]
```

Startup sequence (`runServer`):

1. `ensurePaths()` + `loadConfig()`
2. `resolveAuthMode({...})` — THROWS if combination is unsafe. Catch
   in the command's `run({})` prints red + `process.exit(2)`.
3. If `--no-auth` was passed, `setRuntimeAuthOverride(false)`.
4. `applyOptions()` — proxy env, version fetches, github + copilot
   token setup, cache models.
5. `initDb()` — runs all 5 migrations under WAL.
6. `initAudit()` — retention sweep for audit JSONL.
7. `logAuthModeBanner(authMode)` — `[auth] mode=X bind=Y` line.
8. `runBootstrap()` — if `features.auth` is on AND no admin keys
   exist, create one and write to `admin.key.txt` (mode 0600, O_EXCL).
9. `startPeriodicSweepers()`:
   - sessions: hourly
   - debug TTL: every 60 s
10. `startEventRetention()` → cancel handle into shutdown.
11. `startTraceRetention()` → cancel handle into shutdown.
12. If `features.auth` is off, audit `server.start_no_auth` with the
    bind address.
13. `installShutdownHandlers(...)` — SIGINT/SIGTERM stop retention
    sweepers AND close the DB before `process.exit`.
14. `serve({ fetch: server.fetch, port, hostname })`.

---

## 8. Filesystem layout

```
~/.local/share/copilot-api/
├── config.json                              # Zod-validated, mode 0600
├── copilot-api.db                           # bun:sqlite WAL
├── copilot-api.db-shm
├── copilot-api.db-wal
├── github_token                             # user's GH token, mode 0600
├── admin.key.txt                            # one-time bootstrap key
├── audit-YYYY-MM-DD.jsonl                   # daily-rotated audit log
└── traces/
    ├── traces-YYYY-MM-DD.jsonl              # only when traces_days > 0
    └── ...
```

All file modes 0600, dir mode 0700. `hardenDbFiles` (lib/db.ts) chmods
the SQLite WAL/SHM files via `fchmod` on an open fd after `lstat`
rejects symlinks — TOCTOU-safe.

---

## 9. Cross-cutting decisions / non-obvious calls

- **bun:sqlite `TransformStream.cancel` doesn't fire on downstream
  cancel.** Switched to hand-rolled `ReadableStream` everywhere
  streaming bodies need post-flush instrumentation
  (`telemetry.ts`, `trace.ts`, traces/route.tsx, usage/route.tsx).
- **`/admin/audit` is an exception** to the path-skip rule on the API
  auth chain — it's an admin API, not a session-based WebUI page.
- **`features.auth` default** flipped from `false` → `true`. Existing
  installs with no config.json fall through to "auth on" + bootstrap.
- **`traces_days` default** flipped from `7` → `0` per privacy
  posture: on-disk persistence is an explicit opt-in. The broadcaster
  still receives events for live tail at `traces_days = 0`.
- **`features.auth=false` in config.json** is **NOT** silently
  ignored — it flows through the same safety guard as `--no-auth`, so
  a config-only escape on a non-loopback bind also refuses to start
  without `--i-accept-account-suspension-risk`.
- **Best-effort audit policy**: an audit append that fails (disk full,
  EACCES, …) logs `consola.error` and continues. The mutation that
  triggered it has already committed in the DB and SHOULD NOT be rolled
  back. Auditing is observability, not durability.
- **Telemetry / trace failures NEVER propagate to the client.** Both
  middlewares wrap their post-handler work in try/catch and log via
  consola. The contract: even a totally broken DB should still let the
  proxy answer 200 with a valid Copilot response.
- **`assertRedacted` runs INDEPENDENT patterns**, not just the
  same `BODY_PATTERNS` it would have already substituted. Catches
  unknown secret families.
- **Sessions reserve the slot synchronously** on subscribe, not in
  ReadableStream `start()`. Closes the check-then-act window for the
  4-subscriber cap.

---

## 10. Known limitations

1. **CSRF secret is process-lifetime in-memory.** Restart invalidates
   every existing browser session's CSRF token; users have to
   re-login. Documented in `csrf.ts`.
2. **Trace upstream-leg capture is not implemented in v1.** The
   `upstream_req` / `upstream_res` fields exist in the writer schema
   but no service calls `c.set("trace_capture", ...)` yet. Plumbing
   through each helper in `src/services/copilot/*` is the follow-up.
3. **p95 latency uses per-bucket OFFSET picks** (no bun:sqlite window
   functions). For a 30-day window with ~30M events that's 720 bucket
   queries with per-bucket sort. Fine in practice; documented as a
   perf note in `queries.ts`.
4. **Bun's `TransformStream.cancel`** doesn't fire on downstream
   cancel — see #9. If a future Bun release fixes this, the
   hand-rolled `ReadableStream` wrappers can be replaced with the
   simpler `pipeThrough` pattern.
5. **`Last-Event-ID` reconnect** loses up to ring-size (100 frames)
   on server restart because `monotonicId` resets.
6. **No multi-process support.** Trace broadcaster, CSRF secret,
   session table, rate-limit buckets are all in-process. A
   future multi-instance deployment needs sticky sessions + a shared
   pub-sub (Redis, etc.).

---

## 11. Commit map

```
303eb40  feat(auth)        keys table, sk-cap generator, bootstrap     #28
574f9fd  fix(auth)         crew review fixes for #28                   #28
2259356  feat(auth)        Bearer auth + rate limit + model scope      #29
82ed67b  feat(audit)       audit log + /admin/audit endpoint           #30
647ce71  feat(admin)       Admin WebUI shell + login + CSRF + CSP      #31
0d02f79  fix(admin)        crew review fixes for #31                   #31
7277dea  feat(admin-keys)  keys management UI + debug TTL              #32
81477aa  fix(admin-keys)   crew review fixes for #32                   #32
c77b6b6  feat(auth)        --no-auth safety gate + deprecation         #33
37f0495  fix(auth)         crew review fixes for #33                   #33
8a9e500  feat(telemetry)   events table + middleware + retention       #34
208ed8b  fix(telemetry)    crew review fixes for #34                   #34
25ddb4a  feat(usage)       admin dashboard + uPlot + CSV               #35
66644eb  fix(usage)        crew review fixes for #35                   #35
e1c4e73  feat(traces)      debug capture + redaction + SSE             #36
e0a6c97  fix(traces)       crew review fixes for #36                   #36
```

Each `fix(...)` commit is the response to a parallel crew review on
the preceding `feat(...)` commit. Both halves of the pair are
intentionally kept separate in history.
