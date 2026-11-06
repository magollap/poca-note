import test from "node:test";
import assert from "node:assert/strict";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

async function setup(t, { config: overrides = {} } = {}) {
  const config = testConfig(overrides);
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return { app, db, config };
}

const NEW_WORKSPACE = {
  tenant: "gamma",
  name: "Gamma Works",
  username: "gina",
  password: "correct-horse-battery",
};

test("anyone can register a workspace and is signed in as its owner", async (t) => {
  const { app } = await setup(t);

  const registered = await app.call("/api/auth/register", {
    method: "POST",
    body: NEW_WORKSPACE,
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.tenant.slug, "gamma");
  assert.equal(registered.data.tenant.name, "Gamma Works");
  assert.equal(registered.data.user.username, "gina");
  assert.equal(registered.data.user.role, "owner");
  assert.ok(registered.data.token);
  assert.match(registered.headers.getSetCookie().join(";"), /HttpOnly/i);

  const me = await app.call("/api/auth/me");
  assert.equal(me.status, 200);
  assert.equal(me.data.user.username, "gina");
  assert.equal(me.data.user.role, "owner");

  const board = await app.call("/api/board");
  assert.equal(board.status, 200);
  assert.equal(board.data.cards.length, 0);
  assert.equal(board.data.tenant.slug, "gamma");
});

test("registration validates addresses, reserved names, usernames, and passwords", async (t) => {
  const { app } = await setup(t);

  const duplicate = await app.call("/api/auth/register", {
    method: "POST",
    body: { ...NEW_WORKSPACE, tenant: "acme" },
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.data.message, /already exists/i);

  const reserved = await app.call("/api/auth/register", {
    method: "POST",
    body: { ...NEW_WORKSPACE, tenant: "board" },
  });
  assert.equal(reserved.status, 400);
  assert.match(reserved.data.message, /reserved/i);

  const badSlug = await app.call("/api/auth/register", {
    method: "POST",
    body: { ...NEW_WORKSPACE, tenant: "a" },
  });
  assert.equal(badSlug.status, 400);

  const badUsername = await app.call("/api/auth/register", {
    method: "POST",
    body: { ...NEW_WORKSPACE, username: "x" },
  });
  assert.equal(badUsername.status, 400);

  const shortPassword = await app.call("/api/auth/register", {
    method: "POST",
    body: { ...NEW_WORKSPACE, password: "short" },
  });
  assert.equal(shortPassword.status, 400);
  assert.match(shortPassword.data.message, /8 characters/i);
});

test("registration can be closed by configuration", async (t) => {
  const { app } = await setup(t, { config: { REGISTRATION_OPEN: "0" } });

  const closed = await app.call("/api/auth/register", {
    method: "POST",
    body: NEW_WORKSPACE,
  });
  assert.equal(closed.status, 403);
  assert.match(closed.data.message, /closed/i);

  const config = await app.call("/api/auth/config");
  assert.equal(config.data.registrationOpen, false);
});

test("owners add teammates who share the board with their own login", async (t) => {
  const { app } = await setup(t);
  const owner = await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });
  const ownerToken = owner.data.token;

  const created = await app.call("/api/users", {
    method: "POST",
    body: { username: "sam", displayName: "Sam Rivera", password: "member-password" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.username, "sam");
  assert.equal(created.data.user.role, "editor");

  const listed = await app.call("/api/users", { token: ownerToken, noCookie: true });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.canManage, true);
  assert.equal(listed.data.users.length, 2);
  assert.deepEqual(
    listed.data.users.map((user) => user.role),
    ["owner", "editor"]
  );

  const ownerCard = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Shared card" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(ownerCard.status, 201);

  const memberLogin = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "sam", password: "member-password" },
    noCookie: true,
  });
  assert.equal(memberLogin.status, 200);
  assert.equal(memberLogin.data.user.username, "sam");
  assert.equal(memberLogin.data.user.role, "editor");
  const memberToken = memberLogin.data.token;

  const memberBoard = await app.call("/api/board", { token: memberToken, noCookie: true });
  assert.equal(memberBoard.status, 200);
  assert.equal(memberBoard.data.tenant.slug, "gamma");
  assert.equal(memberBoard.data.cards.length, 1);
  assert.equal(memberBoard.data.cards[0].title, "Shared card");

  const memberList = await app.call("/api/users", { token: memberToken, noCookie: true });
  assert.equal(memberList.status, 200);
  assert.equal(memberList.data.canManage, false);

  const forbidden = await app.call("/api/users", {
    method: "POST",
    body: { username: "mallory", password: "another-password" },
    token: memberToken,
    noCookie: true,
  });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error, "forbidden");

  const forbiddenDelete = await app.call(`/api/users/${owner.data.user.id}`, {
    method: "DELETE",
    token: memberToken,
    noCookie: true,
  });
  assert.equal(forbiddenDelete.status, 403);
});

