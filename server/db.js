import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { openPostgresDatabase } from "./postgres.js";

export function nowIso() {
  return new Date().toISOString();
}

export function openDb(file) {
  if (file !== ":memory:") {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/**
 * Open the configured storage backend. DATABASE_URL switches the app to
 * PostgreSQL; otherwise SQLite remains the default.
 */
export function openDatabase(config) {
  if (config?.databaseUrl) {
    const db = openPostgresDatabase({
      connectionString: config.databaseUrl,
      ssl: Boolean(config.databaseSsl),
      timeoutMs: config.databaseTimeoutMs,
    });
    initializeTaskCounters(db);
    return db;
  }
  return openDb(config?.databasePath || "./data/poca-note.db");
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      username TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'observer')),
      created_at TEXT NOT NULL,
      last_login_at TEXT,
      UNIQUE (tenant_id, username)
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);

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
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dashboards_tenant
      ON dashboards(tenant_id, position);

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
      task_no TEXT,
      column_key TEXT NOT NULL CHECK (column_key IN ('todo', 'doing', 'review', 'done')),
      position REAL NOT NULL,
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
      ON cards(tenant_id, deleted_at, column_key, position);
    CREATE INDEX IF NOT EXISTS idx_cards_tenant_deleted
      ON cards(tenant_id, deleted_at);

    CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      task_no TEXT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
      position REAL NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checklist_card ON checklist_items(card_id, position);

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
      ON task_updates(card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_updates_item
      ON task_updates(checklist_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_updates_tenant
      ON task_updates(tenant_id, created_at DESC);

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
    CREATE INDEX IF NOT EXISTS idx_ai_runs_tenant ON ai_runs(tenant_id, created_at DESC);

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
      ON ai_action_runs(tenant_id, created_at DESC);

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
      ON report_schedules(tenant_id, created_at);

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
      ON reports(tenant_id, schedule_id, period_key)
      WHERE trigger = 'scheduled' AND schedule_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_reports_tenant
      ON reports(tenant_id, kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS link_titles (
      url_key TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      final_url TEXT,
      title TEXT,
      site_name TEXT,
      fetched_at TEXT NOT NULL
    );
  `);

  migrateUsers(db);
  migrateUserRoles(db);
  migrateDashboards(db);
  migrateTaskNumbers(db);
  migrateStatusTracking(db);
  migrateReportSchedules(db);
  dropLegacyDigestTables(db);
  migrateBoardColumns(db);
}

/**
 * The old "Doing digest" chat reminder feature (Slack/Teams webhooks) was
 * removed. Drop its leftover tables so no webhook URLs, payloads, or run
 * history can survive an upgrade.
 */
export function dropLegacyDigestTables(db) {
  db.exec("DROP TABLE IF EXISTS reminder_runs;");
  db.exec("DROP TABLE IF EXISTS reminder_settings;");
}

function columnExists(db, table, column) {
  let columns;
  try {
    columns = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return false;
  }
  return columns.some((entry) => entry.name === column);
}

/**
 * Upgrade databases created before workspaces supported more than one login.
 * Each existing tenant's password becomes its owner account, and sessions that
 * predate users keep working by resolving to that owner.
 */
function migrateUsers(db) {
  if (!columnExists(db, "sessions", "user_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);");

  const owners = db
    .prepare(
      `SELECT t.id AS tenant_id, t.slug, t.name, t.password_hash
       FROM tenants t
       LEFT JOIN users u ON u.tenant_id = t.id AND u.role = 'owner'
       WHERE u.id IS NULL`
    )
    .all();
  if (!owners.length) return;
  const timestamp = nowIso();
  const insert = db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, 'owner', ?)`
  );
  for (const tenant of owners) {
    insert.run(crypto.randomUUID(), tenant.tenant_id, tenant.slug, tenant.name, tenant.password_hash, timestamp);
  }
}

/**
 * owner / editor / observer replaced the old owner / member pair. SQLite cannot
 * relax a CHECK constraint in place, so rebuild the table once and map every
 * legacy "member" to the equivalent "editor" role.
 */
function migrateUserRoles(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get();
  if (!table?.sql || /observer/i.test(table.sql)) return;

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE users_role_migration (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        username TEXT NOT NULL COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'observer')),
        created_at TEXT NOT NULL,
        last_login_at TEXT,
        UNIQUE (tenant_id, username)
      );
    `);
    db.exec(`
      INSERT INTO users_role_migration
        (id, tenant_id, username, display_name, password_hash, role, created_at, last_login_at)
      SELECT id, tenant_id, username, display_name, password_hash,
             CASE role WHEN 'owner' THEN 'owner' ELSE 'editor' END,
             created_at, last_login_at
      FROM users;
    `);
    db.exec("DROP TABLE users;");
    db.exec("ALTER TABLE users_role_migration RENAME TO users;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);");
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the transaction may already be closed
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

export const DASHBOARD_ACCENTS = [
  "emerald",
  "amber",
  "orange",
  "green",
  "gold",
  "violet",
  "cyan",
  "rose",
  "sky",
];

function migrateDashboards(db) {
  if (!columnExists(db, "cards", "dashboard_id")) {
    db.exec(
      "ALTER TABLE cards ADD COLUMN dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE;"
    );
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_cards_dashboard ON cards(dashboard_id, deleted_at, column_key, position);"
  );
  ensureDashboards(db);
}

export const TASK_NO_SEQUENCE_DIGITS = 5;
export const TASK_NO_RE = /^\d{9,10}$/;

/** YYMM prefix from a date (UTC, so numbers are stable across servers). */
export function taskNoPeriod(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  const source = Number.isNaN(value.getTime()) ? new Date() : value;
  const year = String(source.getUTCFullYear()).slice(-2);
  const month = String(source.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

export function formatTaskNo(period, sequence) {
  return `${period}${String(sequence).padStart(TASK_NO_SEQUENCE_DIGITS, "0")}`;
}

function isTaskNo(value) {
  return TASK_NO_RE.test(String(value || ""));
}

function taskCounterHasPeriod(db) {
  try {
    db.prepare("SELECT period FROM task_number_counters LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

function ensureTaskNumberStorage(db) {
  db.exec(`
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
  `);
  if (!taskCounterHasPeriod(db)) {
    db.exec("DROP TABLE IF EXISTS task_number_counters;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_number_counters (
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        period TEXT NOT NULL,
        next_no INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, period)
      );
    `);
  }
}

