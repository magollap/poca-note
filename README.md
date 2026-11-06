# poca-note

A keyboard-first, tenant-scoped personal Kanban. Dark or light four-column board,
durable shared persistence, browser caching, cross-tab sync, conflict-safe edits,
recoverable deletion, a vibrant public landing page, AI board actions, and an AI
content studio.

- **Dashboards**: multiple boards per workspace, each with its own cards, name, and
  accent color. The sidebar switches boards, creates new ones, and shows open counts.
- **Board**: To Do / Doing / Under Review / Done, drag-and-drop ordering, notes, links,
  due dates, priorities, checklists, soft delete with undo, trash drawer. Under Review
  is the testing and sign-off lane: work stays open there until it moves to Done.
- **Status check-ins**: every card and checklist subtask has a status
  (**Not started**, **In progress**, **Blocked**, or **Done**) plus a dated update
  timeline. Status changes and written notes are attributed to the signed-in user.
  Open work with no update in the workspace's check-in window (3 days by default,
  editable in Settings) gets a **Needs update** badge and a board reminder; press
  **U** to review everything in one check-in panel.
- **Accounts**: anyone can create a workspace from the login page. Owners add
  teammate logins with an **owner**, **editor**, or **observer** role. Owners are
  super users; editors change boards, cards, reports, and AI plans; observers are
  read-only.
- **Task numbers**: every card and subtask gets a nine digit number labelled
  **Task 261000001** — the year and month (`YYMM`) followed by a five digit monthly
  sequence. The sequence restarts at `00001` each month, so the prefix tells you when
  a task was created and the number stays short enough to say out loud.
- **Storage**: SQLite by default; set `DATABASE_URL` to run the same app on
  PostgreSQL. `npm run db:to-postgres` migrates an existing SQLite database with
  an automatic backup and row-count verification.
- **Sync**: every mutation bumps a per-tenant revision. Clients stay fresh via
  SSE, `BroadcastChannel`, polling, and a `localStorage` cache.
- **Theme**: a light/dark switch in the sidebar, stored per browser and applied
  instantly across boards, reports, settings, and AI skills.
- **AI skills**: a tenant-authenticated content studio that turns a brief into
  formatted Markdown, with a deterministic offline fallback. Provider and model
  names stay on the server; the UI only shows **AI ready** / **Offline preview**.
- **AI board actions**: a popover in the top-right of the board. Pick a task number,
  describe a change, review the exact plan, then apply it. The panel understands
  create, update, complete, delete, and subtask operations.
- **Reports**: several daily, weekly, and monthly schedules per workspace, saved
  editions on the board and the sidebar Reports page, plus daily/weekly/monthly
  performance charts built from card history. All numbers come from the board.
- **No chat integrations**: the old **Doing digest** feature (Slack/Teams webhook
  reminders) has been removed. Reports stay inside the workspace and there are no
  chat or webhook settings to configure.

---

## Installation

poca-note is a Node.js app. The installers read
[`requirements.txt`](./requirements.txt), check the runtime, install the npm
packages, create `.env`, prepare `data/`, and build the web UI.

### Requirements

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | >= 22.13 | Node 24 recommended; `node:sqlite` needs 22.13+ |
| npm | >= 10 | Ships with Node.js |
| PowerShell | 7+ | Only needed for `install.ps1` on macOS/Linux |
| PostgreSQL | >= 13 | Optional; SQLite is the default |

`requirements.txt` is a dependency manifest for this Node project, not a Python
pip file. It lists the minimum `node`/`npm` versions, the optional `psql`
client, and the npm packages that the installers verify. `package.json` and
`package-lock.json` remain the authoritative npm manifests.

### macOS and Linux

Use the native shell installer:

```bash
chmod +x scripts/install.sh
./scripts/install.sh
```

| Flag | Meaning |
| --- | --- |
| `--dev` | Set up for development and skip the production build |
| `--start` | Start the app after installing |
| `--test` | Run the test suite after installing |
| `--install-node` | Try to install Node.js with Homebrew, NodeSource, dnf, or pacman |
| `--skip-install` | Do not run `npm ci` / `npm install` |
| `--skip-build` | Do not build `web/dist` |
| `--skip-env` | Do not create `.env` from `.env.example` |
| `--force` | Reinstall dependencies with `npm ci` |

If PowerShell 7 (`pwsh`) is installed, the cross-platform installer also works:

```bash
pwsh -File scripts/install.ps1
```

Manual steps:

```bash
# Node.js >= 22.13 and npm >= 10 must already be installed
npm ci                 # or npm install
cp .env.example .env   # optional; defaults work without it
mkdir -p data
npm run build          # production UI
npm run dev            # development: http://localhost:5173
# or
npm start              # production:  http://localhost:8787
```