test("owners can reset a teammate password and remove their login", async (t) => {
  const { app } = await setup(t);
  const owner = await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });
  const ownerToken = owner.data.token;

  const teammate = await app.call("/api/users", {
    method: "POST",
    body: { username: "sam", password: "member-password" },
    token: ownerToken,
    noCookie: true,
  });
  const samId = teammate.data.user.id;

  const reset = await app.call(`/api/users/${samId}`, {
    method: "PATCH",
    body: { password: "brand-new-password" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(reset.status, 200);

  const oldPassword = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "sam", password: "member-password" },
    noCookie: true,
  });
  assert.equal(oldPassword.status, 401);

  const newPassword = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "sam", password: "brand-new-password" },
    noCookie: true,
  });
  assert.equal(newPassword.status, 200);

  const removed = await app.call(`/api/users/${samId}`, {
    method: "DELETE",
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(removed.status, 200);

  const staleSession = await app.call("/api/board", {
    token: newPassword.data.token,
    noCookie: true,
  });
  assert.equal(staleSession.status, 401, "removing a login revokes its sessions");

  const relogin = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "sam", password: "brand-new-password" },
    noCookie: true,
  });
  assert.equal(relogin.status, 401);
});

test("a workspace always keeps at least one owner and cannot self-remove", async (t) => {
  const { app } = await setup(t);
  const owner = await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });
  const ownerToken = owner.data.token;
  const ownerId = owner.data.user.id;

  const selfDelete = await app.call(`/api/users/${ownerId}`, {
    method: "DELETE",
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(selfDelete.status, 400);
  assert.match(selfDelete.data.message, /your own login/i);

  const demote = await app.call(`/api/users/${ownerId}`, {
    method: "PATCH",
    body: { role: "editor" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(demote.status, 400);
  assert.match(demote.data.message, /at least one owner/i);

  const users = await app.call("/api/users", { token: ownerToken, noCookie: true });
  assert.equal(users.data.users.filter((user) => user.role === "owner").length, 1);
});

test("a second owner can be promoted, then the first can step down", async (t) => {
  const { app } = await setup(t);
  const owner = await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });
  const ownerToken = owner.data.token;

  const teammate = await app.call("/api/users", {
    method: "POST",
    body: { username: "sam", password: "member-password" },
    token: ownerToken,
    noCookie: true,
  });
  const samId = teammate.data.user.id;

  const promoted = await app.call(`/api/users/${samId}`, {
    method: "PATCH",
    body: { role: "owner" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.user.role, "owner");

  const demoted = await app.call(`/api/users/${owner.data.user.id}`, {
    method: "PATCH",
    body: { role: "editor" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.data.user.role, "editor");
});

test("logins from one workspace cannot see or touch another workspace", async (t) => {
  const { app } = await setup(t);
  await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });

  const gamma = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "gina", password: NEW_WORKSPACE.password },
    noCookie: true,
  });
  const gammaToken = gamma.data.token;

  const users = await app.call("/api/users", { token: gammaToken, noCookie: true });
  assert.equal(users.data.users.length, 1);
  assert.ok(users.data.users.every((user) => user.username !== "acme"));

  const acmeBoard = await app.call("/api/board", { token: gammaToken, noCookie: true });
  assert.equal(acmeBoard.data.tenant.slug, "gamma");
  assert.equal(acmeBoard.data.cards.length, 0);
});