function rowsNeedingRenumber(db) {
  const rows = db
    .prepare(
      `SELECT task_no FROM cards
       UNION ALL
       SELECT task_no FROM checklist_items`
    )
    .all();
  return rows.some((row) => !isTaskNo(row.task_no));
}

/**
 * The numbers moved from a six digit series to YYMM + five digit sequence.
 * Renumber every existing card and subtask once, grouped by creation month.
 */
function renumberTaskNumbers(db) {
  const rows = db
    .prepare(
      `SELECT 'cards' AS kind, id, tenant_id, created_at FROM cards
       UNION ALL
       SELECT 'checklist_items' AS kind, id, tenant_id, created_at FROM checklist_items
       ORDER BY tenant_id ASC, created_at ASC, id ASC`
    )
    .all();
  const counters = new Map();
  const update = {
    cards: db.prepare("UPDATE cards SET task_no = ? WHERE id = ? AND tenant_id = ?"),
    checklist_items: db.prepare("UPDATE checklist_items SET task_no = ? WHERE id = ? AND tenant_id = ?"),
  };
  const register = db.prepare(
    "INSERT OR IGNORE INTO task_numbers (tenant_id, task_no, created_at) VALUES (?, ?, ?)"
  );

  withTx(db, () => {
    db.exec("UPDATE cards SET task_no = NULL;");
    db.exec("UPDATE checklist_items SET task_no = NULL;");
    db.exec("DELETE FROM task_numbers;");
    db.exec("DELETE FROM task_number_counters;");
    const timestamp = nowIso();
    for (const row of rows) {
      const period = taskNoPeriod(row.created_at || timestamp);
      const key = `${row.tenant_id}:${period}`;
      const sequence = (counters.get(key) || 0) + 1;
      counters.set(key, sequence);
      const taskNo = formatTaskNo(period, sequence);
      update[row.kind].run(taskNo, row.id, row.tenant_id);
      register.run(row.tenant_id, taskNo, timestamp);
    }
    const insertCounter = db.prepare(
      `INSERT INTO task_number_counters (tenant_id, period, next_no) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id, period) DO NOTHING`
    );
    for (const [key, sequence] of counters) {
      const split = key.lastIndexOf(":");
      insertCounter.run(key.slice(0, split), key.slice(split + 1), sequence + 1);
    }
  });
}

