#!/usr/bin/env node
/**
 * poca-note doctor.
 *
 *   npm run doctor
 *
 * Checks the runtime, the web build, .env, data permissions, and the port,
 * then prints what to fix. It is safe to run while the app is running.
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { createConfig, loadDotenv, ROOT_DIR } from "../server/config.js";

const results = [];

function record(status, name, detail, hint = "") {
  results.push({ status, name, detail, hint });
}

const ok = (name, detail) => record("ok", name, detail);
const warn = (name, detail, hint = "") => record("warn", name, detail, hint);
const fail = (name, detail, hint = "") => record("fail", name, detail, hint);

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (status) => {
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(1200);
    socket.once("connect", () => finish("in-use"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error) => {
      finish(error.code === "ECONNREFUSED" ? "free" : "unknown");
    });
  });
}

async function probeHttp(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Node.js
const nodeVersion = process.versions.node;
const nodeParts = parseVersion(nodeVersion);
const nodeOk = Boolean(
  nodeParts && (nodeParts[0] > 22 || (nodeParts[0] === 22 && nodeParts[1] >= 13))
);
if (nodeOk) {
  ok("Node.js", `v${nodeVersion}`);
} else {
  fail(
    "Node.js",
    `v${nodeVersion} (need 22.13+)`,
    "Install Node.js 22.13+ or 24: https://nodejs.org/ or `nvm install 24`."
  );
}

// node:sqlite
let sqliteOk = false;
let sqliteError = "";
try {
  await import("node:sqlite");
  sqliteOk = true;
} catch (error) {
  sqliteError = error?.code || error?.message || String(error);
}
if (sqliteOk) {
  ok("node:sqlite", "available");
} else {
  fail(
    "node:sqlite",
    sqliteError,
    "Upgrade Node.js to 22.13+ or 24. Node 22.5–22.12 needs a flag and is not supported."
  );
}

// npm
let npmVersion = "";
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  npmVersion = execFileSync(npm, ["--version"], { encoding: "utf8" }).trim();
} catch {
  npmVersion = "";
}
const npmParts = parseVersion(npmVersion);
if (npmParts && npmParts[0] >= 10) {
  ok("npm", npmVersion);
} else if (npmVersion) {
  warn("npm", `${npmVersion} (10+ recommended)`, "Upgrade Node.js/npm.");
} else {
  fail("npm", "not found", "Install Node.js, which includes npm.");
}

// node_modules
const modules = path.join(ROOT_DIR, "node_modules");
if (fs.existsSync(modules)) {
  ok("node_modules", "present");
} else {
  fail("node_modules", "missing", "Run `npm ci` or `npm install`.");
}

for (const pkg of ["express", "react", "react-dom", "lucide-react", "pg"]) {
  const file = path.join(modules, pkg, "package.json");
  if (fs.existsSync(file)) {
    ok(`package ${pkg}`, "installed");
  } else {
    fail(`package ${pkg}`, "missing", "Run `npm ci` or `npm install`.");
  }
}

// Web build
const indexFile = path.join(ROOT_DIR, "web", "dist", "index.html");
if (fs.existsSync(indexFile)) {
  ok("web build", "web/dist/index.html");
} else {
  fail(
    "web build",
    "web/dist/index.html is missing",
    "Run `npm run build` for production, or use `npm run dev` for development."
  );
}

// .env
loadDotenv();
const config = createConfig();
const envFile = path.join(ROOT_DIR, ".env");
const envValues = readEnvFile(envFile);
if (fs.existsSync(envFile)) {
  ok(".env", "present");
} else {
  warn(
    ".env",
    "missing (defaults are used)",
    "Copy `.env.example` to `.env` so local settings are explicit."
  );
}

// Session cookie vs. plain HTTP. `npm start` runs in production, where the
// cookie is Secure unless COOKIE_SECURE=0. A Secure cookie is not sent over
// http://, which looks like a login loop.
const cookieSecure =
  envValues.COOKIE_SECURE === undefined
    ? true
    : /^(1|true|yes|on)$/i.test(envValues.COOKIE_SECURE);
const appOrigin = envValues.APP_ORIGIN || config.appOrigin || "";
if (cookieSecure && !appOrigin.startsWith("https://")) {
  warn(
    "session cookie",
    "COOKIE_SECURE is on but APP_ORIGIN is not HTTPS",
    "For local HTTP, set COOKIE_SECURE=0 in .env. For a real deployment, put poca-note behind HTTPS."
  );
}

// Data directory and database
const dataDir = path.dirname(config.databasePath);
try {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.accessSync(dataDir, fs.constants.W_OK);
  ok("data directory", dataDir);
} catch {
  fail(
    "data directory",
    `${dataDir} is not writable`,
    `Fix permissions: sudo chown -R $USER:$USER ${dataDir}`
  );
}

if (config.databaseUrl) {
  ok("database", "PostgreSQL (DATABASE_URL)");
} else if (fs.existsSync(config.databasePath)) {
  try {
    fs.accessSync(config.databasePath, fs.constants.R_OK | fs.constants.W_OK);
    ok("database", config.databasePath);
  } catch {
    fail(
      "database",
      `${config.databasePath} is not writable`,
      `Fix permissions: sudo chown -R $USER:$USER ${dataDir}`
    );
  }
} else {
  warn(
    "database",
    `${config.databasePath} does not exist yet`,
    "It is created on first start. That is normal on a fresh install."
  );
}

// Running as root makes later writes fragile.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  warn(
    "user",
    "running as root",
    "Run poca-note as a normal user so data and node_modules stay writable."
  );
}

// Port
const portState = await probePort(config.port);
if (portState === "free") {
  ok("port", `${config.port} is free (the app is not running)`);
} else if (portState === "in-use") {
  const http = await probeHttp(`http://127.0.0.1:${config.port}/`);
  if (http.ok) {
    ok("port", `${config.port} is serving poca-note`);
  } else {
    warn(
      "port",
      `${config.port} is in use by another process`,
      "Change PORT in .env or stop the other process."
    );
  }
} else {
  warn(
    "port",
    `could not determine the state of ${config.port}`,
    "Check with `ss -ltnp | grep :8787` on Linux."
  );
}

const labels = { ok: "OK  ", warn: "!!  ", fail: "XX  " };
console.log("");
console.log("poca-note doctor");
console.log(`project: ${ROOT_DIR}`);
console.log("");
for (const result of results) {
  console.log(`${labels[result.status]} ${result.name}: ${result.detail}`);
  if (result.hint && result.status !== "ok") {
    console.log(`     -> ${result.hint}`);
  }
}

const failures = results.filter((result) => result.status === "fail").length;
const warnings = results.filter((result) => result.status === "warn").length;
console.log("");
console.log(`${failures} failure(s), ${warnings} warning(s).`);
if (failures > 0) {
  console.log("Fix the failures above, then run `npm run doctor` again.");
  process.exitCode = 1;
} else {
  console.log("Core checks passed. Start with `npm start` (production) or `npm run dev` (development).");
}
