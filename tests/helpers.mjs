import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConfig } from "../server/config.js";
import { openDb, createTenant } from "../server/db.js";
import { hashPassword } from "../server/auth.js";
import { createApp } from "../server/app.js";
import { createEventHub } from "../server/services/events.js";

export const PASSWORD = "test-password-123";

export function testConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "poca-test-"));
  const env = {
    NODE_ENV: "test",
    DATABASE_PATH: path.join(dir, "test.db"),
    COOKIE_SECURE: "0",
    SHOW_DEMO_CREDENTIALS: "0",
    REPORTS_DEFAULT_TIME: "08:00",
    REPORTS_DEFAULT_TIMEZONE: "UTC",
    AI_PROVIDER: "offline",
    REGISTRATION_MAX_PER_HOUR: "100",
    ...overrides,
  };
  const config = createConfig(env);
  config.webDist = dir;
  fs.mkdirSync(config.webDist, { recursive: true });
  return config;
}

export function testDb(config) {
  return openDb(config.databasePath);
}

export function seedTenant(db, { slug = "acme", name = "Acme Studio" } = {}) {
  const id = `tenant-${slug}`;
  createTenant(db, {
    id,
    slug,
    name,
    passwordHash: hashPassword(PASSWORD),
    reportTime: "08:00",
    reportTimezone: "UTC",
  });
  return db.prepare("SELECT id, slug, name FROM tenants WHERE slug = ?").get(slug);
}

/** Start the Express app on an ephemeral port and return fetch helpers. */
export async function startApp({ db, config, hub = createEventHub() }) {
  const app = createApp({ db, config, hub });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  async function call(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers["content-type"]) {
      headers["content-type"] = "application/json";
    }
    const cookie = cookieHeader();
    if (cookie && !options.noCookie) headers.cookie = cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(`${base}${pathname}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.redirect || "manual",
    });
    for (const raw of response.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      const key = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (value === "") cookies.delete(key);
      else cookies.set(key, value);
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, headers: response.headers, data, text };
  }

  async function login(tenant = "acme", password = PASSWORD) {
    const result = await call("/api/auth/login", {
      method: "POST",
      body: { tenant, password },
    });
    return result;
  }

  async function close() {
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  }

  return { base, call, login, close, cookies };
}

/** Minimal HTTP fixture server used for link-title tests. */
export async function startFixture() {
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) || 0) + 1);
    if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        '<!doctype html><html><head><title>Fallback</title>' +
          '<meta property="og:title" content="Fixture &amp; Page" />' +
          '<meta property="og:site_name" content="Fixture Works" />' +
          "</head><body>hi</body></html>"
      );
      return;
    }
    if (url.pathname === "/plain") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>  Plain   Title &#8212; ok </title></head></html>");
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/page" });
      res.end();
      return;
    }
    if (url.pathname === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"title":"not html"}');
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    hits,
    url: (pathname) => `${origin}${pathname}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
