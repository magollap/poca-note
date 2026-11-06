import test from "node:test";
import assert from "node:assert/strict";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

async function setup(t) {
  const config = testConfig();
  const db = testDb(config);
  seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });
  await app.login();
  return { app, db };
}

test("board sync round-trip: create, edit, conflict, move, delete, restore", async (t) => {
  const { app } = await setup(t);

  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "API card", notes: "hello", dueDate: "2026-11-02", priority: "high" },
  });
  assert.equal(created.status, 201);
  const card = created.data.card;
  assert.equal(card.column, "todo");
  assert.equal(card.version, 1);

  const patched = await app.call(`/api/cards/${card.id}`, {
    method: "PATCH",
    body: { title: "API card v2", version: card.version },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.card.version, 2);

  const conflict = await app.call(`/api/cards/${card.id}`, {
    method: "PATCH",
    body: { title: "stale", version: card.version },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "conflict");
  assert.equal(conflict.data.card.version, 2);
  assert.equal(conflict.data.card.title, "API card v2");

  const moved = await app.call(`/api/cards/${card.id}`, {
    method: "PATCH",
    body: { column: "doing", version: 2 },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.card.column, "doing");

  const checklist = await app.call(`/api/cards/${card.id}/checklist`, {
    method: "POST",
    body: { text: "A step" },
  });
  assert.equal(checklist.status, 201);
  assert.equal(checklist.data.card.checklist.length, 1);

  const toggled = await app.call(`/api/checklist/${checklist.data.itemId}`, {
    method: "PATCH",
    body: { done: true },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.data.card.checklist[0].done, true);

  const removed = await app.call(`/api/cards/${card.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);

  const board = await app.call("/api/board");
  assert.equal(board.data.cards.length, 0);
  assert.equal(board.data.trashCount, 1);

  const trash = await app.call("/api/trash");
  assert.equal(trash.data.cards.length, 1);
  assert.equal(trash.data.cards[0].checklist.length, 1);

  const restored = await app.call(`/api/cards/${card.id}/restore`, { method: "POST" });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.card.column, "doing");

  const purged = await app.call(`/api/cards/${card.id}/purge`, { method: "DELETE" });
  assert.equal(purged.status, 400, "purge requires the card to be deleted first");

  await app.call(`/api/cards/${card.id}`, { method: "DELETE" });
  const purgeOk = await app.call(`/api/cards/${card.id}/purge`, { method: "DELETE" });
  assert.equal(purgeOk.status, 200);

  const empty = await app.call("/api/trash", { method: "DELETE" });
  assert.equal(empty.status, 200);
  const finalTrash = await app.call("/api/trash");
  assert.equal(finalTrash.data.cards.length, 0);
});

test("unknown cards, unknown routes, and invalid payloads return structured JSON errors", async (t) => {
  const { app } = await setup(t);

  const missing = await app.call("/api/cards/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, "not_found");
  assert.match(missing.data.message, /not found/i);

  const unknown = await app.call("/api/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error, "not_found");

  const invalidJson = await fetch(`${app.base}/api/cards`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: [...app.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    body: "{broken",
  });
  assert.equal(invalidJson.status, 400);

  const badDate = await app.call("/api/cards", {
    method: "POST",
    body: { title: "x", dueDate: "2026-02-31" },
  });
  assert.equal(badDate.status, 400);

  const okDate = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Leap day", dueDate: "2028-02-29" },
  });
  assert.equal(okDate.status, 201);
});

test("an empty patch is rejected instead of producing broken SQL", async (t) => {
  const { app } = await setup(t);
  const created = await app.call("/api/cards", { method: "POST", body: { title: "No-op" } });
  const response = await app.call(`/api/cards/${created.data.card.id}`, {
    method: "PATCH",
    body: { version: created.data.card.version },
  });
  assert.equal(response.status, 400);
  assert.match(response.data.message, /nothing to update/i);
});

test("the health endpoint reports the authenticated tenant", async (t) => {
  const { app } = await setup(t);
  const health = await app.call("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.status, "ok");
  assert.equal(health.data.tenant, "acme");
});

test("card payloads are scoped and escaped as plain text, never HTML", async (t) => {
  const { app } = await setup(t);
  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "<img src=x onerror=alert(1)>", notes: "<script>alert(1)</script>" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.card.title, "<img src=x onerror=alert(1)>");
  assert.equal(created.data.card.notes, "<script>alert(1)</script>");
});
