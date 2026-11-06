# poca-note — System Architecture

**A tenant-scoped, keyboard-first personal Kanban with AI skills, board actions, and scheduled reports.**

| | |
| --- | --- |
| Document version | 1.0 |
| Application version | 1.0.0 |
| Status | Current implementation |
| Audience | Engineers operating, extending, or reviewing poca-note |
| Runtime | Node.js >= 22.13, Express 4, React 18, Vite 6 |
| Storage | SQLite (default) or PostgreSQL |

---

## Table of contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Product shape in one page](#2-product-shape-in-one-page)
3. [Architectural principles](#3-architectural-principles)
4. [System context and topology](#4-system-context-and-topology)
5. [Process model and boot sequence](#5-process-model-and-boot-sequence)
6. [Configuration](#6-configuration)
7. [Storage architecture](#7-storage-architecture)
8. [Identity, tenancy, and authorization](#8-identity-tenancy-and-authorization)
9. [Board domain](#9-board-domain)
10. [Dashboards](#10-dashboards)
11. [HTTP interface](#11-http-interface)
12. [Realtime synchronization](#12-realtime-synchronization)
13. [AI subsystem](#13-ai-subsystem)
14. [Reports subsystem](#14-reports-subsystem)
15. [Link title enrichment](#15-link-title-enrichment)
16. [Frontend architecture](#16-frontend-architecture)
17. [Tooling and operations](#17-tooling-and-operations)
18. [Testing strategy](#18-testing-strategy)
19. [Security posture](#19-security-posture)
20. [Constraints, scaling, and failure modes](#20-constraints-scaling-and-failure-modes)
21. [Request lifecycles](#21-request-lifecycles)
22. [Source map](#22-source-map)
23. [Glossary](#23-glossary)

---

## 1. Purpose and scope

poca-note is a small, self-hosted work surface for an individual or a small team. It combines three things that are usually separate products:

- a **Kanban board** with four fixed columns (`todo`, `doing`, `review`, `done` — where *Under Review* holds work awaiting testing or sign-off), multiple boards per workspace, drag-and-drop ordering, checklists, due dates, priorities, links, search, a trash can, and status check-ins with dated update timelines on every card and subtask;
- an **AI skills studio** that turns a short brief into structured Markdown content, and an **AI actions** planner that translates a plain-English request into validated board mutations;
- a **reporting subsystem** that produces daily, weekly, monthly, and one-minute brief reports from live board data, with optional model-written narrative, on a schedule or on demand.

Everything is **workspace-scoped**. A workspace (internally a *tenant*) owns its boards, cards, users, reports, AI history, and link cache. There is no cross-workspace read path in the application.

This document describes the system as implemented, including the decisions that are easy to miss when reading a single file: why the PostgreSQL adapter blocks a worker thread, why every mutation returns a revision, how task numbers avoid collisions, and where the frontend and backend disagree about "the latest board".

**Out of scope:** product marketing copy, deployment-provider specifics, and a line-by-line API reference. The README covers installation, configuration, and endpoint examples.

---

## 2. Product shape in one page

```
Landing page  ──sign up / sign in──▶  Board  ──▶  Card editor
   │                                   │
   │                                   ├──▶ AI actions (plan → review → apply)
   │                                   ├──▶ Trash (restore / purge)
   │                                   ├──▶ Reports (daily / weekly / monthly / brief)
   │                                   └──▶ Settings (boards, teammates, theme)
   │
   └──▶ Skills (brief → generated Markdown, run history)
```

Three top-level authenticated routes exist: `/board`, `/skills`, and `/reports`. `/` is the public landing page. `/login` is the sign-in and sign-up screen. All authenticated routes are served by the same SPA shell and guarded server-side in production.

The product's defining constraint is **speed of capture**. The board is operable without a mouse: `n` focuses quick capture, `j`/`k` move selection, `h`/`l` move between columns, `1`/`2`/`3` move a card, `Enter` opens it, `d` deletes, `/` searches, `?` shows help. Every write is optimistic on the client and conflict-checked on the server.

---

## 3. Architectural principles

**1. One process, one database, no service mesh.** The API, the SPA, the report scheduler, and the SSE hub live in one Node.js process. SQLite is the default. PostgreSQL is an opt-in escape hatch for hosted or multi-instance deployments. There is no Redis, no queue, no separate worker service.

**2. Tenant scope is enforced in the data layer, not only the router.** Every query that touches user data takes `tenant_id` from the authenticated session and includes it in the `WHERE` clause. A route cannot accidentally read another workspace by changing a path parameter, because the path parameter is always paired with the session tenant.

**3. The server owns correctness; the client owns responsiveness.** The client applies writes immediately, then reconciles with the server response. Card updates carry an integer `version`; a stale version produces a `409` with the current card and revision so the client can recover without a full reload.

**4. Every mutation publishes a monotonic revision.** A single counter per workspace (`tenant_state.revision`) increments inside the same transaction as the write. The response carries the new revision, and the SSE hub broadcasts it. Other tabs and devices refresh when they see a higher revision. This is a change token, not a snapshot: clients still fetch the board.

**5. AI is optional, and the app works without it.** The provider chain falls back to deterministic offline output for content generation and to a rules-based planner for board actions. A workspace with no API key and no local model is fully functional.

**6. Small dependencies, explicit code.** The server uses Express, `pg`, and Node built-ins (`node:sqlite`, `node:crypto`, `node:worker_threads`). The client uses React, `lucide-react`, and Vite. Markdown rendering is implemented in-tree rather than pulled from a library: the SPA has a small safe renderer for AI output and reports, and `scripts/render-docs.mjs` follows the same approach for this document.

---

## 4. System context and topology

```
                         ┌──────────────────────────────────────────────┐
                         │                 Browser                      │
                         │                                              │
                         │  React SPA (web/dist)                        │
                         │   ├─ useBoard  ── optimistic cache           │
                         │   ├─ EventSource ── /api/events (SSE)        │
                         │   ├─ BroadcastChannel ── other tabs          │
                         │   └─ localStorage ── last known board        │
                         └───────────────┬──────────────────────────────┘
                                         │ HTTPS, httpOnly cookie
                                         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         Node.js process (server/)                      │
│                                                                        │
│  Express app                                                           │
│   ├─ security headers, JSON body, origin guard                         │
│   ├─ /api/auth/*        (public)                                       │
│   ├─ session middleware (cookie → tenant + user)                       │
│   ├─ editor gate        (non-GET requires owner/editor)                │
│   ├─ /api/board, /api/cards, /api/dashboards, /api/trash               │
│   ├─ /api/checklist, /api/users, /api/reports, /api/link-title         │
│   ├─ /api/ai/*          (status, generate, actions, brief)             │
│   ├─ /api/events        (SSE hub, one channel per tenant)              │
│   └─ static SPA + HTML gate                                            │
│                                                                        │
│  Domain modules                                                        │
│   ├─ auth.js       scrypt, sessions, roles, signup, HTML gate          │
│   ├─ board.js      cards, checklists, trash, positions, versions       │
│   ├─ dashboards.js boards, accents, safe delete                        │
│   ├─ services/ai.js          provider chain + offline template         │
│   ├─ services/actions.js     rules/LLM planner + executor              │
│   ├─ services/reports.js     periods, snapshots, Markdown, scheduler   │
│   └─ services/linkTitle.js   SSRF-safe fetch + 24h cache               │
│                                                                        │
│  Storage adapter (db.js)                                               │
│   ├─ SQLite: node:sqlite DatabaseSync (synchronous, in-process)        │
│   └─ PostgreSQL: worker thread + SharedArrayBuffer + Atomics.wait      │
└───────────────┬────────────────────────────────┬───────────────────────┘
                │                                │
                ▼                                ▼
        data/poca-note.db                 PostgreSQL server
        (WAL, foreign keys)               (opt-in via DATABASE_URL)

External, optional:
  Anthropic API   ─┐
  Ollama          ─┼──▶ AI content + action planning + report narrative
  OpenAI-compat   ─┘
  Arbitrary HTTP  ────▶ link title lookup (SSRF-guarded, cached)
```

**Trust boundaries.** The browser is untrusted. The session cookie is `httpOnly` and `SameSite=Lax`. Cross-origin mutations are rejected by the origin guard. The AI providers are untrusted text sources: model output is treated as Markdown for display and as a *proposal* for actions, never executed directly. Fetched link pages are untrusted and bounded by size, time, redirect count, and private-address checks.

---

## 5. Process model and boot sequence

There is exactly one long-lived process in the default deployment. `server/index.js` is the entry point:

```
loadDotenv()                     read .env, existing process.env wins
   │
createConfig()                   parse and clamp all settings
   │
openDatabase(config)             SQLite (default) or PostgreSQL (DATABASE_URL)
   │                             └─ migrations run here
seedDemoTenant(db, config)       only when the tenants table is empty
   │
createApp({ db, config })        Express wiring; creates the SSE hub
   │
app.listen(config.port)          prints storage backend and seed status
   │
startReportScheduler()           one interval, one tick at a time
   │
SIGINT / SIGTERM ──▶ stop scheduler ──▶ server.close() ──▶ db.close()
```

Key consequences:

- **Migrations are part of opening the database.** There is no separate migrate command to forget. `openDb()` runs the full idempotent schema and migration set on every start.
- **The demo workspace is seeded once.** If any tenant exists, seeding is skipped. This makes restarts safe and makes an empty database immediately usable.
- **The report scheduler starts after the server is listening.** A slow first tick cannot delay accepting requests.
- **Shutdown is graceful, with a hard cap.** The scheduler stops, `server.close()` waits for in-flight requests (SSE streams can hold this open), the database handle closes, and a 3-second unref'd timer forces `process.exit(0)` if anything is still lingering. The PostgreSQL adapter sends a close message to its worker and terminates it.
- **`npm start` sets `NODE_ENV=production` in JavaScript** (`scripts/start.mjs`) so it behaves identically in PowerShell, `cmd.exe`, macOS, and Linux. `node server/index.js` remains available for development.

---

## 6. Configuration

Configuration is read once at boot by `createConfig(env)` in `server/config.js`. The loader is deliberately minimal: `KEY=value` lines, `#` comments, optional matching quotes, and no interpolation. **An existing environment variable always wins over `.env`**, which is what makes container and process-manager overrides predictable.

### Core

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables CSP, secure cookies by default, and sanitized 5xx messages. |
| `PORT` | `8787` | HTTP listen port. |
| `APP_ORIGIN` | unset | Canonical browser origin, e.g. `https://notes.example.com`. Added to the mutation origin allow-list. |
| `COOKIE_SECURE` | `true` in production | Set `0` only for plain-HTTP local or LAN use. |
| `SESSION_DAYS` | `30` | Session lifetime in days. |

### Storage

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/poca-note.db` | SQLite file, resolved against the project root. `:memory:` is supported for tests. |
| `DATABASE_URL` | unset | Presence switches the backend to PostgreSQL. |
| `DATABASE_SSL` | `false` | Use TLS to PostgreSQL (`rejectUnauthorized: false`, suitable for managed providers). |
| `DATABASE_TIMEOUT_MS` | `60000` | Connect, statement, and query timeout; floored at 5 s. |

### Demo seed

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEMO_TENANT_SLUG` | `acme` | Workspace address created when the database is empty. |
| `DEMO_TENANT_NAME` | `Acme Studio` | Display name. |
| `DEMO_TENANT_PASSWORD` | `poca-demo` | Owner password for the seeded workspace. |
| `SHOW_DEMO_CREDENTIALS` | `true` outside production | Exposes demo credentials through `/api/auth/config` and the login screen. |

### Registration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REGISTRATION_OPEN` | `true` | Allow self-service workspace creation. |
| `REGISTRATION_MAX_PER_HOUR` | `5` | Per-IP signup limit, floored at 1. |

### Reports

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPORTS_ENABLED` | `true` | Master switch for the scheduler. Manual reports still work. |
| `REPORTS_GRACE_MINUTES` | `120` | How late a scheduled report may still run after its send time. |
| `REPORTS_TICK_MS` | `60000` | Scheduler interval, floored at 10 s. |
| `REPORTS_DEFAULT_TIME` | `08:00` | Send time for new workspaces. |
| `REPORTS_DEFAULT_TIMEZONE` | `UTC` | IANA zone for new workspaces. |

### Link enrichment

| Variable | Default | Meaning |
| --- | --- | --- |
| `LINK_FETCH_TIMEOUT_MS` | `6000` | Per-request timeout, floored at 1 s. |
| `LINK_FETCH_MAX_BYTES` | `524288` | HTML read cap (512 KiB), floored at 16 KiB. |
| `ALLOW_PRIVATE_LINK_FETCH` | `false` | Disables SSRF private-address blocking. Only for trusted networks. |

### AI

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_PROVIDER` | `auto` | `auto`, `anthropic`, `ollama`, `openai`, or `offline`. |
| `AI_TIMEOUT_MS` | `90000` | Per-provider request timeout, floored at 5 s. |
| `ANTHROPIC_API_KEY` | unset | Enables the Anthropic adapter. |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5` | Model name sent to Anthropic. |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local Ollama base URL. |
| `OLLAMA_MODEL` | `qwen3.5:4b` | Local model name. |
| `OPENAI_BASE_URL` | unset | Any OpenAI-compatible `/chat/completions` base. |
| `OPENAI_API_KEY` | unset | Bearer token for that endpoint. |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model name. |

All numeric settings are clamped (`Math.max`/`Math.min`) so a typo cannot set a zero or negative interval. Invalid values fall back to the documented default rather than crashing the process.

---

## 7. Storage architecture

### 7.1 Backend selection

`openDatabase(config)` is the only place that decides which backend to use:

```
config.databaseUrl present?
  ├─ yes → openPostgresDatabase({ connectionString, ssl, timeoutMs })
  │        └─ apply POSTGRES_SCHEMA, then initializeTaskCounters(db)
  └─ no  → openDb(config.databasePath)
           └─ mkdir, DatabaseSync, PRAGMAs, migrate()
```

Both backends expose the same tiny synchronous surface:

```
db.exec(sql)
db.prepare(sql) → { run(...params), get(...params), all(...params) }
db.close()
```

That surface is `node:sqlite`'s API. Keeping it identical is what lets the entire domain layer (`board.js`, `auth.js`, `reports.js`, `actions.js`) stay backend-agnostic. The PostgreSQL adapter is therefore a *compatibility shim*, not a second data layer.

### 7.2 SQLite

SQLite is the default because it is a single file, requires no server, and is fast for the target workload. Opening it sets three pragmas:

| Pragma | Value | Reason |
| --- | --- | --- |
| `journal_mode` | `WAL` | Readers do not block the writer; better concurrent tab behavior. |
| `foreign_keys` | `ON` | Cascades actually run. The role-migration temporarily disables this. |
| `busy_timeout` | `5000` | Wait up to 5 s for a writer instead of failing immediately. |

The database directory is created if missing. The file is the unit of backup (`scripts/backup-sqlite.js` uses `VACUUM INTO` for a consistent snapshot).

### 7.3 PostgreSQL adapter

The domain layer is synchronous. `pg` is asynchronous. Rather than convert every query and every caller to `async`, the adapter runs the `pg` client in a **worker thread** and blocks the main thread until the result arrives:

```
main thread                              worker thread
───────────                              ─────────────
port.postMessage({ id, sql, params })
Atomics.wait(flag, 0, 0, timeoutMs) ──▶  client.query(sql, params)
                                         postMessage({ id, result })
Atomics.store / notify   ◀──────────────  Atomics.notify(flag)
receiveMessageOnPort(port) → result
```

Why this works: Node's main thread may block on `Atomics.wait`, while the worker thread remains free to run the event loop and complete the socket I/O. The `SharedArrayBuffer` is the wake-up flag; the `MessageChannel` carries the payload. A 2,000-iteration spin with `receiveMessageOnPort` handles the race between the notification and message delivery.

`convertSql()` translates the SQLite dialect the domain layer writes:

| SQLite construct | PostgreSQL translation |
| --- | --- |
| `?` placeholders | `$1`, `$2`, … (quote-aware) |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` |
| `WHERE x = ? COLLATE NOCASE` | `WHERE LOWER(x) = LOWER($1)` |
| `BEGIN IMMEDIATE` | `BEGIN` |
| `x IS ?` | `x IS NOT DISTINCT FROM $1` |
| `PRAGMA …;` | stripped |

The schema is written separately (`POSTGRES_SCHEMA`) rather than translated, because a few types and constraints differ: `REAL` becomes `DOUBLE PRECISION`, and case-insensitive uniqueness uses expression indexes on `LOWER(...)` instead of `COLLATE NOCASE`.

Operational notes:

- The connection is established during the constructor handshake (`SELECT 1`). A bad URL fails at boot, not on the first request.
- `statement_timeout` and `query_timeout` are set 1 s below `DATABASE_TIMEOUT_MS` so PostgreSQL reports its own timeout before the main thread gives up waiting.
- `bigint` and `numeric` parsers are overridden to return JavaScript numbers, matching SQLite's `COUNT`/`SUM` behavior.
- The adapter is single-connection and serialized. It is not a pool. This is acceptable for a small self-hosted team; it is the first thing to replace for high concurrency (see §20).
- A worker error or unexpected exit marks the adapter failed and wakes any waiter, so requests fail fast instead of hanging until timeout.

### 7.4 Schema catalogue

| Table | Scope | Purpose |
| --- | --- | --- |
| `tenants` | global | Workspace: slug, display name, legacy password hash, creation time. |
| `users` | tenant | Logins: unique `(tenant_id, username)`, scrypt hash, `owner`/`editor`/`observer`, last login. |
| `sessions` | tenant | Hashed session tokens, expiry, optional user link. |
| `tenant_state` | tenant | The monotonic board revision and the status check-in window (`update_interval_days`). |
| `dashboards` | tenant | Named boards with accent color and fractional order. |
| `cards` | tenant + dashboard | The Kanban card: column, position, title, notes, link, due date, priority, status, version, timestamps, soft-delete marker. |
| `checklist_items` | tenant + card | Subtasks with their own task number, status, done flag, and order. |
| `task_updates` | tenant + card/item | Dated status-change and note timeline. Records card, optional subtask, task number, author, kind (`status`/`note`), status snapshot, body, and time. |
| `task_numbers` | tenant | Claim table for allocated task numbers; the unique key is the collision guard. |
| `task_number_counters` | tenant + period | Next sequence per `YYMM` month. |
| `ai_runs` | tenant | Generated content history (brief, format, tone, provider, model, content). |
| `ai_action_runs` | tenant | Planned/applied action runs: prompt, source, status, plan JSON, result JSON, error. |
| `report_schedules` | tenant | Daily/weekly/monthly schedules with send time, weekday/day, timezone. |
| `report_settings` | tenant | Per-tenant report preferences and the timezone used by the reporting subsystem. |
| `reports` | tenant | Generated report: kind, period key, trigger, title, summary, Markdown content, metrics JSON, provider. |
| `link_titles` | global | URL-hash cache of fetched titles and site names (24 h TTL). |

Notable constraints:

- `cards.column_key` is `CHECK IN ('todo','doing','review','done')`; `cards.priority` is `CHECK IN ('low','normal','high')`.
- `cards.status` and `checklist_items.status` are `CHECK IN ('not_started','in_progress','blocked','done')`. Card status and column stay consistent: moving to Done sets status Done; leaving Done reopens to In progress (Doing, Under Review) or Not started (To Do); choosing Done moves the card to the Done column. A card in Under Review is in progress until it is signed off into Done. A subtask's Done status and checkbox mirror each other.
- `task_updates.kind` is `CHECK IN ('note','status')`. Status changes are logged automatically; written notes are explicit.
- `ai_action_runs.status` is `CHECK IN ('planned','applied','failed')`.
- `reports.trigger` is `CHECK IN ('scheduled','manual')`.
- A partial unique index `ux_reports_scheduled (tenant_id, schedule_id, period_key) WHERE trigger='scheduled'` makes scheduled generation idempotent at the database level.
- Partial unique indexes on `(tenant_id, task_no)` for cards and checklist items prevent duplicate numbers even if application logic races.

### 7.5 Migrations

Migrations are **forward-only and idempotent**, and run inside the normal open path:

| Migration | What it does |
| --- | --- |
| Base schema | `CREATE TABLE IF NOT EXISTS` for every table and index. |
| `migrateUsers` | Adds `sessions.user_id`, indexes it, and converts each legacy tenant password into an owner user. |
| `migrateUserRoles` | Rebuilds `users` when the old `owner`/`member` CHECK is present, mapping `member` → `editor`. SQLite cannot relax a CHECK in place. |
| `migrateDashboards` | Adds `cards.dashboard_id`, indexes it, creates a default board for every tenant, and assigns orphan cards to the oldest board. |
| `migrateTaskNumbers` | Adds `task_no` columns, creates claim/counter tables, adds unique indexes, and renumbers legacy rows once. |
| `migrateStatusTracking` | Adds `status` to cards and checklist items, seeds it from column/done state, adds `tenant_state.update_interval_days`, and creates `task_updates` with its indexes. |
| `migrateBoardColumns` | Rebuilds `cards` once when its CHECK predates the `review` column key, copying every row and recreating the card indexes. |
| `migrateReportSchedules` | Adds `reports.schedule_id`, rebuilds the scheduled-uniqueness index, and seeds schedules for existing tenants. |
| `dropLegacyDigestTables` | Drops `reminder_runs` and `reminder_settings` from the removed "Doing digest" feature. |

The legacy-drop migration is intentionally destructive: the feature is gone, and the tables could contain webhook URLs and message payloads that should not survive an upgrade.

### 7.6 Transactions

`withTx(db, fn)` wraps a function in `BEGIN IMMEDIATE` … `COMMIT`, rolling back on any throw. `BEGIN IMMEDIATE` acquires the write lock up front, which avoids the SQLite upgrade deadlock that can happen when a deferred transaction starts reading and later tries to write.

Transactions are used for anything that must be atomic:

- creating a card (allocate task number + insert + bump revision);
- patching a card (update + position normalization + bump revision);
- deleting/restoring/purging a card;
- creating a tenant (tenant row + state + default board + report settings + schedules + owner user);
- role migration;
- task renumbering;
- board deletion (move cards + delete board).

The revision bump happens **inside** the transaction, so a failed write cannot advance the change token.

### 7.7 Revision counter

```
tenant_state(tenant_id PRIMARY KEY, revision INTEGER, update_interval_days INTEGER, updated_at)
```

`bumpRevision` performs an upsert that inserts `2` for a new tenant (revision `1` is the initial state) or increments the existing value, then reads it back. Every mutation response includes the new revision. The SSE hub broadcasts `{ revision, at, clientId }`.

The contract is intentionally weak: **revision is a "something changed" signal, not a diff.** A client that sees a higher revision refetches `/api/board`. This keeps the server simple and makes out-of-order or missed events harmless — the next event or the 45-second poll will catch up.

`clientId` comes from the `x-client-id` header (a per-tab `sessionStorage` value). The hub includes it so a tab can ignore its own echo if it wants; the current client refreshes anyway, which is cheap and avoids divergent local state.

### 7.8 Task numbering

Every card and every checklist item gets a human-facing task number. The format is:

```
YYMM + 5-digit sequence          e.g. 261000001
 │      │
 │      └─ monthly sequence, zero-padded
 └──────── UTC year and month of creation
```

Properties:

- **Per workspace, per month.** Two workspaces can both have `261000001`.
- **UTC-based.** The period is derived from `created_at` in UTC, so the same row gets the same number regardless of server timezone.
- **Collision-safe.** Allocation inserts a row into `task_numbers` with `ON CONFLICT DO NOTHING`; only a successful insert wins. If the claim fails, the loop reads the counter again and retries. The counter is an optimization, not the source of truth.
- **Gap-tolerant.** A failed transaction can burn a sequence number. Numbers are unique and increasing, not necessarily contiguous.
- **Renumbered once on upgrade.** Legacy six-digit numbers are replaced by grouping all cards and checklist items by tenant and creation month. This is a one-time migration, not a runtime behavior.

Checklist items are numbered too, which is what makes AI actions like "mark subtask 261000014 done" unambiguous even when two cards have similar subtask text.

### 7.9 Ordering model

Cards and checklists use a `REAL position` with a spacing of `1000`:

- new items append at `MAX(position) + 1000`;
- a drop between two cards uses the midpoint, so most moves are a single `UPDATE`;
- if any adjacent gap falls below `0.001`, or a card changes column, the affected column is renumbered to `1000, 2000, 3000, …`.

This is the standard fractional-indexing trade-off: cheap moves, occasional normalization. The `REAL` type is preserved in PostgreSQL as `DOUBLE PRECISION`.

Boards themselves use the same idea (`dashboards.position`), though board reordering is not exposed in the current UI.

### 7.10 Trash model

Deletion is **soft** by default:

- `DELETE /api/cards/:id` sets `deleted_at` and increments `version`;
- trashed cards are excluded from `loadBoard`, reports, and performance series;
- `GET /api/trash` lists them with their checklist items;
- `POST /api/cards/:id/restore` clears `deleted_at`, normalizes positions, and bumps the revision;
- `DELETE /api/cards/:id/purge` permanently removes a card that is already trashed;
- `DELETE /api/trash` empties the trash for the workspace.

Checklist items cascade on card deletion. Restoring a card restores its checklist because the rows were never deleted.

### 7.11 Backup and retention

- `npm run db:backup` writes a consistent SQLite snapshot with `VACUUM INTO` into `data/backups/` (or `--out FILE`); with `DATABASE_URL` set it shells out to `pg_dump` instead. Managed PostgreSQL providers also offer their own snapshot tooling.
- There is no automatic retention policy. Reports, AI runs, and status updates grow without bound; a busy workspace should prune `reports`, `ai_runs`, `ai_action_runs`, and `task_updates` on a schedule appropriate to its audit needs.
- Link-title cache rows expire logically after 24 h and are refreshed on demand; stale rows are harmless.

### 7.12 Status check-ins

Cards and checklist items carry a four-value `status`: `not_started`, `in_progress`, `blocked`, `done`. Two rules keep the board coherent:

- A card in the Done column is always `done`; moving out of Done clears `completed_at` and reopens the status (`in_progress` for Doing and Under Review, `not_started` for To Do). Choosing `done` explicitly moves the card into the Done column, and choosing another status from Done moves it back to Doing. Moving work into Under Review marks it in progress, so it stays open in reports and dashboard counts until it reaches Done.
- A subtask's `done` checkbox and `status = 'done'` are the same fact. Checking it records Done; unchecking returns it to `not_started`.

`task_updates` is append-only. `patchCard` and `patchChecklistItem` insert a `kind='status'` row inside the same transaction whenever the effective status or column changes, so even a drag-and-drop leaves a trail. `POST /api/cards/:id/updates` and `POST /api/checklist/:id/updates` append `kind='note'` rows with the signed-in user's display name. These note writes touch `cards.updated_at` but deliberately do **not** bump `cards.version`, so posting an update from an open editor cannot trigger a false conflict.

The board payload embeds `updates` per card and per subtask plus the tenant's `update_interval_days` (default 3). The client marks any open, non-Done card or subtask whose latest update (falling back to its creation time) is older than that window as **Needs update**, shows a dismissible reminder banner, and offers a single check-in panel (`U`) listing every stale item with an inline status selector and note box.

---

## 8. Identity, tenancy, and authorization

### 8.1 Tenants

A tenant is the workspace boundary. It has a slug (`[a-z0-9][a-z0-9-]{1,48}`), a display name, a creation time, and a revision counter. Slugs are normalized from user input (spaces/underscores → hyphens, other characters stripped) and checked against a reserved list (`api`, `app`, `assets`, `auth`, `board`, `health`, `login`, `new`, `reports`, `settings`, `skills`, `static`, `trash`, `users`).

Uniqueness is case-insensitive: SQLite uses `COLLATE NOCASE`, PostgreSQL uses a unique index on `LOWER(slug)`.

### 8.2 Users and roles

A workspace can have many logins. Usernames are unique per tenant, case-insensitive, 2–32 characters (`[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}`).

| Role | Read | Write board/reports/AI | Manage teammates | Change report settings |
| --- | --- | --- | --- | --- |
| `owner` | yes | yes | yes | yes |
| `editor` | yes | yes | no | no |
| `observer` | yes | no | no | no |

Enforcement happens in three places:

1. **API-wide editor gate** — any non-`GET`/`HEAD`/`OPTIONS` request under `/api` requires `owner` or `editor` (`createRequireEditor`). This is why an observer cannot mutate anything even if a route forgets a check.
2. **Owner-only route middleware** — user management and report settings use `createRequireOwner`.
3. **UI affordances** — `canEdit(tenant)` hides quick capture, drag handles, delete actions, and the AI actions panel; `canAdmin(tenant)` gates teammate controls. The UI is a convenience, not the security boundary.

Invariants enforced by the domain layer:

- a workspace must keep at least one owner;
- you cannot remove your own login;
- the last board cannot be deleted;
- an owner cannot be demoted if they are the last owner.

### 8.3 Passwords

Passwords are hashed with Node's `scryptSync`:

```
scrypt$<16-byte hex salt>$<64-byte hex derived key>
```

Verification re-derives the key with the stored salt and compares with `crypto.timingSafeEqual`. The format is self-describing, so the work factor can be raised later by changing the prefix and adding a migration path. Passwords must be 8–200 characters.

### 8.4 Sessions

- A session token is 32 random bytes, base64url-encoded.
- Only `sha256(token)` is stored. A database leak does not yield usable cookies.
- Sessions expire after `SESSION_DAYS` (default 30). Expired sessions are deleted lazily when looked up.
- The cookie is `poca_session`, `httpOnly`, `SameSite=Lax`, `path=/`, `secure` when configured, with a matching `maxAge`.
- `Authorization: Bearer <token>` is also accepted, which makes scripted access possible without cookie handling.
- Sessions created before per-user logins resolve to the workspace's oldest owner and are backfilled with that user id on first lookup.

### 8.5 Registration

Self-service signup creates the tenant, its state, its default board, its report settings and schedules, and its owner login in one transaction. Validation:

- registration must be open;
- slug must match the workspace pattern and not be reserved;
- slug must not already exist (application check plus unique constraint);
- username must match the user pattern;
- password must be 8–200 characters.

The response sets the session cookie immediately, so the user lands signed in. Signup is rate-limited per IP.

### 8.6 HTML gate

In production the SPA is served by Express, so the server can redirect before the app loads:

- `/login` with a valid session → `302 /board`;
- any other protected HTML route without a session → `302 /login?next=<encoded path>`;
- `/` is always public (landing page).

In development Vite serves the SPA, so the client-side guard in `App.jsx` performs the same redirects. The server gate remains the authority in production.

### 8.7 Authorization matrix (routes)

| Route group | Method | Required role |
| --- | --- | --- |
| `/api/auth/config`, `/register`, `/login`, `/logout` | any | public |
| `/api/auth/me` | GET | any session |
| `/api/board`, `/cards` (GET), `/trash` (GET), `/dashboards` (GET), `/reports` (GET), `/ai/status`, `/ai/runs`, `/ai/actions` (GET) | GET | any session |
| `/api/cards`, `/checklist`, `/trash` (DELETE), `/ai/generate`, `/ai/actions/*`, `/ai/brief`, `/reports` (POST) | mutation | owner or editor |
| `/api/users/*` | any | owner |
| `/api/reports/settings` | PUT | owner |
| `/api/reports/schedules` | mutation | owner or editor |
| `/api/link-title` | GET | any session |

---

## 9. Board domain

### 9.1 Card shape

```json
{
  "id": "uuid",
  "taskNo": "261000001",
  "dashboardId": "uuid",
  "column": "todo",
  "position": 1000,
  "title": "Ship the architecture doc",
  "notes": "Markdown notes up to 20,000 characters",
  "linkUrl": "https://example.com",
  "linkTitle": "Example",
  "dueDate": "2026-11-03",
  "priority": "normal",
  "status": "in_progress",
  "version": 3,
  "createdAt": "2026-11-03T09:00:00.000Z",
  "updatedAt": "2026-11-03T09:05:00.000Z",
  "completedAt": null,
  "lastUpdateAt": "2026-11-03T09:05:00.000Z",
  "updates": [
    {
      "id": "uuid",
      "kind": "status",
      "status": "in_progress",
      "author": "Ada Lovelace",
      "body": "Moved to Doing",
      "createdAt": "2026-11-03T09:05:00.000Z"
    }
  ],
  "deletedAt": null,
  "checklist": [
    {
      "id": "uuid",
      "taskNo": "261000002",
      "text": "Draft outline",
      "done": false,
      "status": "not_started",
      "position": 1000,
      "lastUpdateAt": "2026-11-03T09:00:00.000Z",
      "updates": []
    }
  ]
}
```

### 9.2 Validation

| Field | Rule |
| --- | --- |
| `title` | Required, trimmed, max 500 characters. |
| `notes` | Max 20,000 characters. |
| `linkUrl` | Must parse as `http:` or `https:`, max 2,000 characters. |
| `linkTitle` | Max 500 characters. |
| `dueDate` | `YYYY-MM-DD`, must be a real calendar date; normalized to date-only. |
| `priority` | `low`, `normal`, `high`. |
| `column` | `todo`, `doing`, `review`, `done`. |
| `status` | `not_started`, `in_progress`, `blocked`, `done`; card Done always lives in the Done column. |
| `position` | Finite number; otherwise appended. |
| checklist `text` | Required, max 500 characters. |
| update `body` | Required, trimmed, max 4,000 characters. |

Invalid input throws `HttpError(400, message)`, which the error handler turns into `{ error: "bad_request", message }`.

### 9.3 Optimistic concurrency

`patchCard` requires an integer `version`. If it does not match the stored version, the server responds:

```json
HTTP 409
{
  "error": "conflict",
  "message": "This card changed on another device.",
  "card": { "...current card..." },
  "revision": 42
}
```

The client replaces its local copy with `error.data.card`, updates the revision, and shows a non-blocking toast. This is last-write-wins with a **detected** conflict, not a merge: the user sees the current state and can reapply their intent.

The version increments on every card write, including soft delete, restore, checklist changes (which touch the parent card), and AI actions. The one deliberate exception is appending a written `task_updates` note: it refreshes `updated_at` and `lastUpdateAt` but leaves `version` alone, so posting a note from an open card editor does not manufacture a conflict. Status changes still go through the normal card/subtask patch path and bump the version.

### 9.4 Column transitions

Moving a card to `done` sets `completed_at` to now. Moving it out of `done` clears `completed_at`. This timestamp is the basis for completion metrics in reports and charts; it is not derived from `updated_at`, so unrelated edits do not distort throughput.

When a card changes column, the source column is renumbered if needed. If no position is supplied, the card appends to the destination column.

### 9.5 Checklist items

Checklist items are first-class rows with their own task numbers. Adding, patching, or deleting one:

1. validates the item and its parent card belong to the session tenant;
2. updates the item;
3. increments the parent card's `version` and `updated_at` (via `touchCard`);
4. bumps the tenant revision.

That means a checklist change is a board change: other tabs refresh, and a concurrent card edit can conflict. The alternative — a separate checklist revision — was rejected as unnecessary complexity for this product.

### 9.6 Board read model

`loadBoard` returns everything a board view needs in one round trip:

```json
{
  "revision": 42,
  "dashboardId": "uuid-or-null",
  "cards": [ "...cards with checklist..." ],
  "trashCount": 3,
  "serverTime": "2026-11-03T09:00:00.000Z"
}
```

It performs three queries: cards for the tenant (optionally scoped to a dashboard), checklist items joined to non-deleted cards, and a trash count. Grouping happens in memory. This is intentionally not paginated: a personal or small-team board is expected to fit comfortably in memory, and a single payload makes the optimistic client simple.

### 9.7 Board stats

`boardStats` aggregates counts by column and priority plus completion rate. It is used by the reports layer and by dashboard counts; the board UI computes its own counts from the loaded cards to avoid an extra request.

---

## 10. Dashboards

A workspace starts with one board named "My board" with the `emerald` accent. Users can create more, rename them, change their accent, and delete them.

- **Create** validates a non-empty name (max 80 characters) and an accent from the supported list, appends at `MAX(position) + 1000`, and bumps the revision.
- **Patch** updates any subset of name, accent, and position.
- **Delete** moves all cards — including trashed ones — to the oldest remaining board, then deletes the board row. The last board cannot be deleted. This is a deliberate "never destroy work" choice; a board delete is a reorganization, not a data loss event.
- **Resolve** (`resolveDashboardId`) maps an optional requested id to a valid board for the tenant, falling back to the oldest board. Every card write and board read goes through it, so a stale URL or a deleted board cannot produce cross-tenant access or orphan cards.

Accents are a fixed vocabulary (`emerald`, `amber`, `orange`, `green`, `gold`, `violet`, `cyan`, `rose`, `sky`) mapped to CSS classes. The dashboard accent colors the sidebar entry, the page kicker, and the board's visual identity.

---

## 11. HTTP interface

### 11.1 Middleware pipeline

Order matters; this is the actual sequence in `createApp`:

```
1.  app.disable("x-powered-by")
2.  securityHeaders(config)              nosniff, frame deny, referrer, permissions, CSP in prod
3.  express.json({ limit: "256kb" })     JSON body parsing
4.  originGuard(config)                  reject cross-origin mutations
5.  mountAuthRoutes(...)                 /api/auth/* mounted BEFORE auth middleware
6.  app.use("/api", requireTenant)       cookie/bearer → req.tenant + req.user
7.  app.use("/api", editor gate)         non-GET requires owner/editor
8.  mountUserRoutes, mountBoardRoutes, mountLinkRoutes,
    mountAiRoutes, mountReportRoutes, mountEventRoutes
9.  GET /api/health
10. app.use("/api", 404 JSON)
11. express.static(webDist, { index: false })
12. GET /, /board, /skills, /reports, /login (HTML gate where needed)
13. app.use(404 text)
14. error handler (JSON)
```

Two details are easy to get wrong:

- **Auth routes are mounted before the session middleware** because login and registration must be reachable without a session. `/api/auth/me` applies `requireTenant` itself.
- **The editor gate is global, not per-route.** Observers are blocked from every mutation by one middleware. Individual routes do not need to repeat the check, though owner-only routes add a stricter one.

### 11.2 Route map

#### Auth

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/config` | App name, demo credentials (if enabled), registration flag. |
| POST | `/api/auth/register` | Create workspace + owner, set session. |
| POST | `/api/auth/login` | Workspace + username + password → session. |
| POST | `/api/auth/logout` | Delete session, clear cookie. |
| GET | `/api/auth/me` | Current tenant and user. |

#### Board and cards

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/board?dashboardId=` | Cards, checklist, revision, trash count. |
| GET | `/api/dashboards` | Boards with per-column counts. |
| POST | `/api/dashboards` | Create a board. |
| PATCH | `/api/dashboards/:id` | Rename, recolor, reorder. |
| DELETE | `/api/dashboards/:id` | Move cards to the oldest board, delete. |
| GET | `/api/trash` | Soft-deleted cards. |
| DELETE | `/api/trash` | Empty the trash. |
| POST | `/api/cards` | Create a card. |
| GET | `/api/cards/:id` | One card. |
| PATCH | `/api/cards/:id` | Update with version check. |
| DELETE | `/api/cards/:id` | Soft delete. |
| POST | `/api/cards/:id/restore` | Restore from trash. |
| DELETE | `/api/cards/:id/purge` | Permanently delete. |
| POST | `/api/cards/:id/checklist` | Add a subtask. |
| PATCH | `/api/checklist/:id` | Toggle or rename a subtask. |
| DELETE | `/api/checklist/:id` | Delete a subtask. |

#### Users

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/users` | Teammates, current user, `canManage`. |
| POST | `/api/users` | Add a teammate (owner). |
| PATCH | `/api/users/:id` | Change display name, password, or role (owner). |
| DELETE | `/api/users/:id` | Remove a teammate (owner). |

#### AI

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ai/status` | `{ ready, mode, formats, tones, lengths }`. Provider names stay server-side. |
| GET | `/api/ai/runs?limit=` | Content history (1–50, default 20). |
| POST | `/api/ai/generate` | Brief → Markdown; persists `ai_runs`. |
| GET | `/api/ai/actions` | Action run history. |
| GET | `/api/ai/actions/:id` | One action run. |
| POST | `/api/ai/actions/plan` | Natural language → validated plan; persists a planned run. |
| POST | `/api/ai/actions/apply` | Apply a saved `runId` or an inline plan. |
| POST | `/api/ai/brief` | Generate a one-minute report with narrative. |

#### Reports

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/reports?kind=&limit=` | Reports, latest, counts, settings, schedules. |
| GET | `/api/reports/latest` | Latest report per kind + counts + settings. |
| GET | `/api/reports/performance?range=&dashboardId=` | Bucketed created/completed/backlog series. |
| GET | `/api/reports/settings` | Per-tenant report settings. |
| PUT | `/api/reports/settings` | Update settings (owner). |
| GET | `/api/reports/schedules` | Schedules + settings. |
| POST | `/api/reports/schedules` | Create a schedule. |
| PATCH | `/api/reports/schedules/:id` | Update a schedule. |
| DELETE | `/api/reports/schedules/:id` | Delete a schedule. |
| POST | `/api/reports` | Generate a report now (rate-limited). |

#### Utility

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/link-title?url=` | Fetch and cache a page title. |
| GET | `/api/events` | SSE stream. |
| GET | `/api/health` | Liveness with tenant slug and server time. |

### 11.3 Error model

Domain code throws `HttpError(status, message, details)`. The terminal error handler maps it to:

```json
{
  "error": "conflict",
  "message": "This card changed on another device.",
  "card": { "...": "..." },
  "revision": 42
}
```

| Status | `error` code | Typical cause |
| --- | --- | --- |
| 400 | `bad_request` | Validation failure, nothing to update, unknown action type. |
| 401 | `unauthorized` | Missing or expired session; invalid credentials. |
| 403 | `forbidden` | Observer mutation, non-owner admin action, blocked origin. |
| 404 | `not_found` | Missing card, user, plan, or API route. |
| 409 | `conflict` | Stale card version, duplicate workspace/username, already-applied plan. |
| 422 | `invalid_target` | Link fetch refused (private address, timeout, too many redirects). |
| 429 | `rate_limited` | Fixed-window limit exceeded. |
| 5xx | `server_error` | Unhandled error; message is replaced in production. |

`details` is spread into the payload, which is how the 409 carries the current card and revision. Unhandled errors are logged with a stack trace and never leak internals to production clients.

### 11.4 Rate limiting

`createRateLimiter` is a fixed-window in-memory limiter. It sets `Retry-After` and returns the standard rate-limit payload. Buckets are pruned opportunistically when the map exceeds 5,000 entries.

| Limiter | Window | Max | Key |
| --- | --- | --- | --- |
| Login | 60 s | 10 | `ip + workspace slug` |
| Register | 60 min | `REGISTRATION_MAX_PER_HOUR` | `ip` |
| Link title | 60 s | 40 | `tenant` (or IP before auth) |
| AI | 60 s | 10 | `tenant` |
| Reports | 60 s | 12 | `tenant` |

The limiter is per process. With multiple Node processes behind a load balancer, each process has its own buckets; use a shared store if that matters. For the intended single-process deployment it is sufficient.

### 11.5 Security controls

| Control | Implementation |
| --- | --- |
| Clickjacking | `x-frame-options: DENY`, `frame-ancestors 'none'`. |
| MIME sniffing | `x-content-type-options: nosniff`. |
| Referrer leakage | `referrer-policy: strict-origin-when-cross-origin`. |
| Device permissions | `permissions-policy: camera=(), microphone=(), geolocation=()`. |
| CSP (production) | `default-src 'self'`, `script-src 'self'`, inline styles allowed, images from self/data/https, connections self. |
| CSRF | `SameSite=Lax` cookie plus an origin guard on every non-GET request. |
| Body size | JSON capped at 256 KiB. |
| Session theft | httpOnly cookie, hashed tokens, expiry, secure flag in production. |
| SQL injection | Parameterized queries everywhere; identifiers are fixed strings, never user input. |
| Tenant isolation | `tenant_id` from session in every data query. |
| SSRF | Link fetch resolves DNS and rejects loopback, private, link-local, multicast, and internal hosts; redirects are re-checked; response size and time are capped. |
| Model output | Rendered as sanitized Markdown (HTML escaped); never inserted into the DOM as raw HTML. |
| Action execution | Model proposals are validated against the live board; unknown cards become failures, not guesses. |

### 11.6 SPA delivery

`express.static` serves hashed Vite assets with a one-hour cache in production. `index.html` is sent with `cache-control: no-store` so a new deploy is picked up immediately. The HTML routes explicitly serve the same file:

- `/` — public landing page;
- `/board`, `/skills`, `/reports` — gated;
- `/login` — gated (redirects to `/board` when already signed in).

If `web/dist/index.html` is missing, the server responds `503` with a message telling the operator to run `npm run build` or `npm run dev`. This is a common first-run failure and is handled with a human-readable message rather than a stack trace.

---

## 12. Realtime synchronization

`server/services/events.js` is a small in-process SSE hub:

- clients are stored in a `Set` with their `tenantId` and response object;
- `publish(tenantId, payload)` writes only to clients in that tenant;
- a 25-second heartbeat writes `: heartbeat\n\n` to keep proxies from closing idle streams;
- the heartbeat interval is created lazily when the first client subscribes and cleared when the last leaves;
- the interval is `unref()`ed so it cannot keep the process alive during shutdown.

`GET /api/events` sets `text/event-stream`, disables caching and buffering (`x-accel-buffering: no` for nginx), flushes headers, sends:

```
retry: 3000

event: ready
data: {"revision":42,"serverTime":"..."}

event: revision
data: {"revision":43,"at":"...","clientId":"..."}
```

and unsubscribes on `close` and `error`.

**Delivery guarantees.** SSE here is best-effort. If a client misses an event, it still has three other catch-up paths: the 45-second visibility/poll timer, the `online` event, and any explicit refresh. The hub does not replay history. That is a deliberate simplification: replay would require an event log and per-client cursors, which is not justified when a board fetch is cheap.

**Multi-instance caveat.** The hub is in-process. Two Node processes behind a load balancer will not see each other's events. The polling fallback makes this tolerable, but true multi-instance realtime requires a shared pub/sub layer (see §20).

---

## 13. AI subsystem

The AI subsystem has three independent jobs, all optional:

1. **content generation** — brief → formatted Markdown (Skills page);
2. **action planning** — natural language → validated board mutations (AI actions menu);
3. **report narrative** — board snapshot → a short prose summary inserted into a report.

### 13.1 Provider chain

`generateText` builds an ordered list of providers and tries them in sequence:

```
AI_PROVIDER=auto (default)
  ├─ anthropic   if ANTHROPIC_API_KEY is set
  ├─ ollama      if the local probe succeeds
  ├─ openai      if OPENAI_BASE_URL and OPENAI_API_KEY are set
  └─ offline     always available (returns content: null)

AI_PROVIDER=anthropic | ollama | openai | offline
  └─ exactly one provider; failures do not fall through
```

In `auto` mode, a failed provider is recorded in `attempts` and the next one is tried. In explicit mode, the first failure aborts with a `502` that includes the attempted provider and error. This distinction matters: an operator who pins `AI_PROVIDER=anthropic` wants to know that Anthropic failed, not silently receive an offline template.

**Ollama probing.** `probeOllama` calls `/api/tags` with a 1.5-second timeout and caches the result for 15 seconds per URL. The probe is what makes `auto` practical: a machine without a local model does not pay a long connection timeout on every request.

**Adapters.** Anthropic uses `/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`; Ollama uses `/api/chat` with `think: false` (Qwen 3.5 otherwise spends the token budget on reasoning and returns empty content); OpenAI-compatible uses `/chat/completions` with a bearer token. All adapters strip a surrounding Markdown code fence, reject empty responses, and use `AbortSignal.timeout`.

**Offline fallback.** `generateContent` returns a deterministic template when the chain resolves to `offline`: a title derived from the brief, a summary, key points extracted from sentences, suggested next steps, and open questions. It is labeled as an offline preview. The product remains useful with no model configured.

### 13.2 Content generation

Input: `brief` (10–8,000 characters), `format`, `tone`, `length`.

| Dimension | Values |
| --- | --- |
| Format | `brief`, `summary`, `email`, `social`, `notes`, `plan` |
| Tone | `practical`, `warm`, `direct`, `playful`, `formal` |
| Length | `short` (<200 words), `medium` (300–500), `long` (700–1,000) |

`buildPrompt` combines the brief with a format instruction, a tone instruction, a length instruction, and hard requirements: one H1, Markdown only, no invented facts, `[placeholders]` for unknowns, concrete language. The system prompt reinforces the same rules and tells the model not to wrap the whole answer in a fence.

Successful output is persisted to `ai_runs` with provider and model. The UI shows the generated Markdown and the last 12 runs. `GET /api/ai/status` deliberately exposes only `ready`/`mode` and the allowed enum values; provider names and model ids stay server-side.

### 13.3 Action planning

`planActions` is a **cascade**, not a single model call:

```
1. Rules planner
   ├─ split the request into clauses (newlines, semicolons, action verbs, quoted titles)
   ├─ parse dates ("tomorrow", "next friday", "Nov 3"), priorities, columns
   ├─ resolve card references by task number, exact title, or fuzzy title score
   └─ if any actions were produced → return source: "rules"

2. LLM planner (only if rules produced nothing)
   ├─ send the current board summary + today's date + the request
   ├─ require strict JSON: { summary, actions: [...] }
   ├─ normalize each action against the live board (resolve card by id/task no/title)
   └─ cap at 20 actions; unresolved references become warnings

3. Offline template
   └─ deterministic plan derived from the same parsing rules
```

The rules-first design is deliberate. Most board requests are simple and deterministic ("move 261000001 to doing", "add a subtask to the docs card", "complete the invoice task"). A regex/parser handles those instantly, with no token cost and no hallucination risk. The model is reserved for requests the rules cannot structure.

Supported action types:

| Type | Effect |
| --- | --- |
| `create` | Create a card, optionally with checklist items. |
| `update` | Patch title, notes, due date, priority, column. |
| `complete` | Move a card to `done`. |
| `delete` | Soft delete a card. |
| `subtask` | Add a checklist item. |
| `subtask_complete` | Mark a checklist item done. |
| `subtask_update` | Rename a checklist item. |
| `subtask_delete` | Delete a checklist item. |

Each planned action carries enough context to be re-validated later: card id, task number, card title, and the card version observed at plan time.

### 13.4 Plan application

`applyPlan` executes actions in order and **re-validates every one against the live board**:

- a card that no longer exists fails with "That card no longer exists";
- an unresolved reference fails with a readable message;
- the first write to a card enforces the version captured at plan time;
- subsequent writes to the same card in the same plan use the version produced by the previous action, so "add a subtask, then complete it" works;
- one action failing does not abort the rest — the result reports `applied`, `failed`, `partial`, and a per-action list.

Each underlying write bumps the tenant revision, and the final result returns the current revision. The route publishes one SSE event after the whole plan, not one per action, to avoid a refresh storm.

Plans are persisted in `ai_action_runs` with status `planned`, `applied`, or `failed`. Applying a saved run that is already `applied` returns `409`. This prevents a double-click or a retry from applying the same plan twice.

### 13.5 Report narrative

`generateReport` first builds a deterministic Markdown report from a board snapshot. If narrative is enabled, it asks the model for a short prose summary and inserts it after the bold summary line. If no model is available, the report is still complete and useful — the narrative is an enhancement, not a dependency. The provider name is stored on the report row when narrative was used.

### 13.6 Failure behavior and privacy

- **No provider configured** → offline content or rules/offline plans; the UI tells the user it is an offline preview.
- **Provider timeout or error** → `auto` falls through; explicit mode returns `502` with the attempt list.
- **Model returns invalid JSON** for a plan → the plan is discarded and the offline template is used.
- **Model references a missing card** → that action fails; nothing is guessed.
- **Data sent to a provider** → the brief, the current board summary (titles, task numbers, columns, due dates, priorities, notes for planning), and the report snapshot. Workspace names and user identities are not sent. Operators who cannot send board data to a third party should use Ollama or `AI_PROVIDER=offline`.

---

## 14. Reports subsystem

### 14.1 Kinds and periods

| Kind | Period | Key | Typical content |
| --- | --- | --- | --- |
| `daily` | Yesterday through today | `YYYY-MM-DD` (today) | Overdue, due today, carryover, completed today, high priority, board stats. |
| `weekly` | Previous 7 complete days | Start date `YYYY-MM-DD` | Completed this week, added this week, carried over, overdue. |
| `monthly` | Previous calendar month | `YYYY-MM` | Completed, created, carryover, priorities, stats. |
| `brief` | Today's daily window | Daily key | A short factual snapshot readable in under a minute. |

Period boundaries are computed in the workspace's timezone, not the server's. `localTimeParts` and `localDateOf` convert ISO timestamps to local calendar dates so "completed today" means the user's today.

### 14.2 Snapshot

`boardSnapshot` loads all non-deleted cards for the tenant and computes:

- counts by column, total, open count, completion rate;
- pending from yesterday (open cards created before today);
- overdue (open, due date before today);
- due today and due within seven days;
- stale (open, not updated in seven days);
- high-priority open;
- created and completed within the period;
- completed today;
- checklist totals and trash count.

List sections are capped at 14 cards with an "…and N more" line, so a large board does not produce an unreadable report.

### 14.3 Deterministic content

Each kind has a Markdown builder (`dailyMarkdown`, `weeklyMarkdown`, `monthlyMarkdown`, `briefMarkdown`). They share helpers for escaping Markdown, formatting a card line with column/due/priority metadata, rendering a section or "_Nothing here._", and a stats table. The deterministic report is always generated first; narrative is inserted into it afterward.

### 14.4 Persistence and idempotency

A report row stores title, summary, full Markdown content, and a metrics JSON blob (period, counts, overdue, due today, completion rate, checklist, trash). Metrics are stored separately so charts and dashboards can read numbers without parsing Markdown.

Scheduled reports use `INSERT OR IGNORE` plus the partial unique index on `(tenant_id, schedule_id, period_key)`. If two scheduler ticks race, or a process restarts mid-tick, only one report is created. The loser returns `{ duplicate: true, report }`.

### 14.5 Scheduler

`startReportScheduler` runs `processScheduledReports` every `REPORTS_TICK_MS` (default 60 s), with a `running` guard so ticks never overlap. For each enabled schedule:

1. compute the local date, weekday, and minutes since midnight;
2. check the schedule is due today (daily always, weekly on its weekday, monthly on its day);
3. check the send time has passed but is within `REPORTS_GRACE_MINUTES`;
4. compute the period key and skip if a scheduled report already exists;
5. generate the report, catching per-schedule errors so one bad workspace does not stop the rest.

The scheduler also ensures every tenant has daily/weekly/monthly schedules. New tenants get them at creation; existing tenants get them on the first tick after an upgrade.

### 14.6 Performance series

`performanceSeries` produces chart-ready buckets:

- daily: last 14 days;
- weekly: last 8 weeks, Monday-start;
- monthly: last 6 months.

Each bucket has `created`, `completed`, and `backlog` counts. Totals include created, completed, net, open, done, total, and completion rate; breakdowns cover column, priority, and dashboard. The series is scoped to one board when `dashboardId` is supplied.

### 14.7 Settings and schedules

`report_settings` holds the timezone and legacy daily/weekly/monthly preferences. `report_schedules` is the current model: each row has a kind, enabled flag, send time, weekday/day-of-month, timezone, and label. The UI edits schedules individually; settings remain for compatibility and for the timezone used by the whole reporting subsystem.

---

## 15. Link title enrichment

When a user pastes a URL into a card, the client may ask `GET /api/link-title?url=…` to fill the title. The service is deliberately conservative:

1. **Validate** the URL is `http:`/`https:` and at most 2,000 characters.
2. **Cache** by `sha256(url)` for 24 hours in `link_titles`.
3. **Resolve and check** the hostname: reject `localhost`, `*.localhost`, `*.internal`, and any IP in loopback, private, link-local, CGNAT, multicast, or IPv6 unique-local ranges. DNS is resolved with `all: true` and every address is checked.
4. **Fetch manually** with `redirect: "manual"`, a 6-second timeout, a browser-like user agent, and an HTML `Accept` header. Each redirect is re-checked, up to 4 hops.
5. **Read at most 512 KiB** of the body, canceling the stream when the cap is reached.
6. **Extract** `og:title`, `twitter:title`, `<meta name="title">`, or `<title>`, plus `og:site_name` or the hostname. HTML tags and entities are cleaned.
7. **Store** the result and return `{ url, finalUrl, title, siteName, cached }`.

`ALLOW_PRIVATE_LINK_FETCH=1` disables step 3 for trusted networks (for example, an internal wiki). It should not be enabled on a public deployment.

---

## 16. Frontend architecture

### 16.1 Boot and routing

`web/src/main.jsx` mounts `<App />` into `#root` inside React Strict Mode. `App.jsx` implements a small history-based router without a routing library:

- `KNOWN_PATHS = { "/", "/board", "/skills", "/reports", "/login" }`;
- unknown paths normalize to `/board`;
- `navigate(path)` pushes or replaces history and updates state;
- `popstate` restores the route;
- a `poca:unauthorized` window event (dispatched by the API client on 401) clears the session and redirects to `/login`.

On mount, `GET /api/auth/me` decides between three states: loading (splash), signed out (landing or login), signed in (board, skills, or reports). The route is kept consistent with the session: a signed-in user on `/login` goes to `/board`; a signed-out user on a protected route goes to `/login`; `/` shows the landing page when signed out.

### 16.2 API client

`web/src/api.js` is intentionally tiny:

- `clientId` is a per-tab UUID stored in `sessionStorage` (falling back to a random string), sent as `x-client-id` on every request;
- `api(path, { method, body, headers, signal })` sends same-origin credentials, JSON-encodes the body, and parses JSON or text;
- non-2xx responses throw `ApiError(status, data)`, preserving the server's `error`, `message`, and any details (notably the 409 card);
- a 401 dispatches `poca:unauthorized` so the app can redirect without every caller handling it.

### 16.3 State model

There is no global store. State is owned by the page that needs it:

| Hook | Owns |
| --- | --- |
| `useBoard(tenant, { dashboardId, onConflict })` | cards, revision, trash count, sync metadata, all card mutations. |
| `useDashboards(tenant, { revision })` | board list, create/rename/recolor/delete, reload on revision. |
| `useTheme()` | light/dark preference, persisted in `localStorage`, applied to `documentElement.dataset.theme`. |
| `useToasts()` | a small toast queue with timers and actions. |

Page components hold their own modal, search, and selection state. This keeps re-renders local and makes the data flow easy to follow: one hook per server resource, one component tree per route.

### 16.4 Synchronization layers

`useBoard` is the most important hook. It combines five layers:

1. **localStorage cache** — `poca-note:board:<slug>:<dashboardId>` stores `{ revision, cards, savedAt }`. On mount, the cache renders immediately, then a quiet refresh reconciles. This is what makes the app feel instant on a reload.
2. **Initial fetch** — `GET /api/board?dashboardId=…` replaces the cache and clears the "cached" flag.
3. **SSE** — `EventSource("/api/events")` listens for `ready` and `revision`. A higher revision triggers a quiet refresh. An `error` marks the UI offline.
4. **BroadcastChannel** — `poca-note:<slug>` lets tabs in the same browser notify each other. A message from another `clientId` with a higher revision triggers a quiet refresh. This covers the case where SSE is blocked but the tabs share an origin.
5. **Visibility polling** — every 45 seconds while visible, on `visibilitychange`, and on the browser `online` event, the hook refreshes quietly. This is the safety net for missed events and sleeping laptops.

Refreshes are quiet and replace the whole card list with the server's response. The hook keeps a `pendingRef` counter intended to suppress a refresh while a write is in flight; in the current implementation mutations reconcile their own responses and the counter is not incremented, so a refresh that started before a write can still land afterwards. Because every response carries the server's current revision, the next SSE event or poll converges the state. The sync metadata (`loading`, `syncing`, `offline`, `cached`, `lastSync`) drives the top-bar indicator and the offline banner.

### 16.5 Optimistic writes and conflict handling

`updateCard` is the canonical example:

```
1. Find the previous card locally.
2. Commit a merged copy immediately (same revision) → UI updates.
3. PATCH with { ...patch, version: previous.version }.
4. On success: commit the server card and the new revision; notify other tabs.
5. On 409: commit the server's current card and revision; call onConflict; return { conflict: true }.
6. On other errors: roll back to the previous card and rethrow.
```

Create, delete, restore, purge, checklist add/toggle/delete, and empty-trash follow the same shape. Move is `updateCard(id, { column, position })`, so drag-and-drop gets the same conflict semantics.

The conflict UX is deliberately non-destructive: the local change is replaced by the server's truth and the user is told "That card changed elsewhere — the latest version is loaded." They can then reapply. There is no automatic merge, because merging free-text notes and titles is not well-defined.

### 16.6 Component map

| Component | Responsibility |
| --- | --- |
| `App.jsx` | Session bootstrap, route normalization, landing/login/board/skills/reports switch. |
| `LandingPage.jsx` | Public marketing surface with sign-in and sign-up entry points. |
| `LoginPage.jsx` | Workspace + username + password form; reads `/api/auth/config` for demo credentials and registration state. |
| `BoardPage.jsx` | Board composition: sidebar, top bar, page header, AI actions, quick capture, columns, modals, keyboard shortcuts, reports strip. |
| `Sidebar.jsx` | Brand, route navigation, board list, create/select board, settings, trash. |
| `TopBar.jsx` | Search, sync indicator, trash, reports, help, settings, account menu. |
| `Board.jsx` | Three columns, drag-and-drop, per-column composer, drop indicators. |
| `Card.jsx` | Card face: title, task number, due date, priority, link, checklist progress, selection state. |
| `CardModal.jsx` | Full card editor: title, notes, link (with title lookup), due date, priority, checklist, delete. |
| `QuickCapture.jsx` | One-line capture focused by `n`. |
| `AIActionsMenu.jsx` | Prompt → plan preview → apply; status and history. Lives in the board header's top-right actions. |
| `SkillsPage.jsx` | Brief, format/tone/length controls, generated Markdown, run history, copy/download. |
| `ReportsPage.jsx` | Latest reports, report history, performance charts, schedule editor. |
| `ReportsModal.jsx` | Generate and read a report without leaving the board; renders Markdown. |
| `PerformanceCharts.jsx` | Created/completed/backlog charts from the performance series. |
| `SchedulesEditor.jsx` | Create, edit, enable/disable, and delete report schedules. |
| `SettingsModal.jsx` | Board management, teammate management, theme, logout. |
| `TrashDrawer.jsx` | Trashed cards with restore, purge, and empty-trash. |
| `ShortcutsModal.jsx` | Keyboard reference. |
| `Modal.jsx` | Shared focus trap, escape handling, backdrop. |
| `Markdown.jsx` | Safe Markdown → HTML for AI output and reports. |
| `Toasts.jsx` | Transient success/error/info messages with optional action. |

### 16.7 Keyboard model

Shortcuts are registered on `window` in `BoardPage` and suppressed when the user is typing in an input, textarea, select, contenteditable, or when any modal is open. Observers are blocked from destructive shortcuts.

| Key | Action |
| --- | --- |
| `n` | Focus quick capture. |
| `/` | Focus search. |
| `j` / `ArrowDown` | Select next card. |
| `k` / `ArrowUp` | Select previous card. |
| `h` / `ArrowLeft` | Move selection left one column. |
| `l` / `ArrowRight` | Move selection right one column. |
| `Enter` | Open the selected card. |
| `1` / `2` / `3` / `4` | Move selected card to To Do / Doing / Under Review / Done. |
| `c` | Move selected card to Done. |
| `d` / `Delete` | Soft-delete selected card. |
| `t` | Open trash. |
| `b` | Open the daily report. |
| `g` | Open the brief report. |
| `s` | Open settings. |
| `?` | Open the shortcuts modal. |
| `Cmd/Ctrl + Enter` (Skills) | Generate content. |

Selection is column-aware: moving down past the end of a column wraps to the next column, so `j` walks the whole board in reading order.

### 16.8 Theming and design tokens

`web/src/styles.css` defines the entire visual system as CSS custom properties on `:root` (dark) and `:root[data-theme="light"]`:

- surfaces: `--bg`, `--bg-2`, `--panel`, `--panel-2`, `--panel-3`;
- text: `--text`, `--muted`, `--faint`;
- lines: `--border`, `--border-strong`;
- accent: `--accent`, `--accent-strong`, `--accent-ink`, `--accent-soft` (gold in dark, amber in light);
- semantic colors: `--green`, `--gold`, `--orange`, `--red`, `--violet`, `--sky`, `--cyan`, `--rose`, `--amber`, `--emerald`;
- column colors: `--todo` (sky), `--doing` (gold/amber), `--review` (violet), `--done` (green);
- shape: `--radius`, `--radius-sm`, `--shadow`;
- type: `--font` (system sans), `--mono`.

The default theme is dark. `useTheme` reads `poca-note:theme` from `localStorage`, applies `data-theme` and `color-scheme` before React renders (module scope), and notifies subscribers on change. There is no flash of the wrong theme because the theme is applied at import time.

Dashboard accents (`emerald`, `amber`, `orange`, `green`, `gold`, `violet`, `cyan`, `rose`, `sky`) are CSS classes with light-theme overrides. The product's visual identity leans on green, gold, and orange for status and energy, with terracotta reserved for the documentation surface.

### 16.9 Accessibility and responsiveness

- Modals share `Modal.jsx`, which handles Escape, backdrop clicks, focus placement, and body scroll locking.
- Interactive elements are real buttons and links with visible focus styles.
- The board stacks to a single column on narrow screens, and the sidebar becomes a horizontally scrollable rail.
- The offline banner is announced in the page flow rather than as a transient toast, because it describes a persistent state.
- Color is never the only signal: priority, due date, and completion also have text or icon labels.

---

## 17. Tooling and operations

### 17.1 npm scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `dev` | `node scripts/dev.mjs` | Run API and Vite together. |
| `dev:server` | `node server/index.js` | API only. |
| `dev:web` | `vite --config web/vite.config.js` | SPA only. |
| `build` | `vite build --config web/vite.config.js` | Production SPA into `web/dist`. |
| `start` | `node scripts/start.mjs` | Production start; sets `NODE_ENV=production` portably. |
| `doctor` | `node scripts/doctor.mjs` | Diagnose Node, npm, dependencies, build, `.env`, data dir, port. |
| `test` | `node --test --test-concurrency=1 tests/*.test.mjs` | Full suite, serialized because tests share ports and temp DBs. |
| `tenant:create` | `node scripts/create-tenant.js` | Add a workspace from the CLI. |
| `db:backup` | `node scripts/backup-sqlite.js` | Consistent SQLite snapshot. |
| `db:to-postgres` | `node scripts/migrate-to-postgres.js` | Copy SQLite into PostgreSQL with verification. |
| `docs` | `node scripts/render-docs.mjs` | Render `docs/architecture.md` to styled HTML. |

### 17.2 Installers

Three entry points share the same behavior:

- `scripts/install.sh` — macOS and Linux (bash);
- `scripts/install.ps1` — Windows PowerShell 7+;
- `scripts/install.cmd` — `cmd.exe` wrapper that invokes the PowerShell script.

They check Node and npm versions, install dependencies (`npm ci`, falling back to `npm install`), verify the packages listed in `requirements.txt`, build the SPA, optionally run tests, and print next steps. They do **not** start the server by default; `--start` does. This is deliberate: an installer that leaves a foreground process running is confusing in a terminal and impossible in a CI or service context.

`requirements.txt` is a **Node/npm dependency manifest**, not a Python pip file. It exists so installers and reviewers have a human-readable list of required packages; `package.json` and `package-lock.json` remain authoritative.

### 17.3 Uninstallers

- `scripts/uninstall.sh`, `scripts/uninstall.ps1`, `scripts/uninstall.cmd`;
- default behavior keeps `.env` and `data/` so a reinstall preserves configuration and workspace data;
- `--purge` / `-Purge` deletes them;
- `--dry-run` / `-DryRun` prints what would happen;
- `--stop` / `-Stop` stops a listener on the configured port;
- a non-project guard refuses to run in a directory that does not look like poca-note;
- source, tests, and documentation are never deleted.

### 17.4 Doctor

`npm run doctor` is the first response to "it does not work". It checks:

- Node version against the `>=22.13` floor (and calls out the 22.5–22.12 `node:sqlite` flag gap);
- npm presence and version;
- dependency installation;
- `web/dist/index.html` presence;
- `.env` parseability and key settings;
- data directory writability;
- whether the configured port is already in use.

It prints actionable fixes and exits non-zero when a core check fails.

### 17.5 Backup and PostgreSQL migration

`scripts/backup-sqlite.js` uses `VACUUM INTO` to produce a consistent snapshot even while the server is running. `scripts/migrate-to-postgres.js`:

1. loads config and resolves source (SQLite) and target (PostgreSQL);
2. backs up SQLite first unless `--no-backup`;
3. creates the PostgreSQL schema;
4. copies every table in dependency order inside one transaction;
5. verifies row counts;
6. prints the next step (set `DATABASE_URL`, restart).

The table order is: tenants, users, sessions, tenant_state, dashboards, cards, checklist_items, task_numbers, task_number_counters, ai_runs, ai_action_runs, report_schedules, report_settings, reports, link_titles.

### 17.6 Production start

`npm start` runs `scripts/start.mjs`, which sets `NODE_ENV=production` if unset and imports `server/index.js`. It expects `web/dist` to exist. Behind a reverse proxy, forward `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For`; set `APP_ORIGIN` and `COOKIE_SECURE=1` for HTTPS. SSE requires proxy buffering to be disabled for `/api/events` (the route already sends `x-accel-buffering: no`, but nginx may still need `proxy_buffering off`).

---

## 18. Testing strategy

The suite uses Node's built-in test runner (`node:test`) with `--test-concurrency=1`. Serialization is necessary because tests bind ports and create temporary SQLite files; parallel runs would race.

`tests/helpers.mjs` builds an isolated environment per test:

- a temporary directory and database path;
- a config with `NODE_ENV=test`, `COOKIE_SECURE=0`, `AI_PROVIDER=offline`, high registration limits;
- a temporary `webDist`;
- helpers to create a tenant, start the app on an ephemeral port, sign in, and make authenticated requests.

| Suite | Covers |
| --- | --- |
| `auth.test.mjs` | Hashing, sessions, login, registration, HTML gate, role checks. |
| `users.test.mjs` | Owner/editor/observer permissions, last-owner invariant, self-removal guard. |
| `board.test.mjs` | Card CRUD, version conflicts, column transitions, positions, trash, checklist. |
| `dashboards.test.mjs` | Create/rename/recolor/delete, card migration on delete, last-board guard. |
| `api.test.mjs` | Route wiring, health, 404s, error shape, origin guard. |
| `task-numbers.test.mjs` | `YYMM` format, monthly reset, uniqueness, legacy renumbering. |
| `actions.test.mjs` | Clause splitting, date/priority parsing, card resolution, plan/apply, stale plans, offline fallback. |
| `ai.test.mjs` | Prompt building, offline output, provider fallback, Anthropic parsing, Ollama thinking flag, route persistence. |
| `reports.test.mjs` | Periods, snapshots, Markdown, schedules, idempotency, performance series. |
| `linkTitle.test.mjs` | Title extraction, SSRF rejection, caching. |
| `legacy-digest.test.mjs` | The removed digest tables stay removed. |
| `installers.test.mjs` | Installer files exist; `requirements.txt`, `engines`, `start`, and `doctor` are correct. |
| `postgres.test.mjs` | Opt-in PostgreSQL run (skipped unless a test database is configured). |

The PostgreSQL suite is opt-in because it needs a live server. The default run executes every other suite with the PostgreSQL test skipped; `npm run build` is the other gate: it catches JSX and import errors that unit tests do not.

**What is not tested:** browser behavior (drag-and-drop, SSE in a real browser), visual regression, and load. Those are verified manually or would need a browser automation layer, which is not currently part of the project.

---

## 19. Security posture

**Strong by default:**

- scrypt password hashing with per-password salt and constant-time comparison;
- hashed session tokens, httpOnly/SameSite cookies, secure cookies in production;
- tenant scoping in every query;
- global editor gate for observers;
- owner-only administrative routes;
- origin guard for mutations;
- CSP and standard security headers in production;
- parameterized SQL;
- SSRF guards on link fetching;
- sanitized Markdown rendering;
- rate limits on login, registration, AI, reports, and link lookups;
- no webhook or chat integrations (the legacy digest feature and its tables were removed).

**Requires operator care:**

- `SHOW_DEMO_CREDENTIALS` must be off in production; the default is off when `NODE_ENV=production`.
- `ALLOW_PRIVATE_LINK_FETCH` weakens SSRF protection; leave it off on public deployments.
- The demo seed password is weak by design; change it or delete the demo workspace.
- The in-memory rate limiter is per process; multi-instance deployments need a shared store.
- SSE is not authenticated separately from the session, but the stream is tenant-scoped and read-only.
- Model prompts include board content; choose a provider whose data handling you accept.
- There is no audit log of user actions beyond AI run history and report rows.

---

## 20. Constraints, scaling, and failure modes

### Known constraints

| Constraint | Consequence | Mitigation |
| --- | --- | --- |
| Single Node process | No horizontal scaling; SSE and rate limits are per process. | Run one process per workspace group, or add shared pub/sub and a shared limiter. |
| Synchronous storage API | Long queries block the event loop. | Keep queries indexed and bounded; the board is small by design. |
| PostgreSQL adapter is one serialized connection | No query parallelism; a slow query blocks others. | Use a real pool and async domain layer for high concurrency. |
| Full board payload | Large boards cost bandwidth and memory. | Paginate or virtualize if a workspace exceeds a few thousand cards. |
| In-memory SSE hub | Missed events on restart or multi-instance. | Polling fallback; add an event log or Redis pub/sub for strict realtime. |
| No schema version table | Migrations are inferred from column/index presence. | Acceptable for this size; add a version table if migrations become branching. |
| Reports and AI history grow unbounded | Database growth over time. | Add a retention job; the tables are append-only and easy to prune. |
| No built-in TLS | Cookies and credentials travel in clear text without a proxy. | Terminate TLS at a reverse proxy and set `COOKIE_SECURE=1`. |

### Failure modes and behavior

| Failure | Behavior |
| --- | --- |
| Database file missing | Created, schema applied, demo tenant seeded if empty. |
| `web/dist` missing | HTML routes return `503` with a build instruction; API still works. |
| Session expired | `401`, client redirects to `/login` with `next`. |
| Card changed elsewhere | `409` with current card and revision; client reconciles and toasts. |
| Plan already applied | `409`; no duplicate mutations. |
| AI provider down | `auto` falls through to the next provider or offline; explicit mode returns `502`. |
| Ollama unreachable | Probe fails fast (1.5 s), cached for 15 s, `auto` skips it. |
| Link fetch blocked | `422` with a human-readable reason; the card keeps the raw URL. |
| SSE connection drops | Client marks offline, reconnects with `retry: 3000`, polling continues. |
| Report tick overlaps | `running` guard skips the overlapping tick. |
| Scheduled report duplicate | Unique index rejects it; the loser returns the existing report. |
| PostgreSQL worker dies | Adapter marks failure and wakes waiters; requests fail fast. |
| Process receives SIGINT/SIGTERM | Scheduler stops, server closes, database closes. |

### When to change the architecture

- **More than a handful of concurrent writers, or multi-instance:** replace the synchronous PostgreSQL shim with a pool and async data layer; add shared SSE pub/sub and a shared rate-limit store.
- **Very large boards:** add server-side pagination/filtering and virtualize the columns.
- **Strict realtime:** add an event log with per-client cursors, or move to WebSockets with acknowledgements.
- **Compliance/audit:** add an append-only audit table for user actions and a retention policy for AI and report data.
- **Team-scale AI usage:** add per-workspace quotas and a queue so one long generation cannot exhaust the AI limiter.

---

## 21. Request lifecycles

### 21.1 Create a card

```
Browser                     Server                          SQLite/PostgreSQL
───────                     ──────                          ─────────────────
POST /api/cards
  { title, column, ... } ──▶ origin guard
                             session → tenant, user
                             editor gate
                             createCard()
                               validate title/url/date
                               BEGIN IMMEDIATE
                                 allocateTaskNo()
                                   claim task_numbers row
                                   advance counter
                                 INSERT cards
                                 bumpRevision()
                               COMMIT
                             emit SSE revision
  ◀── 201 { card, revision }
commit local card
notify other tabs
```

### 21.2 Move a card with a stale version

```
Tab A                         Server                         Tab B
─────                         ──────                         ─────
PATCH /api/cards/:id
  { column: "done",
    version: 7 } ───────────▶ version 7 == 7?
                               UPDATE, version = 8
                               bumpRevision → 43
  ◀── 200 { card v8, rev 43 }
                               SSE revision 43 ─────────────▶ GET /api/board
                                                               ◀── cards, rev 43

Tab A later, stale v7:
PATCH /api/cards/:id
  { title, version: 7 } ───▶ version 7 != 8
  ◀── 409 { card v8, rev 43 }
replace local card with v8
toast "changed elsewhere"
```

### 21.3 Plan and apply AI actions

```
POST /api/ai/actions/plan { prompt }
  │
  ├─ rules planner ──▶ actions? ──yes──▶ plan (source: rules)
  │                        │
  │                        no
  │                        ▼
  ├─ LLM planner ──▶ valid JSON? ──yes──▶ normalize against board (source: llm)
  │                        │
  │                        no
  │                        ▼
  └─ offline template ──▶ plan (source: offline)
  │
  ├─ persist ai_action_runs (status: planned)
  └─ 200 { runId, plan, source, warnings }

POST /api/ai/actions/apply { runId }
  │
  ├─ load run; reject if already applied (409)
  ├─ for each action:
  │    re-resolve card/subtask against live board
  │    enforce planned version (chain versions within the plan)
  │    execute; record ok/message
  ├─ persist status applied|failed + results
  ├─ emit one SSE revision
  └─ 200 { revision, applied, failed, partial, results, runId, status }
```

---

## 22. Source map

```
server/
  index.js              boot: dotenv, config, DB, seed, app, listen, scheduler, shutdown
  app.js                middleware order, security headers, origin guard, rate limiters,
                        route mounting, SPA gate, error handler
  config.js             env parsing, clamping, minimal dotenv loader
  util.js               IDs, ISO time, HttpError, validation, cookies, sha256,
                        rate limiter, URL/date/timezone helpers
  db.js                 schema, migrations, transactions, revision, task numbers,
                        tenant/user CRUD, backend selection
  postgres.js           PostgreSQL schema, SQL conversion, sync-over-worker client
  postgres-worker.js    worker thread owning the pg connection
  auth.js               scrypt, sessions, roles, signup, demo seed, HTML gate
  dashboards.js         board CRUD, accent/name validation, safe delete, resolution
  board.js              cards, checklists, trash, positions, version conflicts
  routes/
    auth.js             config, register, login, logout, me
    users.js            teammate CRUD (owner)
    board.js            board, dashboards, cards, trash, checklist
    events.js           SSE endpoint
    link.js             link title lookup
    ai.js               status, runs, generate, actions, brief
    reports.js          reports, latest, performance, settings, schedules
  services/
    events.js           per-tenant SSE hub with heartbeat
    linkTitle.js        SSRF-safe fetch, title extraction, 24h cache
    ai.js               provider chain, adapters, offline template, status
    actions.js          clause parser, rules planner, LLM planner, executor
    reports.js          periods, snapshots, Markdown builders, scheduler, series

web/src/
  main.jsx              React root
  App.jsx               session bootstrap, history router, route switch
  api.js                fetch wrapper, ApiError, clientId, 401 event
  hooks/
    useBoard.js         cache, SSE, BroadcastChannel, polling, optimistic mutations
    useDashboards.js    board list and mutations
    useTheme.js         persisted light/dark theme
    useToasts.js        toast queue
  lib/
    format.js           columns, dates, sorting, search, truncation
    roles.js            role metadata, canEdit, canAdmin
  components/           see §16.6
  styles.css            design tokens, themes, layout, components

scripts/
  install.sh            macOS/Linux installer
  install.ps1           Windows installer
  install.cmd           Windows wrapper
  uninstall.sh          macOS/Linux uninstaller
  uninstall.ps1         Windows uninstaller
  uninstall.cmd         Windows wrapper
  start.mjs             portable production start
  doctor.mjs            environment diagnostics
  dev.mjs               API + Vite dev runner
  create-tenant.js      CLI workspace creation
  backup-sqlite.js      consistent SQLite snapshot
  migrate-to-postgres.js SQLite → PostgreSQL copy with verification
  render-docs.mjs       Markdown → Claude-styled HTML for this document

docs/
  architecture.md       this document
  architecture.html     rendered, self-contained version

tests/                  node:test suites (see §18)
```

---

## 23. Glossary

| Term | Meaning |
| --- | --- |
| **Workspace / tenant** | The isolation boundary. Owns boards, cards, users, reports, AI history. |
| **Board / dashboard** | A named Kanban surface inside a workspace. |
| **Card** | A task with title, notes, link, due date, priority, column, position, version, and checklist. |
| **Subtask / checklist item** | A numbered item inside a card. |
| **Task number** | `YYMM` + 5-digit monthly sequence, unique per workspace. |
| **Revision** | Monotonic per-workspace change counter used by SSE and clients. |
| **Version** | Per-card optimistic-concurrency counter. |
| **Plan** | A list of proposed board actions produced by the AI actions planner. |
| **Run** | A persisted AI content generation or action plan/apply record. |
| **Snapshot** | The computed board state used to build a report. |
| **Schedule** | A recurring daily/weekly/monthly report definition. |
| **Brief** | A one-minute report variant and an AI content format. |
| **Observer** | Read-only workspace role. |
| **Editor** | Read/write workspace role without administrative rights. |
| **Owner** | Full workspace role, including teammate and report settings. |
| **SSE** | Server-Sent Events, used for revision notifications. |
| **SSRF** | Server-Side Request Forgery; guarded in link title fetching. |

---

*This document describes poca-note 1.0.0. When behavior changes, update the relevant section and re-render the HTML with `npm run docs`.*
