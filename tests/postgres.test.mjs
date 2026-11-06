import test from "node:test";
import assert from "node:assert/strict";
import { convertSql, openPostgresDatabase, POSTGRES_SCHEMA } from "../server/postgres.js";
import { createCard } from "../server/board.js";
import { createTenant, initializeTaskCounters } from "../server/db.js";
import { hashPassword } from "../server/auth.js";

test("convertSql numbers placeholders outside string literals", () => {
  assert.equal(
    convertSql("SELECT * FROM users WHERE tenant_id = ? AND username = ?"),
    "SELECT * FROM users WHERE tenant_id = $1 AND username = $2"
  );
  assert.equal(
    convertSql("SELECT '?' AS literal, ? AS value, \"?\" AS identifier"),
    "SELECT '?' AS literal, $1 AS value, \"?\" AS identifier"
  );
  assert.equal(convertSql("SELECT 1"), "SELECT 1");
});

test("convertSql maps SQLite case-insensitive and null-safe comparisons", () => {
  assert.equal(
    convertSql("SELECT * FROM users WHERE tenant_id = ? AND username = ? COLLATE NOCASE"),
    "SELECT * FROM users WHERE tenant_id = $1 AND LOWER(username) = LOWER($2)"
  );
  assert.equal(
    convertSql("SELECT * FROM tenants WHERE slug = ? COLLATE NOCASE"),
    "SELECT * FROM tenants WHERE LOWER(slug) = LOWER($1)"
  );
  assert.equal(
    convertSql("SELECT * FROM reports WHERE tenant_id = ? AND schedule_id IS ? AND kind = ?"),
    "SELECT * FROM reports WHERE tenant_id = $1 AND schedule_id IS NOT DISTINCT FROM $2 AND kind = $3"
  );
});

test("convertSql handles INSERT OR IGNORE and transactions", () => {
  assert.equal(
    convertSql("INSERT OR IGNORE INTO task_numbers (tenant_id, task_no) VALUES (?, ?)"),
    "INSERT INTO task_numbers (tenant_id, task_no) VALUES ($1, $2) ON CONFLICT DO NOTHING"
  );
  assert.equal(convertSql("BEGIN IMMEDIATE;"), "BEGIN;");
  assert.match(convertSql("PRAGMA foreign_keys = ON;"), /^PRAGMA foreign_keys = ON;$/);
});

test("the PostgreSQL schema covers every application table", () => {
  for (const table of [
    "tenants",
    "users",
    "sessions",
    "tenant_state",
    "dashboards",
    "cards",
    "checklist_items",
    "task_updates",
    "task_numbers",
    "task_number_counters",
    "ai_runs",
    "ai_action_runs",
    "report_schedules",
    "report_settings",
    "reports",
    "link_titles",
  ]) {
    assert.match(POSTGRES_SCHEMA, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), table);
  }
  assert.match(POSTGRES_SCHEMA, /position DOUBLE PRECISION/);
  assert.match(POSTGRES_SCHEMA, /LOWER\(slug\)/);
});

/**
 * Opt-in integration test. Point TEST_POSTGRES_URL at a disposable database
 * whose name ends with `_test`; the test truncates every application table.
 */
const pgUrl = process.env.TEST_POSTGRES_URL || "";

test(
  "PostgreSQL stores tenants, cards, and subtasks with consecutive numbers",
  { skip: !pgUrl && "set TEST_POSTGRES_URL to a disposable *_test database" },
  () => {
    assert.match(pgUrl, /_test(\?|$)/, "refusing to run against a non-test database");
    const db = openPostgresDatabase({ connectionString: pgUrl, migrate: true });
    try {
      db.exec(
        `TRUNCATE tenants, users, sessions, tenant_state, dashboards, cards, checklist_items,
         task_updates, task_numbers, task_number_counters, ai_runs,
         ai_action_runs, report_schedules, report_settings, reports, link_titles CASCADE`
      );
      createTenant(db, {
        id: "tenant-pg",
        slug: "pgtest",
        name: "PG Test",
        passwordHash: hashPassword("password-123"),
      });
      initializeTaskCounters(db);

      const first = createCard(db, "tenant-pg", { title: "First" }).card;
      const second = createCard(db, "tenant-pg", { title: "Second" }).card;
      assert.equal(Number(second.taskNo), Number(first.taskNo) + 1);

      const row = db
        .prepare("SELECT COUNT(*) AS count FROM cards WHERE tenant_id = ?")
        .get("tenant-pg");
      assert.equal(Number(row.count), 2);

      // Case-insensitive lookups use the expression index.
      const user = db
        .prepare("SELECT * FROM users WHERE tenant_id = ? AND username = ? COLLATE NOCASE")
        .get("tenant-pg", "PGTEST");
      assert.equal(user?.role, "owner");
    } finally {
      db.close();
    }
  }
);