function migrateTaskNumbers(db) {
  if (!columnExists(db, "cards", "task_no")) {
    db.exec("ALTER TABLE cards ADD COLUMN task_no TEXT;");
  }
  if (!columnExists(db, "checklist_items", "task_no")) {
    db.exec("ALTER TABLE checklist_items ADD COLUMN task_no TEXT;");
  }
  ensureTaskNumberStorage(db);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_task_no
       ON cards(tenant_id, task_no) WHERE task_no IS NOT NULL;`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_checklist_task_no
       ON checklist_items(tenant_id, task_no) WHERE task_no IS NOT NULL;`
  );
  if (rowsNeedingRenumber(db)) renumberTaskNumbers(db);
}

/**
 * Make sure the numbering schema exists (used by both backends). PostgreSQL
 * connects before migrateTaskNumbers can inspect SQLite metadata, so this
 * export also upgrades an older counter table and renumbers legacy rows.
 */
export function initializeTaskCounters(db) {
  ensureTaskNumberStorage(db);
  if (rowsNeedingRenumber(db)) renumberTaskNumbers(db);
}

/**
 * Status check-ins: each card and checklist item carries a status, and every
 * status change or manual note lands in task_updates. Older databases get the
 * columns and table added in place.
 */
function migrateStatusTracking(db) {
  if (!columnExists(db, "cards", "status")) {
    db.exec("ALTER TABLE cards ADD COLUMN status TEXT NOT NULL DEFAULT 'not_started';");
    db.exec(`
      UPDATE cards
      SET status = CASE
        WHEN column_key = 'done' THEN 'done'
        WHEN column_key IN ('doing', 'review') THEN 'in_progress'
        ELSE 'not_started'
      END
    `);
  }
  if (!columnExists(db, "checklist_items", "status")) {
    db.exec("ALTER TABLE checklist_items ADD COLUMN status TEXT NOT NULL DEFAULT 'not_started';");
    db.exec("UPDATE checklist_items SET status = CASE WHEN done = 1 THEN 'done' ELSE 'not_started' END;");
  }
  if (!columnExists(db, "tenant_state", "update_interval_days")) {
    db.exec("ALTER TABLE tenant_state ADD COLUMN update_interval_days INTEGER NOT NULL DEFAULT 3;");
  }
  db.exec(`
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
      ON task_updates(card_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_updates_item
      ON task_updates(checklist_item_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_updates_tenant
      ON task_updates(tenant_id, created_at DESC);
  `);
}

/**
 * Widen the cards CHECK constraint to include the "Under Review" column. SQLite
 * cannot alter a CHECK in place, so rebuild the table once and recreate the
 * indexes that lived on it. Safe to run on every boot: it exits as soon as the
 * current schema already allows review.
 */
function migrateBoardColumns(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cards'")
    .get();
  if (!table?.sql || table.sql.includes("'review'")) return;

  db.exec("PRAGMA foreign_keys = OFF;");
  try {
    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE cards_column_migration (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        dashboard_id TEXT REFERENCES dashboards(id) ON DELETE CASCADE,
        task_no TEXT,
        column_key TEXT NOT NULL CHECK (column_key IN ('todo', 'doing', 'review', 'done')),
        position REAL NOT NULL,
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
      INSERT INTO cards_column_migration
        (id, tenant_id, dashboard_id, task_no, column_key, position, title, notes, link_url, link_title,
         due_date, priority, status, version, created_at, updated_at, completed_at, deleted_at)
      SELECT id, tenant_id, dashboard_id, task_no, column_key, position, title, notes, link_url, link_title,
             due_date, priority, status, version, created_at, updated_at, completed_at, deleted_at
      FROM cards;
      DROP TABLE cards;
      ALTER TABLE cards_column_migration RENAME TO cards;
    `);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the transaction may already be closed
    }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cards_tenant_board
      ON cards(tenant_id, deleted_at, column_key, position);
    CREATE INDEX IF NOT EXISTS idx_cards_tenant_deleted
      ON cards(tenant_id, deleted_at);
    CREATE INDEX IF NOT EXISTS idx_cards_dashboard
      ON cards(dashboard_id, deleted_at, column_key, position);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_cards_task_no
      ON cards(tenant_id, task_no) WHERE task_no IS NOT NULL;
  `);
}

/**
 * Reserve the next YYMM-prefixed number in this workspace's monthly series.
 * The period comes from the creation date, so a new month starts at 00001.
 */
export function allocateTaskNo(db, tenantId, date = new Date()) {
  ensureTaskNumberStorage(db);
  const period = taskNoPeriod(date);
  const read = db.prepare(
    "SELECT next_no FROM task_number_counters WHERE tenant_id = ? AND period = ?"
  );
  const advance = db.prepare(
    "UPDATE task_number_counters SET next_no = ? WHERE tenant_id = ? AND period = ?"
  );
  const start = db.prepare(
    `INSERT INTO task_number_counters (tenant_id, period, next_no) VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, period) DO NOTHING`
  );
  const claim = db.prepare(
    `INSERT INTO task_numbers (tenant_id, task_no, created_at) VALUES (?, ?, ?)
     ON CONFLICT(tenant_id, task_no) DO NOTHING`
  );
  start.run(tenantId, period, 1);
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const row = read.get(tenantId, period);
    const candidate = Math.max(1, Number(row?.next_no) || 1);
    advance.run(candidate + 1, tenantId, period);
    const taskNo = formatTaskNo(period, candidate);
    const claimed = claim.run(tenantId, taskNo, nowIso());
    if (Number(claimed.changes) > 0) return taskNo;
  }
  throw new Error("This workspace has used all task numbers for this month.");
}