### Windows (PowerShell)

Run from the project folder:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\install.ps1
```

Or double-click `scripts\install.cmd`, which runs the PowerShell installer with
the execution policy bypassed for that process only.

Options match the shell installer:

```powershell
.\scripts\install.ps1 -Dev -Start
.\scripts\install.ps1 -SkipBuild
.\scripts\install.ps1 -InstallNode
.\scripts\install.ps1 -Test
```

Manual steps:

```powershell
npm ci
Copy-Item .env.example .env
New-Item -ItemType Directory -Force data | Out-Null
npm run build
npm run dev      # development: http://localhost:5173
# or
npm start        # production:  http://localhost:8787
```

`npm start` is cross-platform: `scripts/start.mjs` sets
`NODE_ENV=production` in JavaScript, so it works in PowerShell, `cmd.exe`,
macOS, and Linux.

### After installing

**The installers do not start the server.** They install dependencies, create
`.env`, and build the UI, then exit. Port `8787` stays closed until you run
`npm start` (or pass `--start` / `-Start` to the installer). `curl` failing with
`Could not connect to server` before that step is expected.

| Mode | Command | URL |
| --- | --- | --- |
| Development | `npm run dev` | <http://localhost:5173> |
| Production | `npm start` | <http://localhost:8787> |
| Diagnostics | `npm run doctor` | — |
| Tests | `npm test` | — |

`npm start` runs in the foreground and logs
`poca-note server listening on http://localhost:8787`. Keep that terminal open;
`Ctrl+C` stops the server. To run it in the background instead:

```bash
nohup npm start > poca-note.log 2>&1 &
```

On a fresh database the demo workspace is `acme` / `poca-demo`. In production
the credentials are hidden on the login page; create a workspace from the login
page or run:

```bash
npm run tenant:create -- beta "Beta Labs" "a-long-password"
```

### Troubleshooting

