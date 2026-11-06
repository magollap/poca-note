import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

/**
 * PostgreSQL schema. It mirrors the SQLite schema, with two portability tweaks:
 * `REAL` becomes `DOUBLE PRECISION`, and case-insensitive uniqueness is done
 * with expression indexes on LOWER(...) instead of SQLite's COLLATE NOCASE.
 */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_slug_lower ON tenants (LOWER(slug));

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'observer')),
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username_lower
  ON users (tenant_id, LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS tenant_state (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
  update_interval_days INTEGER NOT NULL DEFAULT 3,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  accent TEXT NOT NULL DEFAULT 'violet',
  position DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dashboards_tenant ON dashboards (tenant_id, position);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
  task_no TEXT,
  column_key TEXT NOT NULL CHECK (column_key IN ('todo', 'doing', 'review', 'done')),
  position DOUBLE PRECISION NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  link_url TEXT,
  link_title TEXT,
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_tenant_board
  ON cards (tenant_id, deleted_at, column_key, position);
CREATE INDEX IF NOT EXISTS idx_cards_tenant_deleted ON cards (tenant_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_cards_dashboard
  ON cards (dashboard_id, deleted_at, column_key, position);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_task_no
  ON cards (tenant_id, task_no) WHERE task_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_no TEXT,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
  position DOUBLE PRECISION NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checklist_card ON checklist_items (card_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS ux_checklist_task_no
  ON checklist_items (tenant_id, task_no) WHERE task_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  checklist_item_id TEXT REFERENCES checklist_items(id) ON DELETE CASCADE,
  task_no TEXT,
  author TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'status')),
  status TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_updates_card
  ON task_updates (card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_updates_item
  ON task_updates (checklist_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_updates_tenant
  ON task_updates (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_numbers (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  task_no TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_no)
);

CREATE TABLE IF NOT EXISTS task_number_counters (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  next_no INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brief TEXT NOT NULL,
  format TEXT NOT NULL,
  tone TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_tenant ON ai_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_action_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT,
  prompt TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'applied', 'failed')),
  plan TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_action_runs_tenant
  ON ai_action_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
  enabled INTEGER NOT NULL DEFAULT 1,
  send_time TEXT NOT NULL DEFAULT '08:00',
  weekday INTEGER NOT NULL DEFAULT 1,
  day_of_month INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_schedules_tenant
  ON report_schedules (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS report_settings (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  daily_enabled INTEGER NOT NULL DEFAULT 1,
  daily_time TEXT NOT NULL DEFAULT '08:00',
  weekly_enabled INTEGER NOT NULL DEFAULT 1,
  weekly_day INTEGER NOT NULL DEFAULT 1,
  weekly_time TEXT NOT NULL DEFAULT '08:00',
  monthly_enabled INTEGER NOT NULL DEFAULT 1,
  monthly_day INTEGER NOT NULL DEFAULT 1,
  monthly_time TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly', 'brief')),
  period_key TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  metrics TEXT NOT NULL,
  provider TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_scheduled
  ON reports (tenant_id, schedule_id, period_key)
  WHERE trigger = 'scheduled' AND schedule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reports_tenant
  ON reports (tenant_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS link_titles (
  url_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  final_url TEXT,
  title TEXT,
  site_name TEXT,
  fetched_at TEXT NOT NULL
);

-- Upgrades for databases created before status check-ins existed.
ALTER TABLE tenant_state ADD COLUMN IF NOT EXISTS update_interval_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE checklist_items ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'not_started';
UPDATE cards SET status = 'done' WHERE column_key = 'done' AND status = 'not_started';
UPDATE checklist_items SET status = 'done' WHERE done = 1 AND status = 'not_started';

-- Widen the cards column CHECK constraint so existing databases accept the
-- "Under Review" column. Constraint names are generated by PostgreSQL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cards_column_key_check'
      AND conrelid = 'cards'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%review%'
  ) THEN
    ALTER TABLE cards DROP CONSTRAINT cards_column_key_check;
    ALTER TABLE cards ADD CONSTRAINT cards_column_key_check
      CHECK (column_key IN ('todo', 'doing', 'review', 'done'));
  END IF;
END $$;

-- The old "Doing digest" chat reminder feature was removed. Its leftover
-- tables (Slack/Teams webhook settings and run history) are dropped here.
DROP TABLE IF EXISTS reminder_runs;
DROP TABLE IF EXISTS reminder_settings;
`;

/**
 * Translate the SQLite-flavoured SQL used by the app into PostgreSQL:
 * numbered placeholders, INSERT OR IGNORE, and COLLATE NOCASE comparisons.
 * Exported so the migration tests can exercise it directly.
 */
export function convertSql(input) {
  let sql = String(input ?? "");
  sql = sql.replace(/\bBEGIN\s+IMMEDIATE\b/gi, "BEGIN");

  if (/^\s*INSERT\s+OR\s+IGNORE\b/i.test(sql)) {
    sql = sql.replace(/^(\s*)INSERT\s+OR\s+IGNORE\b/i, "$1INSERT");
    const returning = sql.match(/\bRETURNING\b/i);
    if (returning) {
      sql = `${sql.slice(0, returning.index)} ON CONFLICT DO NOTHING ${sql.slice(returning.index)}`;
    } else {
      sql = `${sql.replace(/;\s*$/, "")} ON CONFLICT DO NOTHING`;
    }
  }

  // `WHERE username = ? COLLATE NOCASE` -> `WHERE LOWER(username) = LOWER($1)`
  sql = sql.replace(
    /([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*\?\s+COLLATE\s+NOCASE/gi,
    "LOWER($1) = LOWER(?)"
  );
  sql = sql.replace(/\s+COLLATE\s+NOCASE/gi, "");

  // SQLite's null-safe `IS ?` has no direct PostgreSQL spelling.
  sql = sql.replace(
    /([A-Za-z_][A-Za-z0-9_.]*)\s+IS\s+\?/gi,
    "$1 IS NOT DISTINCT FROM ?"
  );

  return toPostgresPlaceholders(sql);
}

/** Replace `?` outside quoted literals with `$1`, `$2`, ... */
function toPostgresPlaceholders(sql) {
  let out = "";
  let index = 0;
  let count = 0;
  let quote = null;
  while (index < sql.length) {
    const char = sql[index];
    if (quote) {
      out += char;
      if (char === quote) {
        if (sql[index + 1] === quote) {
          out += sql[index + 1];
          index += 2;
          continue;
        }
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "?") {
      out += `$${++count}`;
      index += 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * The app is written against node:sqlite's synchronous API. Rather than
 * rewriting every query, the PostgreSQL client runs in a worker thread and the
 * main thread blocks on a SharedArrayBuffer until the result is available.
 */
class SyncPostgresClient {
  constructor({ connectionString, ssl = false, timeoutMs = 60_000 }) {
    this.timeoutMs = timeoutMs;
    this.flagBuffer = new SharedArrayBuffer(4);
    this.flag = new Int32Array(this.flagBuffer);
    this.nextId = 0;
    this.closed = false;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.worker = new Worker(new URL("./postgres-worker.js", import.meta.url), {
      workerData: {
        port: port2,
        flagBuffer: this.flagBuffer,
        connectionString,
        ssl,
        timeoutMs: this.timeoutMs,
      },
      transferList: [port2],
    });
    this.worker.on("error", (error) => {
      this.failure = error;
      wake(this);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.failure ||= new Error(`PostgreSQL worker exited with code ${code}`);
        wake(this);
      }
    });
    // Handshake: the first call also verifies the connection.
    try {
      this.call("SELECT 1 AS ok");
    } catch (error) {
      this.closed = true;
      try {
        this.port.close();
      } catch {
        // ignore
      }
      this.worker.terminate().catch(() => {});
      throw error;
    }
  }

  call(sql, params = []) {
    const id = ++this.nextId;
    const bound = Array.isArray(params) && params.length
      ? params.map((value) => (value === undefined ? null : value))
      : null;
    this.port.postMessage({ id, sql, params: bound });
    const status = Atomics.wait(this.flag, 0, 0, this.timeoutMs);
    if (status === "timed-out") {
      throw new Error(`PostgreSQL query timed out after ${this.timeoutMs}ms`);
    }
    Atomics.store(this.flag, 0, 0);
    for (let spin = 0; spin < 2_000; spin += 1) {
      const received = receiveMessageOnPort(this.port);
      if (received) {
        if (received.message.id !== id) {
          throw new Error("PostgreSQL worker replied out of order");
        }
        if (received.message.error) throw new Error(received.message.error);
        return received.message.result;
      }
      Atomics.wait(this.flag, 0, 1, 1);
    }
    if (this.failure) throw this.failure;
    throw new Error("PostgreSQL worker returned no result");
  }

  query(sql, params = []) {
    return this.call(convertSql(sql), params);
  }

  exec(sql) {
    const cleaned = String(sql ?? "")
      .replace(/^\s*PRAGMA[^;]*;\s*/gim, "")
      .replace(/\bBEGIN\s+IMMEDIATE\b/gi, "BEGIN");
    if (!cleaned.trim()) return;
    this.call(cleaned);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      const id = ++this.nextId;
      this.port.postMessage({ type: "close", id });
      Atomics.wait(this.flag, 0, 0, 2_000);
      Atomics.store(this.flag, 0, 0);
      receiveMessageOnPort(this.port);
    } catch {
      // already gone
    }
    try {
      this.port.close();
    } catch {
      // ignore
    }
    this.worker.terminate().catch(() => {});
  }
}

function wake(client) {
  Atomics.store(client.flag, 0, 1);
  Atomics.notify(client.flag, 0);
}

export function openPostgresDatabase({ connectionString, ssl = false, timeoutMs, migrate = true } = {}) {
  if (!connectionString) throw new Error("A PostgreSQL connection string is required");
  const client = new SyncPostgresClient({ connectionString, ssl, timeoutMs });
  const db = {
    dialect: "postgres",
    exec(sql) {
      client.exec(sql);
    },
    prepare(sql) {
      return {
        run(...params) {
          const result = client.query(sql, params);
          return { changes: Number(result?.rowCount || 0) };
        },
        get(...params) {
          return client.query(sql, params)?.rows?.[0];
        },
        all(...params) {
          return client.query(sql, params)?.rows || [];
        },
      };
    },
    close() {
      client.close();
    },
  };
  if (migrate) db.exec(POSTGRES_SCHEMA);
  return db;
}