export function ensureDashboards(db) {
  const tenants = db
    .prepare(
      `SELECT t.id AS tenant_id
       FROM tenants t
       LEFT JOIN dashboards d ON d.tenant_id = t.id
       WHERE d.id IS NULL`
    )
    .all();
  const timestamp = nowIso();
  const insert = db.prepare(
    `INSERT INTO dashboards (id, tenant_id, name, accent, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, ?, ?)`
  );
  for (const tenant of tenants) {
    insert.run(crypto.randomUUID(), tenant.tenant_id, "My board", "emerald", timestamp, timestamp);
  }
  // Cards created before dashboards existed belong to the oldest board.
  db.exec(
    `UPDATE cards
     SET dashboard_id = (
       SELECT d.id FROM dashboards d
       WHERE d.tenant_id = cards.tenant_id
       ORDER BY d.position, d.created_at
       LIMIT 1
     )
     WHERE dashboard_id IS NULL`
  );
}

function migrateReportSchedules(db) {
  if (!columnExists(db, "reports", "schedule_id")) {
    db.exec("ALTER TABLE reports ADD COLUMN schedule_id TEXT;");
  }
  db.exec("DROP INDEX IF EXISTS ux_reports_scheduled;");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_scheduled
       ON reports(tenant_id, schedule_id, period_key)
       WHERE trigger = 'scheduled' AND schedule_id IS NOT NULL;`
  );
  ensureReportSchedules(db);
}

/**
 * Every workspace starts with one daily, one weekly, and one monthly schedule.
 * Existing databases keep their previous report_settings times.
 */
export function ensureReportSchedules(db) {
  const tenants = db.prepare("SELECT id FROM tenants").all();
  for (const tenant of tenants) {
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM report_schedules WHERE tenant_id = ?")
      .get(tenant.id);
    if (Number(count.count) > 0) continue;
    const settings = db.prepare("SELECT * FROM report_settings WHERE tenant_id = ?").get(tenant.id);
    seedReportSchedules(db, tenant.id, {
      time: settings?.daily_time || "08:00",
      timezone: settings?.timezone || "UTC",
      weeklyTime: settings?.weekly_time,
      weeklyDay: settings?.weekly_day,
      monthlyTime: settings?.monthly_time,
      monthlyDay: settings?.monthly_day,
      dailyEnabled: settings ? Boolean(settings.daily_enabled) : true,
      weeklyEnabled: settings ? Boolean(settings.weekly_enabled) : true,
      monthlyEnabled: settings ? Boolean(settings.monthly_enabled) : true,
    });
  }
}

export function seedReportSchedules(db, tenantId, options = {}) {
  const timestamp = nowIso();
  const insert = db.prepare(
    `INSERT INTO report_schedules
       (id, tenant_id, kind, enabled, send_time, weekday, day_of_month, timezone, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const timezone = options.timezone || "UTC";
  const time = options.time || "08:00";
  const specs = [
    { kind: "daily", time, weekday: 1, day: 1, enabled: options.dailyEnabled },
    {
      kind: "weekly",
      time: options.weeklyTime || time,
      weekday: options.weeklyDay ?? 1,
      day: 1,
      enabled: options.weeklyEnabled,
    },
    {
      kind: "monthly",
      time: options.monthlyTime || time,
      weekday: 1,
      day: options.monthlyDay ?? 1,
      enabled: options.monthlyEnabled,
    },
  ];
  for (const spec of specs) {
    insert.run(
      crypto.randomUUID(),
      tenantId,
      spec.kind,
      spec.enabled === false ? 0 : 1,
      spec.time,
      spec.weekday,
      spec.day,
      timezone,
      "",
      timestamp
    );
  }
}

export function withTx(db, fn) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore rollback failures
    }
    throw error;
  }
}