- **Node version**: `node --version` must be `v22.13.0` or newer. Node 22.5–22.12
  installs successfully but cannot load `node:sqlite` without a flag, so the
  server exits at startup. Upgrade to Node 22.13+ or 24. Use
  [nvm](https://github.com/nvm-sh/nvm) or
  [fnm](https://github.com/Schniz/fnm) on macOS/Linux, or the official installer
  on Windows.
- **Something still fails**: run `npm run doctor`. It checks Node, `node:sqlite`,
  the web build, `.env`, data permissions, and the port, then prints what to fix.
- **PowerShell blocks the script**: run
  `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` or use
  `scripts\install.cmd`.
- **`npm ci` fails**: the lockfile and `package.json` may be out of sync. Run
  `npm install` once, then `npm ci` again.
- **Port already in use**: set `PORT=9000` in `.env` (or the environment) and
  restart.
- **Dev server is not reachable from another machine**: Vite binds to
  `127.0.0.1` by default. Run `POCA_HOST=0.0.0.0 npm run dev` and allow port
  `5173`, or use `npm start` (production, port `8787`) instead.
- **`node:sqlite` experimental warning**: expected on Node 22/24.

---

## Quick start

Requires **Node.js >= 22.13** (Node 24 recommended; `node:sqlite` is used).

```bash
npm install
npm run dev          # API on :8787, Vite dev server on :5173
```

Open <http://localhost:5173> and sign in with the seeded demo tenant:

| Tenant | Password   |
| ------ | ---------- |
| `acme` | `poca-demo` |

Or click **Create workspace** on the login page to register a brand-new workspace
and owner login. The seeded demo tenant is only created when the database contains
**no tenants**, and its credentials are hidden on the login page when
`NODE_ENV=production`.

### Production build

```bash
npm run build        # writes web/dist
npm start            # NODE_ENV=production, serves API + SPA on :8787
```

### Running without npm

`scripts/start.sh` starts the same server directly through Node:

```bash
scripts/start.sh          # background; logs to logs/poca-note.log
scripts/start.sh status
scripts/start.sh stop
scripts/start.sh restart
scripts/start.sh run      # foreground (what the systemd unit uses)

scripts/stop.sh           # same as: scripts/start.sh stop
scripts/status.sh         # same as: scripts/start.sh status (exit 1 when down)
```

`start` is idempotent: if the app is already served by the systemd unit or
already listening on the configured port, it reports that and exits `0`.

### Autostart (WSL + Windows)

Two independent layers keep the app running without manual effort:

1. **WSL start** — the systemd user unit `poca-note.service` executes
   `scripts/start.sh run`. `loginctl enable-linger egolman` lets that unit start
   at distro boot, without an interactive login.
2. **Windows logon** — the Task Scheduler task `poca-note (WSL)` runs
   `wsl.exe -d Ubuntu-26.04 -u egolman --exec .../scripts/start.sh`, which boots
   the distro and, if the unit is not running, starts a background daemon.

```bash
systemctl --user status poca-note     # unit state
systemctl --user restart poca-note    # apply code changes
journalctl --user -u poca-note -f     # live logs
```

The Windows task triggers at **logon**, which needs no administrator rights. To
start the app before anyone signs in, an elevated shell must register an
`ONSTART` task running as `SYSTEM`; WSL itself is only launched by such a task
because Windows does not start the distro on its own.

### Tests

```bash
npm test             # node --test tests/*.test.mjs
```

Node prints an experimental warning for `node:sqlite`; that is expected.

The PostgreSQL integration test is opt-in and refuses to run unless the database
name ends in `_test` (it truncates the application tables):

```bash
TEST_POSTGRES_URL=postgresql://poca:password@127.0.0.1:5432/poca_note_test \
  node --test tests/postgres.test.mjs
```

---

## Configuration

Copy `.env.example` to `.env`. All values are optional; `process.env` always wins
over `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `APP_ORIGIN` | — | Public origin allowed for cross-origin state-changing requests |
| `COOKIE_SECURE` | `1` in production | Marks the session cookie `Secure` |
| `DATABASE_PATH` | `./data/poca-note.db` | SQLite file (WAL mode); ignored when `DATABASE_URL` is set |
| `DATABASE_URL` | — | PostgreSQL connection string; switches storage from SQLite |
| `DATABASE_SSL` | `0` | Use TLS for PostgreSQL (self-signed certificates are accepted) |
| `DATABASE_TIMEOUT_MS` | `60000` | PostgreSQL query timeout |
| `SESSION_DAYS` | `30` | Session lifetime |
| `DEMO_TENANT_SLUG` / `_NAME` / `_PASSWORD` | `acme` / `Acme Studio` / `poca-demo` | Seed tenant |
| `SHOW_DEMO_CREDENTIALS` | on outside production | Show demo login hint |
| `REGISTRATION_OPEN` | `1` | Allow self-service workspace sign-up |
| `REGISTRATION_MAX_PER_HOUR` | `5` | New workspaces per IP per hour |
| `REPORTS_ENABLED` | `1` | Run the daily / weekly / monthly report scheduler |
| `REPORTS_GRACE_MINUTES` | `120` | Catch-up window after a report's scheduled time |
| `REPORTS_TICK_MS` | `60000` | Report scheduler tick interval |
| `REPORTS_DEFAULT_TIME` / `REPORTS_DEFAULT_TIMEZONE` | `08:00` / `UTC` | Default schedule per new workspace |
| `LINK_FETCH_TIMEOUT_MS` / `LINK_FETCH_MAX_BYTES` | `6000` / `524288` | Page-title fetch limits |
| `ALLOW_PRIVATE_LINK_FETCH` | `0` | Allow private/loopback link targets (dev/tests only) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | — / `claude-sonnet-4-5` | Anthropic provider |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://127.0.0.1:11434` / `qwen3.5:4b` | Local Ollama provider |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` | — / — / `gpt-4o-mini` | OpenAI-compatible provider |
| `AI_PROVIDER` | `auto` | `auto`, `anthropic`, `ollama`, `openai`, `offline` |
| `AI_TIMEOUT_MS` | `90000` | Per-provider request timeout |

> **Local fixtures:** `ALLOW_PRIVATE_LINK_FETCH=1` is required to fetch titles from
> `localhost` / `127.0.0.1` / private ranges. It is off by default to prevent SSRF.

---

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `n` | Focus quick capture |
| `/` | Focus filter |
| `j` / `k` | Next / previous card |
| `h` / `l` | Previous / next column |
| `Enter` | Open selected card |
| `1` / `2` / `3` / `4` | Move card to To Do / Doing / Under Review / Done |
| `c` | Complete selected card |
| `d` | Move card to trash (undoable) |
| `t` | Open trash |
| `b` | Daily brief and reports |
| `g` | Open the daily brief |
| `s` | Workspace settings |
| `?` | Shortcut reference |
| `Esc` | Close panel or card |
| `⌘/Ctrl + Enter` | Save card / generate AI content |

---

## Architecture

> **Full system architecture:** [`docs/architecture.md`](docs/architecture.md) is the
> detailed engineering reference (runtime topology, storage adapters, schema,
> auth/roles, HTTP pipeline, SSE, AI planner, reports, frontend state flow,
> tooling, security, and failure modes). A self-contained Claude-styled rendering
> lives at [`docs/architecture.html`](docs/architecture.html); rebuild it with
> `npm run docs` after editing the Markdown.

```
server/
  index.js            bootstrap: dotenv, DB, auth seed, scheduler, HTTP listen
  app.js              Express wiring, auth middleware, security headers, SPA gate
  config.js           env parsing + minimal dotenv loader
  db.js               SQLite schema, migrations, tenant revisions, backend selection
  postgres.js         PostgreSQL schema, SQL adapter, synchronous pg worker client
  postgres-worker.js  worker thread that owns the pg connection
  auth.js             scrypt hashing, users, sessions, signup, seeding, HTML gate
  dashboards.js       workspace boards: CRUD, resolution, safe delete
  board.js            cards, checklists, trash, conflict-safe patch, positions
  routes/             auth, users, board, events (SSE), link, ai, reports
  services/
    events.js         per-tenant SSE hub
    linkTitle.js      SSRF-safe title fetch + 24h cache
    ai.js             Anthropic → Ollama → OpenAI → offline chain
    actions.js        rules/LLM action planner, board executor, plan history
    reports.js        periods, schedules, performance series, Markdown builders
scripts/
  install.sh          macOS/Linux installer (requirements, npm, build)
  install.ps1         Windows / PowerShell 7 installer
  install.cmd         Windows wrapper for install.ps1
  start.mjs           cross-platform production start (npm start)
  doctor.mjs          runtime, build, .env, data, and port diagnostics
  dev.mjs             API + Vite dev servers
  create-tenant.js    add a workspace from the CLI
  backup-sqlite.js    consistent SQLite snapshot
  migrate-to-postgres.js  SQLite → PostgreSQL copy
requirements.txt      runtime + npm dependency manifest used by installers
web/src/
  App.jsx             client routing (/board, /reports, /skills) + auth guard
  hooks/useBoard.js   cache, SSE, BroadcastChannel, polling, mutations
  hooks/useDashboards.js  board list/create/rename/recolor/delete
  hooks/useTheme.js   persisted light/dark theme store
  components/         landing page, sidebar, board, card editor, modals, trash,
                      AI actions panel, AI skills, reports, performance charts
tests/                node:test suites (auth, users, board, api, linkTitle,
                      ai, actions, reports, dashboards, task numbers)
```

### Data model

- `tenants` — slug, display name, `revision`. A workspace.
- `users` — one or more logins per workspace: unique `(tenant_id, username)`,
  scrypt password hash, `owner` / `editor` / `observer` role, last login.
- `sessions` — hashed bearer/cookie tokens with expiry, linked to a user.
- `dashboards` — ordered boards per workspace with a name and accent color.
- `cards` — tenant- and dashboard-scoped, `column`, `position`, `version`,
  soft-delete timestamp, notes/link/due date/priority, completion timestamp, and a
  workspace-unique `YYMM`-prefixed `task_no`.
- `checklist_items` — ordered rows attached to a card, each with its own unique
  `YYMM`-prefixed `task_no`, `done` flag, and status.
- `task_updates` — the dated status/note timeline for cards and checklist
  subtasks. Rows record the author, status snapshot, and optional note; a status
  change is logged automatically.
- `tenant_state` — the workspace revision counter and the status check-in window
  (`update_interval_days`).
- `task_numbers` — the registry of every number ever issued in a workspace, so
  numbers are unique across cards *and* subtasks and are never reused.
- `task_number_counters` — the next sequence number for each workspace and month.
  Legacy six digit numbers are renumbered once on upgrade.
- `ai_runs` — tenant-scoped generated output.
- `ai_action_runs` — planned/applied action plans with their results.
- `report_schedules` — any number of daily/weekly/monthly schedules per workspace.
- `report_settings` / `reports` — legacy schedule container plus saved editions.
- `link_titles` — 24-hour URL → title cache.

Every write **filters by `tenant_id`**. Cross-tenant card or board IDs return `404`.

### Conflict safety

PATCH requests must include the card `version`. If it does not match, the API
returns **409** with the current card, and the UI shows a conflict banner and
reloads/merges instead of overwriting. `updated_at` and `version` are bumped inside
the same transaction as the revision.

### Synchronization

1. SSE stream at `/api/events` pushes `ready` + per-tenant `revision` frames.
2. `BroadcastChannel` propagates instantly between tabs on one browser.
3. A 45-second poll and `visibilitychange` cover reconnects.
4. The latest board snapshot is cached in `localStorage` for instant paint.

### Dashboards, sidebar, and theme

- The sidebar is a left rail on desktop and a horizontal bar on narrow screens.
  It owns the board list and **New dashboard** action, navigation
  (**Tasks**, **Reports**, **AI Skills**), trash, settings, the theme switch, and
  the tenant footer.
- Selecting a board navigates to `/board?d=<id>`; cards, positions, and the
  `localStorage` cache are all scoped per board key.
- Deleting a board moves its cards — trashed ones included — to the oldest
  remaining board, so work is never lost. The last board cannot be deleted.
- The light/dark choice lives in `localStorage` as `poca-note:theme`, is applied as
  `data-theme` on `<html>`, and every visible switch stays in sync.

---

## HTTP API

All routes are tenant-authenticated except `/api/auth/config`, `/api/auth/login`,
and `/api/auth/register`.
Authentication is an HTTP-only `poca_session` cookie or `Authorization: Bearer <token>`.

### Auth

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/auth/config` | App name, demo hint (non-prod), registration flag |
| `POST` | `/api/auth/register` | `{ tenant, name, username, password }` → new workspace + owner session |
| `POST` | `/api/auth/login` | `{ tenant, username?, password }` → tenant, user, bearer token |
| `POST` | `/api/auth/logout` | Deletes session |
| `GET` | `/api/auth/me` | Current workspace and user |
| `GET` | `/api/users` | Teammate list; `canManage` is true for owners |
| `POST` | `/api/users` | Owner adds `{ username, displayName, password, role }` (`editor` default) |
| `PATCH` | `/api/users/:id` | Owner resets a password, display name, or role |
| `DELETE` | `/api/users/:id` | Owner removes a login (cannot remove the last owner) |

Observers are read-only: every non-`GET` `/api` mutation returns `403` before it
reaches a route. Owner-only routes keep working for editors' read access but reject
their writes.

### Board and cards

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/dashboards` | Boards with open/total counts |
| `POST` | `/api/dashboards` | Create `{ name, accent }` |
| `PATCH` | `/api/dashboards/:id` | Rename, recolor, or reorder |
| `DELETE` | `/api/dashboards/:id` | Moves its cards to the oldest remaining board |
| `GET` | `/api/board?dashboardId=…` | Cards, trash count, revision; defaults to the oldest board |
| `GET` | `/api/trash` | Soft-deleted cards (workspace-wide) |
| `POST` | `/api/cards` | Create (`title` required, optional `dashboardId`) |
| `GET` | `/api/cards/:id` | Single card |
| `PATCH` | `/api/cards/:id` | Update; requires `version` |
| `DELETE` | `/api/cards/:id` | Soft delete |
| `POST` | `/api/cards/:id/restore` | Restore from trash |
| `DELETE` | `/api/cards/:id/purge` | Permanently delete (must be trashed) |
| `DELETE` | `/api/trash` | Empty trash |
| `POST` | `/api/cards/:id/checklist` | Add checklist item |
| `PATCH` | `/api/checklist/:id` | Toggle, rename, or set status |
| `DELETE` | `/api/checklist/:id` | Remove |
| `POST` | `/api/cards/:id/updates` | Append a card status update `{ body }` |
| `POST` | `/api/checklist/:id/updates` | Append a subtask status update `{ body }` |
| `GET` | `/api/status-settings` | Current check-in window in days |
| `PATCH` | `/api/status-settings` | Set `{ intervalDays }` (1–365) |
| `GET` | `/api/events` | SSE revision stream |
| `GET` | `/api/health` | Authenticated liveness |

### Links and AI

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/link-title?url=…` | `{ title, siteName, finalUrl, cached }` |
| `GET` | `/api/ai/status` | Provider mode, reachability, options |
| `POST` | `/api/ai/generate` | `{ brief, format, tone, length }` |
| `GET` | `/api/ai/runs` | Tenant-scoped history |
| `GET` | `/api/ai/actions` | Recent plans and their status |
| `GET` | `/api/ai/actions/:id` | One saved plan with actions and result |
| `POST` | `/api/ai/actions/plan` | `{ prompt }` → reviewable plan + `runId` |
| `POST` | `/api/ai/actions/apply` | `{ runId }` or `{ plan }`; re-validates every action |
| `POST` | `/api/ai/brief` | Generate the daily brief |
| `GET` | `/api/reports` | Saved editions, latest per kind, counts, schedules |
| `GET` | `/api/reports/latest` | Latest daily / weekly / monthly / brief |
| `GET` | `/api/reports/performance?range=daily\|weekly\|monthly&dashboardId=…` | Bucketed created/completed/backlog series |
| `GET` | `/api/reports/schedules` | Every schedule in the workspace |
| `POST` | `/api/reports/schedules` | Add `{ kind, time, weekday, dayOfMonth, timezone, label }` |
| `PATCH` | `/api/reports/schedules/:id` | Edit or pause one schedule |
| `DELETE` | `/api/reports/schedules/:id` | Remove one schedule (the last one is kept) |
| `GET` | `/api/reports/settings` | Legacy single-schedule view (first per kind) |
| `PUT` | `/api/reports/settings` | Legacy edit of the first schedule per kind + timezone |
| `POST` | `/api/reports` | `{ kind }` → generate now (`daily`, `weekly`, `monthly`, `brief`) |

Errors are JSON: `{ "error": "<code>", "message": "<human text>" }` with codes such
as `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`invalid_target`, `rate_limited`.

---

## AI providers

`AI_PROVIDER=auto` tries each configured provider in order and falls back to a
deterministic Markdown template so the page always returns something useful:

1. **Anthropic** when `ANTHROPIC_API_KEY` is set.
2. **Ollama** at `OLLAMA_URL` (default `qwen3.5:4b`). Requests send
   `think: false` and `keep_alive: "10m"`; without `think: false`, thinking models
   burn the token budget and return empty content.
3. **OpenAI-compatible** when `OPENAI_BASE_URL` + `OPENAI_API_KEY` are set.
4. **Offline** template.

Output is sanitized Markdown rendered by a safe renderer (no raw HTML).

**Model privacy:** provider and model names are stored in SQLite but never leave the
server. `GET /api/ai/status` returns only `{ ready, mode, formats, tones, lengths }`,
and run, plan, and report payloads omit `provider`/`model` (and generation
`attempts`). The UI shows a neutral **AI ready** or **Offline preview** badge.

---

## Board actions

The **AI Actions** popover in the top-right of the board turns plain language into a
reviewable plan:

```text
Create a card "Review pricing" due Friday high priority,
add subtask "Check margins" to "Ship the beta", and mark "Ship the beta" as done
```

Every card and every checklist subtask carries a unique nine digit number such as
**Task 261000001**, shown on the card, in the card editor, and on each subtask row.
The first four digits are the creation year and month; the last five are the monthly
sequence.
You can reference that number anywhere a title works, which removes ambiguity:

```text
mark subtask Task 261000001 as done, rename Task 261000001 to "Check final margins",
add subtask "Publish" to Task 261000002, and complete Task 261000002
```

`#261000001` and a bare `261000001` are accepted too, but the UI and AI prompts use
the **Task 261000001** spelling. Search accepts all three forms.

Numbers are allocated from a per-workspace, per-month series: `YYMM` + five digits,
starting at `00001` each month. The number is kept in `task_numbers`, so it is never
reused within that month, even after a card is purged from the trash. Two workspaces
may use the same number — the series is tenant-scoped.

1. A deterministic rules parser handles the common phrasings instantly (create,
   rename, move, reschedule, reprioritise, notes, complete, delete, subtask, plus
   complete/rename/delete subtask by **Task number**; `#number` still works).
2. Only when the rules recognize nothing is a language model asked for a strict JSON
   plan. If no model is reachable, a single-card offline fallback is offered.
3. The plan is shown action by action. Nothing changes until **Apply plan**.
4. On apply, every action is re-validated server-side: cards must still exist, must
   belong to the tenant, and must match the version seen at plan time. Actions inside
   one plan can chain on the same card (e.g. add a subtask, then complete it).
5. Plans and results are stored in `ai_action_runs` and shown in **Recent plans**.

Applying a plan emits the same SSE revision event as a manual edit, so every open
tab refreshes.

## Reports

Reports are dashboard-first: the board shows tiles for **Today**, **This week**,
**Last month**, and the **Brief**. Open any tile (or press `b`) to read the edition,
generate a new one, browse earlier editions, and edit the schedules.

The sidebar **Reports** page adds:

- **Performance charts** — daily (14 days), weekly (8 Monday-start weeks), or
  monthly (6 months) buckets of cards created, cards completed, and the open
  backlog at the end of each bucket, optionally scoped to the selected board.
  Everything is computed from card `created_at` / `completed_at` in the workspace
  timezone; nothing is estimated.
- **Saved editions** for all four report kinds.
- **Schedules** for every daily / weekly / monthly job in the workspace.

- **Daily** — today's local date. Lists overdue cards, cards due today, work still
  pending from before today, and what was completed today.
- **Weekly** — the previous seven days, keyed by the Monday that starts the window.
- **Monthly** — the previous calendar month, keyed as `YYYY-MM`.
- **Brief** — the daily layout, generated on demand.

Each report opens with a two-to-three sentence model-written narrative; every card
list, count, and table stays deterministic so the facts cannot be hallucinated. The
offline provider simply skips the narrative.

A workspace starts with daily at 08:00, weekly on Monday at 08:00, and monthly on
day 1 at 08:00 in its timezone (seeded from the workspace defaults). Add as many extra schedules as needed — two daily reports at 08:00 and
18:00, a Friday wrap-up, and so on — and pause any of them without deleting history.
The last schedule cannot be deleted.

An in-process scheduler ticks every 60 seconds, fires inside a 120-minute grace
window, and deduplicates per schedule with a partial unique index on
`(tenant_id, schedule_id, period_key) WHERE trigger = 'scheduled' AND schedule_id IS
NOT NULL`. Manual generations are never deduplicated.

---

## Workspaces, sign-up, and teammates

- **Self-service:** the login page's **Create workspace** tab creates a workspace
  and its owner login in one step, then signs you in. `REGISTRATION_OPEN=0` closes
  it; `REGISTRATION_MAX_PER_HOUR` caps new workspaces per IP.
- **Owners** are super users. Under **Settings → Teammates** they add a login,
  reset its password, change its role, or remove it. A workspace always keeps at
  least one owner, and sessions are revoked when a login is removed.
- **Editors** sign in with the workspace address, their username, and their
  password. They can change boards, cards, reports, schedules, and AI plans, but
  cannot manage teammates or change owner-only settings (the legacy report setting).
- **Observers** get read-only access: the UI hides creation, editing, drag-and-drop,
  and destructive actions, and every non-`GET` API mutation is rejected with `403`.
  They can still browse boards, saved reports, performance charts, schedules, AI
  history, and the teammate list.
- **Compatibility:** signing in with only the workspace address and password still
  works and resolves to the owner login. Existing databases are migrated on boot:
  each tenant's old password becomes its owner account, legacy `member` rows become
  `editor`, and live sessions keep working.

Create a workspace from the command line (no server restart needed):

```bash
npm run tenant:create -- beta "Beta Labs" "a-long-password"
# or: node scripts/create-tenant.js beta "Beta Labs" "a-long-password"
```

The slug must be 2–49 characters of letters, numbers, and hyphens; passwords must be
at least 8 characters. Reserved addresses (`login`, `board`, `skills`, `reports`,
`api`, `admin`, `assets`, `auth`, `health`, `settings`, `static`, `trash`, `users`, …)
cannot be registered.

---

## PostgreSQL

SQLite stays the default and needs no setup. To run on PostgreSQL instead, the app
needs a database and a connection string; the schema is created automatically on
first start. PostgreSQL **13 or newer** is recommended.

Short version, after PostgreSQL is installed and an empty database exists:

```bash
# 1. Stop the app, then snapshot the SQLite database
npm run db:backup

# 2. Preview, then copy SQLite → PostgreSQL
npm run db:to-postgres -- --url "postgresql://poca:password@127.0.0.1:5432/poca_note" --dry-run
npm run db:to-postgres -- --url "postgresql://poca:password@127.0.0.1:5432/poca_note"

# 3. Add DATABASE_URL=… to .env and restart
npm start
```

The numbered steps below explain each part, the backup location, and how to roll
back to SQLite.

### 1. Install PostgreSQL

Install it with your platform's package manager, for example:

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install postgresql postgresql-client

# macOS (Homebrew)
brew install postgresql@16 && brew services start postgresql@16

# Fedora
sudo dnf install postgresql-server postgresql-contrib
sudo postgresql-setup --initdb && sudo systemctl enable --now postgresql
```

Make sure the server is running and that `psql --version` works.

### 2. Create the database and a login

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE poca WITH LOGIN PASSWORD 'choose-a-strong-password';
CREATE DATABASE poca_note OWNER poca;
\q
```

Allow password logins from your machine (usually the default for `localhost` in
`pg_hba.conf`). Test the connection before touching the app:

```bash
psql "postgresql://poca:choose-a-strong-password@127.0.0.1:5432/poca_note" -c "SELECT version();"
```

If your password contains `@`, `:`, `/`, or `#`, percent-encode it in the URL
(for example `p@ss` becomes `p%40ss`). Hosted providers often require
`DATABASE_SSL=1`.

### 3. Back up the current SQLite database

Stop the app first so nothing changes during the copy:

```bash
# stop the running server (Ctrl+C, or the equivalent for your process manager)
npm run db:backup
```

The snapshot is written to `data/backups/poca-note-<timestamp>.db` using SQLite's
`VACUUM INTO`, which produces a consistent single-file copy. Keep this file — it is
the rollback point. You can also choose a destination:

```bash
npm run db:backup -- --out ~/poca-note-before-postgres.db
```

> If `DATABASE_URL` is already set in `.env`, `db:backup` backs up PostgreSQL with
> `pg_dump` instead. To force a SQLite backup, pass `--sqlite data/poca-note.db`.

### 4. Preview and run the migration

The migration copies every table in dependency order, inside one PostgreSQL
transaction, then compares row counts.

```bash
# 1) See what would be copied (reads both databases, writes nothing)
npm run db:to-postgres -- --url "postgresql://poca:choose-a-strong-password@127.0.0.1:5432/poca_note" --dry-run

# 2) Copy the data (automatically snapshots SQLite first)
npm run db:to-postgres -- --url "postgresql://poca:choose-a-strong-password@127.0.0.1:5432/poca_note"
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Print source/target row counts and stop |
| `--force` | Truncate the target tables and copy again (required if the target has rows) |
| `--schema-only` | Create the PostgreSQL schema and copy nothing |
| `--no-backup` | Skip the automatic SQLite snapshot |
| `--sqlite FILE` | Use a different SQLite source file |
| `--url URL` | Use this connection string instead of `DATABASE_URL` |

When it finishes you should see `All row counts match.` If anything mismatches, the
script exits non-zero and leaves the SQLite file untouched; inspect the target
before switching.

### 5. Point the app at PostgreSQL

Add the connection string to `.env` (the value is never sent to the browser):

```dotenv
DATABASE_URL=postgresql://poca:choose-a-strong-password@127.0.0.1:5432/poca_note
# DATABASE_SSL=1            # hosted PostgreSQL / TLS
# DATABASE_TIMEOUT_MS=60000
```

Then build and restart:

```bash
npm install          # already includes the pg driver
npm run build
npm start
```

The start-up log now says `storage: postgresql (DATABASE_URL)`. Sign in with the
same workspace and password as before; cards, subtasks, numbers, reports, and
teammates are all there. New cards continue the workspace's number series.

### 6. Verify, then keep the backup

- Open the board and confirm the cards and **Task 261000001** labels.
- Create a card and a subtask; the numbers should be consecutive.
- Open **Reports** and **AI Skills** once.
- Keep the SQLite snapshot from step 3 until you are confident.

To roll back, remove (or comment out) `DATABASE_URL`, restore the snapshot over the
live file, and restart:

```bash
cp data/backups/poca-note-<timestamp>.db data/poca-note.db
# remove DATABASE_URL from .env
npm start
```

### Backups after the move

```bash
npm run db:backup     # pg_dump --format=custom into data/backups/*.dump
```

Restore a custom-format dump with:

```bash
pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" data/backups/poca-note-<timestamp>.dump
```

> The migration is one-way: it copies SQLite → PostgreSQL. Changes made in
> PostgreSQL afterwards are not written back to SQLite.

---

## Security notes

- Passwords are hashed with **scrypt** and a per-password salt, one hash per user.
- Session tokens are stored hashed and delivered in an HTTP-only, `SameSite=Lax`
  cookie (plus a bearer option for API clients). Removing a login revokes its
  sessions immediately.
- State-changing requests are origin-checked; unknown origins get `403`.
- Production responses set CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy`, and a restrictive `Permissions-Policy`.
- `/` is the public landing page. Other HTML routes redirect server-side to
  `/login?next=…` without a session, and `/login` redirects back to `/board` when
  already authenticated.
- Link-title lookups reject private/loopback/link-local addresses unless
  `ALLOW_PRIVATE_LINK_FETCH=1`. Redirects are followed manually with the guard
  re-applied and a bounded response size.
- Login (10/min), registration (configurable per hour), link lookup (40/min), and
  AI generation (10/min) are rate-limited per tenant or IP.
- Demo credentials are hidden when `SHOW_DEMO_CREDENTIALS` resolves off
  (default in production).
- The Vite dev server is development-only; production serves the built SPA from
  `web/dist` behind the same origin.


---

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + Vite dev server with proxy |
| `npm run dev:server` | API only |
| `npm run dev:web` | Vite only (set `POCA_API_URL` to repoint the proxy) |
| `npm run build` | Build the SPA into `web/dist` |
| `npm start` | Production server |
| `npm test` | Full backend test suite |
| `npm run tenant:create -- <slug> <name> <password>` | Add a workspace |
| `npm run db:backup` | Snapshot SQLite with `VACUUM INTO` (or `pg_dump` when `DATABASE_URL` is set) |
| `npm run db:to-postgres -- --url …` | Copy SQLite into PostgreSQL with an automatic backup and verification |
