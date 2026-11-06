#!/usr/bin/env node
/**
 * Back up the current database.
 *
 *   npm run db:backup                 # back up the SQLite file into data/backups/
 *   npm run db:backup -- --out FILE    # choose the destination
 *
 * With DATABASE_URL set the app uses PostgreSQL instead, so the script asks
 * pg_dump for a custom-format archive (and tells you if pg_dump is missing).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createConfig, loadDotenv, ROOT_DIR } from "../server/config.js";

loadDotenv();

function parseArgs(argv) {
  const out = { out: null, sqlite: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") out.out = argv[++i];
    else if (arg === "--sqlite") out.sqlite = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function defaultSqlitePath() {
  const dir = path.join(ROOT_DIR, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `poca-note-${timestamp()}.db`);
}

function defaultPostgresPath() {
  const dir = path.join(ROOT_DIR, "data", "backups");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `poca-note-${timestamp()}.dump`);
}

/** VACUUM INTO refuses to overwrite, so never hand it an existing name. */
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

function backupSqlite({ dbPath, outPath }) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite database not found: ${dbPath}`);
  }
  // VACUUM INTO writes a consistent snapshot even while the server is running.
  const db = new DatabaseSync(dbPath);
  try {
    const target = outPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${target}';`);
  } finally {
    db.close();
  }
  const bytes = fs.statSync(outPath).size;
  return { outPath, bytes, kind: "sqlite" };
}

function backupPostgres({ connectionString, outPath, ssl }) {
  const args = ["--format=custom", "--no-owner", "--no-acl", `--file=${outPath}`, connectionString];
  const result = spawnSync("pg_dump", args, {
    stdio: "inherit",
    env: { ...process.env, ...(ssl ? { PGSSLMODE: "require" } : {}) },
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(
      "pg_dump was not found. Install the PostgreSQL client tools (the postgresql-client package), then retry:\n" +
        '  pg_dump --format=custom --file=backup.dump "$DATABASE_URL"'
    );
  }
  if (result.status !== 0) throw new Error(`pg_dump exited with status ${result.status}`);
  return { outPath, bytes: fs.statSync(outPath).size, kind: "postgres" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: npm run db:backup -- [--out FILE] [--sqlite FILE]");
    return;
  }
  const config = createConfig();
  const sqlitePath = path.resolve(args.sqlite || config.databasePath.split("?")[0]);
  // `--sqlite` forces a SQLite snapshot even when DATABASE_URL is configured.
  const usePostgres = Boolean(config.databaseUrl) && !args.sqlite;

  const outPath = uniquePath(
    path.resolve(args.out || (usePostgres ? defaultPostgresPath() : defaultSqlitePath()))
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  if (usePostgres) {
    console.log(`Backing up PostgreSQL → ${outPath}`);
    const result = backupPostgres({
      connectionString: config.databaseUrl,
      outPath,
      ssl: config.databaseSsl,
    });
    console.log(`Done: ${result.outPath} (${result.bytes} bytes)`);
    return;
  }

  console.log(`Backing up SQLite ${sqlitePath} → ${outPath}`);
  const result = backupSqlite({ dbPath: sqlitePath, outPath });
  console.log(`Done: ${result.outPath} (${result.bytes} bytes)`);
  console.log("Keep this file somewhere safe; it is the rollback point for the PostgreSQL move.");
}

try {
  main();
} catch (error) {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
}