export function ensureTenantState(db, tenantId) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO tenant_state (tenant_id, revision, updated_at)
     VALUES (?, 1, ?)
     ON CONFLICT(tenant_id) DO NOTHING`
  ).run(tenantId, timestamp);
}

export function getRevision(db, tenantId) {
  const row = db
    .prepare("SELECT revision FROM tenant_state WHERE tenant_id = ?")
    .get(tenantId);
  return row ? Number(row.revision) : 1;
}

/** Bump and return the tenant's monotonically increasing board revision. */
export function bumpRevision(db, tenantId) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO tenant_state (tenant_id, revision, updated_at)
     VALUES (?, 2, ?)
     ON CONFLICT(tenant_id) DO UPDATE
       SET revision = tenant_state.revision + 1, updated_at = excluded.updated_at`
  ).run(tenantId, timestamp);
  return getRevision(db, tenantId);
}

export function createTenant(db, { id, slug, name, passwordHash, ownerUsername, reportTime = "08:00", reportTimezone = "UTC" }) {
  const timestamp = nowIso();
  return withTx(db, () => {
    db.prepare(
      `INSERT INTO tenants (id, slug, name, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, slug, name, passwordHash, timestamp);
    ensureTenantState(db, id);
    db.prepare(
      `INSERT INTO dashboards (id, tenant_id, name, accent, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1000, ?, ?)`
    ).run(crypto.randomUUID(), id, "My board", "emerald", timestamp, timestamp);
    db.prepare(
      `INSERT INTO report_settings
         (tenant_id, daily_enabled, daily_time, weekly_enabled, weekly_day, weekly_time,
          monthly_enabled, monthly_day, monthly_time, timezone, updated_at)
       VALUES (?, 1, ?, 1, 1, ?, 1, 1, ?, ?, ?)`
    ).run(id, reportTime, reportTime, reportTime, reportTimezone, timestamp);
    seedReportSchedules(db, id, {
      time: reportTime,
      timezone: reportTimezone,
    });
    db.prepare(
      `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
       VALUES (?, ?, ?, ?, ?, 'owner', ?)`
    ).run(crypto.randomUUID(), id, ownerUsername || slug, name, passwordHash, timestamp);
    return id;
  });
}

export function createUser(db, { id, tenantId, username, displayName, passwordHash, role = "editor" }) {
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO users (id, tenant_id, username, display_name, password_hash, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, tenantId, username, displayName || username, passwordHash, role, timestamp);
  return getUserById(db, id);
}

export function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function getUserByUsername(db, tenantId, username) {
  return db
    .prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ? COLLATE NOCASE")
    .get(tenantId, username);
}

export function listUsers(db, tenantId) {
  return db
    .prepare(
      `SELECT id, username, display_name, role, created_at, last_login_at
       FROM users WHERE tenant_id = ?
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, created_at ASC`
    )
    .all(tenantId);
}

export function countOwners(db, tenantId) {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE tenant_id = ? AND role = 'owner'")
    .get(tenantId);
  return Number(row.count);
}

export function updateUser(db, tenantId, userId, { displayName, passwordHash, role }) {
  const sets = [];
  const values = [];
  if (displayName !== undefined) {
    sets.push("display_name = ?");
    values.push(displayName);
  }
  if (passwordHash !== undefined) {
    sets.push("password_hash = ?");
    values.push(passwordHash);
  }
  if (role !== undefined) {
    sets.push("role = ?");
    values.push(role);
  }
  if (!sets.length) return getUserById(db, userId);
  values.push(userId, tenantId);
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...values);
  return getUserById(db, userId);
}

export function deleteUser(db, tenantId, userId) {
  db.prepare("DELETE FROM users WHERE id = ? AND tenant_id = ?").run(userId, tenantId);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND tenant_id = ?").run(userId, tenantId);
}

export function touchUserLogin(db, userId) {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), userId);
}


export function getTenantBySlug(db, slug) {
  return db.prepare("SELECT * FROM tenants WHERE slug = ? COLLATE NOCASE").get(slug);
}

export function getTenantById(db, id) {
  return db.prepare("SELECT * FROM tenants WHERE id = ?").get(id);
}

export function getDemoTenant(db, config) {
  return getTenantBySlug(db, config.demo.slug);
}
