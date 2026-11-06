import test from "node:test";
import assert from "node:assert/strict";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

async function setup(t, overrides = {}) {
  const config = testConfig(overrides);
  const db = testDb(config);
  const tenant = seedTenant(db);
  const app = await startApp({ db, config });
  t.after(async () => {
    await app.close();
    db.close();
  });
  await app.login();
  return { app, db, config, tenant };
}

test("every workspace starts with a default board and three schedules", async (t) => {
  const { app, db, tenant } = await setup(t);

  const boards = await app.call("/api/dashboards");
  assert.equal(boards.status, 200);
  assert.equal(boards.data.dashboards.length, 1);
  assert.equal(boards.data.dashboards[0].name, "My board");
  assert.equal(boards.data.dashboards[0].counts.open, 0);

  const schedules = db
    .prepare("SELECT kind, enabled FROM report_schedules WHERE tenant_id = ? ORDER BY kind")
    .all(tenant.id);
  assert.deepEqual(
    schedules.map((row) => `${row.kind}:${row.enabled}`),
    ["daily:1", "monthly:1", "weekly:1"]
  );

  const board = await app.call("/api/board");
  assert.equal(board.status, 200);
  assert.equal(board.data.dashboardId, boards.data.dashboards[0].id);
});

test("boards scope their own cards while the trash stays workspace-wide", async (t) => {
  const { app } = await setup(t);

  const created = await app.call("/api/dashboards", {
    method: "POST",
    body: { name: "Client work", accent: "cyan" },
  });
  assert.equal(created.status, 201);
  const clientId = created.data.dashboard.id;
  assert.equal(created.data.dashboard.accent, "cyan");

  const boards = await app.call("/api/dashboards");
  const personalId = boards.data.dashboards.find((board) => board.name === "My board").id;

  const personalCard = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Personal task", dashboardId: personalId },
  });
  assert.equal(personalCard.status, 201);
  assert.equal(personalCard.data.card.dashboardId, personalId);

  const clientCard = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Client task", column: "doing", dashboardId: clientId },
  });
  assert.equal(clientCard.status, 201);
  assert.equal(clientCard.data.card.dashboardId, clientId);

  const clientBoard = await app.call(`/api/board?dashboardId=${clientId}`);
  assert.deepEqual(clientBoard.data.cards.map((card) => card.title), ["Client task"]);
  const personalBoard = await app.call(`/api/board?dashboardId=${personalId}`);
  assert.deepEqual(personalBoard.data.cards.map((card) => card.title), ["Personal task"]);

  await app.call(`/api/cards/${clientCard.data.card.id}`, { method: "DELETE" });
  const trash = await app.call("/api/trash");
  assert.equal(trash.data.cards.length, 1);

  const counts = (await app.call("/api/dashboards")).data.dashboards;
  assert.equal(counts.find((board) => board.id === clientId).counts.open, 0);
  assert.equal(counts.find((board) => board.id === personalId).counts.todo, 1);
});

test("Under Review cards count as open work on the dashboard", async (t) => {
  const { app } = await setup(t);
  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "QA pass", column: "review" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.card.status, "in_progress");

  const board = (await app.call("/api/dashboards")).data.dashboards[0];
  assert.equal(board.counts.review, 1);
  assert.equal(board.counts.open, 1);
  assert.equal(board.counts.total, 1);
});

test("boards can be renamed and deleted without losing cards", async (t) => {
  const { app } = await setup(t);

  const first = (await app.call("/api/dashboards")).data.dashboards[0];
  const second = (await app.call("/api/dashboards", {
    method: "POST",
    body: { name: "Side project", accent: "rose" },
  })).data.dashboard;

  const patched = await app.call(`/api/dashboards/${second.id}`, {
    method: "PATCH",
    body: { name: "Side project 2", accent: "emerald" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.dashboard.name, "Side project 2");
  assert.equal(patched.data.dashboard.accent, "emerald");

  const card = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Move me", dashboardId: second.id },
  });
  assert.equal(card.status, 201);

  const removed = await app.call(`/api/dashboards/${second.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.movedTo, first.id);

  const boards = await app.call("/api/dashboards");
  assert.equal(boards.data.dashboards.length, 1);
  const board = await app.call(`/api/board?dashboardId=${first.id}`);
  assert.deepEqual(board.data.cards.map((entry) => entry.title), ["Move me"]);

  const last = await app.call(`/api/dashboards/${first.id}`, { method: "DELETE" });
  assert.equal(last.status, 400);
  assert.match(last.data.message, /at least one board/i);
});

test("board names, accents, and tenant boundaries are validated", async (t) => {
  const { app, db } = await setup(t);

  const empty = await app.call("/api/dashboards", { method: "POST", body: { name: "  " } });
  assert.equal(empty.status, 400);

  const badAccent = await app.call("/api/dashboards", {
    method: "POST",
    body: { name: "Neon", accent: "chartreuse" },
  });
  assert.equal(badAccent.status, 400);

  const missing = await app.call("/api/dashboards/00000000-0000-0000-0000-000000000000", {
    method: "PATCH",
    body: { name: "Ghost" },
  });
  assert.equal(missing.status, 404);

  const foreignBoard = await app.call("/api/board?dashboardId=00000000-0000-0000-0000-000000000000");
  assert.equal(foreignBoard.status, 404);

  seedTenant(db, { slug: "beta", name: "Beta Labs" });
  await app.login("beta");
  const betaCard = await app.call("/api/cards", { method: "POST", body: { title: "Beta card" } });
  assert.equal(betaCard.status, 201);
  assert.notEqual(betaCard.data.card.dashboardId, "");
  const betaBoards = await app.call("/api/dashboards");
  assert.equal(betaBoards.data.dashboards.length, 1);
  assert.equal(betaBoards.data.dashboards[0].counts.todo, 1);
});