test("observers are read-only while editors can change workspace content", async (t) => {
  const { app } = await setup(t);
  const owner = await app.call("/api/auth/register", { method: "POST", body: NEW_WORKSPACE });
  const ownerToken = owner.data.token;

  const observer = await app.call("/api/users", {
    method: "POST",
    body: { username: "olive", password: "observer-password", role: "observer" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(observer.status, 201);
  assert.equal(observer.data.user.role, "observer");

  const editor = await app.call("/api/users", {
    method: "POST",
    body: { username: "eddie", password: "editor-password", role: "editor" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(editor.status, 201);
  assert.equal(editor.data.user.role, "editor");

  const observerLogin = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "olive", password: "observer-password" },
    noCookie: true,
  });
  const observerToken = observerLogin.data.token;
  const editorLogin = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "gamma", username: "eddie", password: "editor-password" },
    noCookie: true,
  });
  const editorToken = editorLogin.data.token;

  const readable = await app.call("/api/board", { token: observerToken, noCookie: true });
  assert.equal(readable.status, 200);

  const blockedCalls = [
    ["POST", "/api/cards", { title: "Blocked card" }],
    ["POST", "/api/dashboards", { name: "Blocked board" }],
    ["POST", "/api/reports", { kind: "daily" }],
    ["POST", "/api/ai/actions/plan", { prompt: "create a card" }],
    ["PUT", "/api/reports/settings", { timezone: "UTC" }],
  ];
  for (const [method, path, body] of blockedCalls) {
    const blocked = await app.call(path, { method, body, token: observerToken, noCookie: true });
    assert.equal(blocked.status, 403, `${method} ${path} is blocked for observers`);
    assert.equal(blocked.data.error, "forbidden");
  }

  const editorCard = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Editor card" },
    token: editorToken,
    noCookie: true,
  });
  assert.equal(editorCard.status, 201);

  const editorAddsUser = await app.call("/api/users", {
    method: "POST",
    body: { username: "nope", password: "nope-password" },
    token: editorToken,
    noCookie: true,
  });
  assert.equal(editorAddsUser.status, 403);

  const editorReportSettings = await app.call("/api/reports/settings", {
    method: "PUT",
    body: { timezone: "UTC" },
    token: editorToken,
    noCookie: true,
  });
  assert.equal(editorReportSettings.status, 403);

  const badRole = await app.call("/api/users", {
    method: "POST",
    body: { username: "ghost", password: "ghost-password", role: "superuser" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(badRole.status, 400);
  assert.match(badRole.data.message, /owner, editor, or observer/i);

  const demoted = await app.call(`/api/users/${editor.data.user.id}`, {
    method: "PATCH",
    body: { role: "observer" },
    token: ownerToken,
    noCookie: true,
  });
  assert.equal(demoted.status, 200);
  assert.equal(demoted.data.user.role, "observer");

  // Roles are re-read from the database on every request.
  const nowBlocked = await app.call("/api/cards", {
    method: "POST",
    body: { title: "No longer allowed" },
    token: editorToken,
    noCookie: true,
  });
  assert.equal(nowBlocked.status, 403);
});

test("the legacy workspace password still signs in as the owner", async (t) => {
  const config = testConfig();
  const db = testDb(config);
  // seedTenant mirrors a pre-users database: one credential per workspace.
  seedTenant(db, { slug: "legacy", name: "Legacy Co" });
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });

  const login = await app.call("/api/auth/login", {
    method: "POST",
    body: { tenant: "legacy", password: "test-password-123" },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.role, "owner");
  assert.equal(login.data.user.username, "legacy");
});
