import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Minimal .env loader (no dependencies). Existing process env always wins.
 */
export function loadDotenv(file = path.join(ROOT_DIR, ".env")) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
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
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const dbPath = path.resolve(ROOT_DIR, env.DATABASE_PATH || "./data/poca-note.db");
  return {
    env: nodeEnv,
    isProduction: nodeEnv === "production",
    port: int(env.PORT, 8787),
    appOrigin: env.APP_ORIGIN || null,
    cookieSecure: bool(env.COOKIE_SECURE, nodeEnv === "production"),
    cookieName: "poca_session",
    sessionDays: int(env.SESSION_DAYS, 30),
    databasePath: dbPath,
    databaseUrl: String(env.DATABASE_URL || "").trim(),
    databaseSsl: bool(env.DATABASE_SSL, false),
    databaseTimeoutMs: Math.max(5000, int(env.DATABASE_TIMEOUT_MS, 60_000)),
    rootDir: ROOT_DIR,
    webDist: path.join(ROOT_DIR, "web", "dist"),
    demo: {
      slug: env.DEMO_TENANT_SLUG || "acme",
      name: env.DEMO_TENANT_NAME || "Acme Studio",
      password: env.DEMO_TENANT_PASSWORD || "poca-demo",
      showCredentials: bool(env.SHOW_DEMO_CREDENTIALS, nodeEnv !== "production"),
    },
    registration: {
      open: bool(env.REGISTRATION_OPEN, true),
      maxPerHour: Math.max(1, int(env.REGISTRATION_MAX_PER_HOUR, 5)),
    },
    reports: {
      enabled: bool(env.REPORTS_ENABLED, true),
      graceMinutes: Math.max(0, int(env.REPORTS_GRACE_MINUTES, 120)),
      intervalMs: Math.max(10_000, int(env.REPORTS_TICK_MS, 60_000)),
      defaultTime: env.REPORTS_DEFAULT_TIME || "08:00",
      defaultTimezone: env.REPORTS_DEFAULT_TIMEZONE || "UTC",
    },
    linkFetch: {
      timeoutMs: Math.max(1000, int(env.LINK_FETCH_TIMEOUT_MS, 6000)),
      maxBytes: Math.max(16_384, int(env.LINK_FETCH_MAX_BYTES, 524_288)),
      allowPrivate: bool(env.ALLOW_PRIVATE_LINK_FETCH, false),
    },
    ai: {
      provider: (env.AI_PROVIDER || "auto").toLowerCase(),
      timeoutMs: Math.max(5000, int(env.AI_TIMEOUT_MS, 90_000)),
      anthropic: {
        apiKey: env.ANTHROPIC_API_KEY || "",
        model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      },
      ollama: {
        url: (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
        model: env.OLLAMA_MODEL || "qwen3.5:4b",
      },
      openai: {
        baseUrl: (env.OPENAI_BASE_URL || "").replace(/\/$/, ""),
        apiKey: env.OPENAI_API_KEY || "",
        model: env.OPENAI_MODEL || "gpt-4o-mini",
      },
    },
  };
}
