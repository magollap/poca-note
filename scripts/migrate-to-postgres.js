#!/usr/bin/env node
/**
 * Copy the SQLite database into PostgreSQL.
 *
 *   npm run db:to-postgres -- --dry-run
 *   npm run db:to-postgres -- --url postgresql://user:pass@127.0.0.1:5432/poca_note
 *
 * The source defaults to DATABASE_PATH (data/poca-note.db) and the target to
 * --url, then DATABASE_URL. The script always backs up the SQLite file first
 * (VACUUM INTO) unless --no-backup is passed, creates the PostgreSQL schema,
 * copies every table in dependency order inside one transaction, and verifies
 * the row counts afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConfig, loadDotenv, ROOT_DIR } from "../server/config.js";
import { openDb, initializeTaskCounters } from "../server/db.js";
import { openPostgresDatabase, POSTGRES_SCHEMA } from "../server/postgres.js";

loadDotenv();

const TABLES = [
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
];

function parseArgs(argv) {
  const out = { dryRun: false, force: false, schemaOnly: false, backup: true, url: null, sqlite: null, batch: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--schema-only") out.schemaOnly = true;
    else if (arg === "--no-backup") out.backup = false;
    else if (arg === "--url") out.url = argv[++i];
    else if (arg === "--sqlite") out.sqlite = argv[++i];
    else if (arg === "--batch") out.batch = Math.max(1, Number(argv[++i]) || 200);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function uniquePath(file) {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find a free backup name near ${file}`);
}

function backupSqlite(dbPath) {
  const dir = path.join(ROOT_DIR, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  const outPath = uniquePath(path.join(dir, `poca-note-${timestamp()}.db`));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}';`);
  } finally {
    db.close();
  }
  return outPath;
}

function tableColumns(sqlite, table) {
  return sqlite
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .map((row) => row.name);
}

function tableRows(sqlite, table) {
  return sqlite.prepare(`SELECT * FROM ${JSON.stringify(table)}`).all();
}

function pgCount(db, table) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(table)}`).get();
  return Number(row?.count || 0);
}

function copyRows({ sqlite, pg, table, columns, rows, batch }) {
  if (!rows.length) return;
  const quoted = columns.map((name) => `"${name}"`).join(", ");
  const placeholders = `(${columns.map(() => "?").join(", ")})`;
  for (let offset = 0; offset < rows.length; offset += batch) {
    const chunk = rows.slice(offset, offset + batch);
    const values = [];
    const tuples = chunk.map((row) => {
      for (const column of columns) values.push(row[column] === undefined ? null : row[column]);
      return placeholders;
    });
    pg.prepare(
      `INSERT INTO ${JSON.stringify(table)} (${quoted}) VALUES ${tuples.join(", ")} ON CONFLICT DO NOTHING`
    ).run(...values);
  }
}

function truncateAll(pg) {
  const list = TABLES.map((table) => `"${table}"`).join(", ");
  pg.exec(`TRUNCATE ${list} RESTART IDENTITY CASCADE;`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npm run db:to-postgres -- [options]

Options:
  --url URL        PostgreSQL connection string (default: DATABASE_URL)
  --sqlite FILE    SQLite file to copy (default: DATABASE_PATH)
  --dry-run        Show what would be copied; do not write rows
  --force          Replace existing rows in the target tables
  --schema-only    Create the PostgreSQL schema and stop
  --no-backup      Skip the automatic SQLite snapshot
  --batch N        Rows per INSERT (default: 200)`);
    return;
  }

  const config = createConfig();
  const url = String(args.url || config.databaseUrl || "").trim();
  if (!url) {
    throw new Error(
      "No PostgreSQL connection string. Pass --url postgresql://… or set DATABASE_URL in .env"
    );
  }
  const sqlitePath = path.resolve(args.sqlite || config.databasePath.split("?")[0]);
  if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite database not found: ${sqlitePath}`);

  console.log(`Source: ${sqlitePath}`);
  console.log(`Target: ${url.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@")}`);

  let backupPath = null;
  if (args.backup && !args.dryRun) {
    backupPath = backupSqlite(sqlitePath);
    console.log(`Backup: ${backupPath}`);
  }

  const sqlite = openDb(sqlitePath);
  let pg;
  try {
    // Read the source fully first; this also runs pending SQLite migrations.
    const snapshot = {};
    for (const table of TABLES) {
      const columns = tableColumns(sqlite, table);
      const rows = tableRows(sqlite, table);
      snapshot[table] = { columns, rows };
    }

    pg = openPostgresDatabase({
      connectionString: url,
      ssl: config.databaseSsl,
      timeoutMs: config.databaseTimeoutMs,
      migrate: false,
    });

    if (args.schemaOnly) {
      pg.exec(POSTGRES_SCHEMA);
      console.log("PostgreSQL schema created (no rows copied).");
      return;
    }

    const existing = {};
    let hasData = false;
    for (const table of TABLES) {
      // The schema may not exist yet, so guard each count.
      try {
        existing[table] = pgCount(pg, table);
        if (existing[table] > 0) hasData = true;
      } catch {
        existing[table] = 0;
      }
    }

    if (args.dryRun) {
      console.log("\nDry run — nothing will be written.\n");
      for (const table of TABLES) {
        console.log(
          `${table.padEnd(22)} sqlite=${String(snapshot[table].rows.length).padStart(5)}  postgres=${String(existing[table]).padStart(5)}`
        );
      }
      if (hasData && !args.force) {
        console.log("\nThe target already has data. Re-run with --force to replace it.");
      }
      return;
    }

    pg.exec(POSTGRES_SCHEMA);

    if (hasData && !args.force) {
      throw new Error(
        "The PostgreSQL database already contains rows. Re-run with --force to truncate the target tables and copy again."
      );
    }

    pg.exec("BEGIN");
    try {
      if (hasData) {
        console.log("Clearing existing target rows (--force)…");
        truncateAll(pg);
      }
      let total = 0;
      for (const table of TABLES) {
        const { columns, rows } = snapshot[table];
        copyRows({ sqlite, pg, table, columns, rows, batch: args.batch });
        total += rows.length;
        console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(5)} rows`);
      }
      pg.exec("COMMIT");
      console.log(`\nCopied ${total} rows.`);
    } catch (error) {
      try {
        pg.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    }

    // Older SQLite files may not have counters yet; make sure every workspace
    // has a running series before the app serves requests.
    initializeTaskCounters(pg);

    console.log("\nVerifying row counts…");
    let mismatches = 0;
    for (const table of TABLES) {
      const expected = snapshot[table].rows.length;
      const actual = pgCount(pg, table);
      if (actual !== expected) {
        mismatches += 1;
        console.error(`  MISMATCH ${table}: sqlite=${expected} postgres=${actual}`);
      }
    }
    if (mismatches) {
      throw new Error(
        `${mismatches} table(s) did not match. The SQLite backup is untouched; inspect the target before switching.`
      );
    }
    console.log("All row counts match.");
    console.log("\nNext steps:");
    console.log("  1. Add DATABASE_URL=<your connection string> to .env");
    console.log("  2. Restart the app: npm start");
    console.log("  3. The login page should greet your existing workspace.");
    if (backupPath) console.log(`Rollback point: ${backupPath}`);
  } finally {
    sqlite.close();
    pg?.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(`\nMigration failed: ${error.message}`);
  process.exit(1);
}
