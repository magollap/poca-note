import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../server/db.js";
import { testConfig } from "./helpers.mjs";

test("legacy Doing digest tables are dropped on startup", () => {
  const config = testConfig();
  const first = openDb(config.databasePath);
  first.exec(`
    CREATE TABLE reminder_settings (
      tenant_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      send_time TEXT,
      timezone TEXT,
      webhook_url TEXT,
      updated_at TEXT
    );
    CREATE TABLE reminder_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kind TEXT,
      local_date TEXT,
      status TEXT,
      target TEXT,
      detail TEXT,
      card_count INTEGER,
      payload TEXT,
      created_at TEXT
    );
    INSERT INTO reminder_settings (tenant_id, enabled, webhook_url)
      VALUES ('tenant-1', 1, 'https://hooks.slack.com/services/old');
  `);
  first.close();

  const reopened = openDb(config.databasePath);
  try {
    const tables = reopened
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'reminder_%' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    assert.deepEqual(tables, []);
  } finally {
    reopened.close();
  }
});
