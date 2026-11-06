import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hashPassword, verifyPassword } from "../server/auth.js";
import { testConfig, testDb, seedTenant, startApp, PASSWORD } from "./helpers.mjs";

test("passwords are scrypt-hashed with a unique salt and verify correctly", () => {
  const first = hashPassword("correct horse battery staple");
  const second = hashPassword("correct horse battery staple");
  assert.match(first, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.notEqual(first, second);
  assert.equal(verifyPassword("correct horse battery staple", first), true);
  assert.equal(verifyPassword("wrong", first), false);
  assert.equal(verifyPassword("x", "not-a-hash"), false);
});

test("login sets an HTTP-only session cookie and returns a bearer token", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  const tenant = seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const bad = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "acme", password: "nope" },
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, "invalid_credentials");

  const login = await app.login();
  assert.equal(login.status, 200);
  assert.equal(login.data.tenant.id, tenant.id);
  assert.ok(login.data.token);
  const setCookie = login.headers.getSetCookie().join(";");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const me = await app.call("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.tenant.slug, "acme");
  assert.equal(me.data.user.username, "acme");
  assert.equal(me.data.user.role, "owner");

  const bearer = await app.call("/api/board", { token: login.data.token, noCookie: true });
  assert.equal(bearer.status, 200);
  assert.equal(bearer.data.tenant.slug, "acme");

  await app.call("/api/auth/logout", { method: "POST", body: {} });
  const afterLogout = await app.call("/api/board");
  assert.equal(afterLogout.status, 401);
});

test("every API route is tenant-authenticated except login config and login", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const protectedRoutes = [
    "/api/health",
    "/api/auth/me",
    "/api/users",
    "/api/board",
    "/api/trash",
    "/api/events",
    "/api/link-title?url=http%3A%2F%2Fexample.com",
    "/api/ai/status",
    "/api/ai/runs",
    "/api/ai/actions",
    "/api/ai/actions/00000000-0000-0000-0000-000000000000",
    "/api/reports",
    "/api/reports/latest",
    "/api/reports/performance",
    "/api/reports/schedules",
    "/api/dashboards",
    "/api/reports/settings",
  ];

  for (const route of protectedRoutes) {
    const response = await app.call(route);
    assert.equal(response.status, 401, `${route} should require authentication`);
  }

  const configResponse = await app.call("/api/auth/config");
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.data.appName, "poca-note");

  const incompleteLogin = await app.call("/api/auth/login", { method: "POST", body: {} });
  assert.equal(incompleteLogin.status, 400);
  assert.equal(incompleteLogin.data.error, "bad_request");
});

test("HTML routes redirect to /login without a session and serve the SPA with one", async (t) => {
  const config = testConfig();
  fs.writeFileSync(
    path.join(config.webDist, "index.html"),
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  for (const route of ["/board", "/skills"]) {
    const response = await app.call(route);
    assert.equal(response.status, 302, route);
    assert.match(response.headers.get("location"), /^\/login\?next=/);
  }

  const landing = await app.call("/");
  assert.equal(landing.status, 200);
  assert.match(landing.text, /id="root"/);

  const loginPage = await app.call("/login");
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /id="root"/);

  await app.login();
  const authedBoard = await app.call("/board");
  assert.equal(authedBoard.status, 200);
  assert.match(authedBoard.text, /id="root"/);

  const authedLogin = await app.call("/login");
  assert.equal(authedLogin.status, 302);
  assert.equal(authedLogin.headers.get("location"), "/board");
});

test("cross-origin mutations are rejected while same-origin is allowed", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  await app.login();

  const blocked = await app.call("/api/cards", {
    method: "POST",
    body: { title: "cross origin" },
    headers: { origin: "https://evil.example" },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error, "origin_not_allowed");

  const allowed = await app.call("/api/cards", {
    method: "POST",
    body: { title: "same origin" },
    headers: { origin: app.base },
  });
  assert.equal(allowed.status, 201);
});

test("security headers are present on API responses", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const response = await app.call("/api/auth/config");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("referrer-policy"), /strict-origin/);
});

test("creating a second tenant keeps boards isolated", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  seedTenant(db, { slug: "beta", name: "Beta Labs" });
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  await app.login("acme");
  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Acme secret" },
  });
  assert.equal(created.status, 201);

  await app.login("beta");
  const board = await app.call("/api/board");
  assert.equal(board.status, 200);
  assert.equal(board.data.cards.length, 0);

  const hijack = await app.call(`/api/cards/${created.data.card.id}`, {
    method: "PATCH",
    body: { title: "hijacked", version: 1 },
  });
  assert.equal(hijack.status, 404);
});
