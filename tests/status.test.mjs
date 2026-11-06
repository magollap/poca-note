import test from "node:test";
import assert from "node:assert/strict";
import {
  addCardUpdate,
  addChecklistItem,
  addChecklistUpdate,
  createCard,
  getCard,
  getUpdateIntervalDays,
  loadBoard,
  patchCard,
  patchChecklistItem,
  setUpdateIntervalDays,
} from "../server/board.js";
import { startApp, testConfig, testDb, seedTenant, PASSWORD } from "./helpers.mjs";

function setup(t) {
  const config = testConfig();
  const db = testDb(config);
  const tenant = seedTenant(db);
  t.after(() => db.close());
  return { config, db, tenant };
}

test("card status follows the board column and explicit status moves the card", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Ship it", column: "todo" });
  assert.equal(card.status, "not_started");

  const doing = patchCard(db, tenant.id, card.id, { column: "doing", version: card.version });
  assert.equal(doing.card.status, "in_progress");

  const blocked = patchCard(db, tenant.id, doing.card.id, {
    status: "blocked",
    version: doing.card.version,
  });
  assert.equal(blocked.card.status, "blocked");
  assert.equal(blocked.card.column, "doing");

  const done = patchCard(db, tenant.id, blocked.card.id, {
    status: "done",
    version: blocked.card.version,
  });
  assert.equal(done.card.status, "done");
  assert.equal(done.card.column, "done");
  assert.ok(done.card.completedAt);
  assert.ok(done.card.updates.some((update) => update.kind === "status"));
  assert.ok(done.card.updates.some((update) => update.status === "blocked"));

  const back = patchCard(db, tenant.id, done.card.id, {
    column: "todo",
    version: done.card.version,
  });
  assert.equal(back.card.status, "not_started");
  assert.equal(back.card.completedAt, "");
});

test("written card updates join the timeline without forcing a version conflict", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Timeline" });
  const result = addCardUpdate(
    db,
    tenant.id,
    card.id,
    { body: "Kicked off with the vendor" },
    { displayName: "Ada Lovelace" }
  );
  const fresh = getCard(db, tenant.id, card.id);
  assert.equal(result.revision, result.revision);
  assert.equal(fresh.version, card.version);
  assert.equal(fresh.updates.length, 1);
  assert.equal(fresh.updates[0].body, "Kicked off with the vendor");
  assert.equal(fresh.updates[0].author, "Ada Lovelace");
  assert.equal(fresh.lastUpdateAt, fresh.updates[0].createdAt);
  assert.throws(
    () => addCardUpdate(db, tenant.id, card.id, { body: "   " }),
    (error) => error.status === 400
  );
});

test("subtask status mirrors the checkbox and keeps its own update log", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Subtasks" });
  const added = addChecklistItem(db, tenant.id, card.id, { text: "Draft the outline" });
  let item = added.card.checklist[0];
  assert.equal(item.status, "not_started");

  const inProgress = patchChecklistItem(db, tenant.id, item.id, { status: "in_progress" });
  item = inProgress.card.checklist[0];
  assert.equal(item.status, "in_progress");
  assert.equal(item.done, false);
  assert.equal(item.updates.length, 1);

  const complete = patchChecklistItem(db, tenant.id, item.id, { done: true });
  item = complete.card.checklist[0];
  assert.equal(item.status, "done");
  assert.equal(item.done, true);

  addChecklistUpdate(
    db,
    tenant.id,
    item.id,
    { body: "Draft shared for review" },
    { username: "sam" }
  );
  item = getCard(db, tenant.id, card.id).checklist[0];
  const noteUpdate = item.updates.find((update) => update.body === "Draft shared for review");
  assert.ok(noteUpdate);
  assert.equal(noteUpdate.author, "sam");
  assert.ok(noteUpdate.taskNo);
});

test("the workspace check-in interval is stored per tenant and validated", (t) => {
  const { db, tenant } = setup(t);
  assert.equal(getUpdateIntervalDays(db, tenant.id), 3);
  const saved = setUpdateIntervalDays(db, tenant.id, 7);
  assert.equal(saved.intervalDays, 7);
  assert.equal(getUpdateIntervalDays(db, tenant.id), 7);
  assert.equal(loadBoard(db, tenant.id).updateIntervalDays, 7);
  assert.throws(
    () => setUpdateIntervalDays(db, tenant.id, 0),
    (error) => error.status === 400
  );
  assert.throws(
    () => setUpdateIntervalDays(db, tenant.id, "soon"),
    (error) => error.status === 400
  );
});

test("status updates travel through the HTTP API with attribution", async (t) => {
  const { config, db, tenant } = setup(t);
  const app = await startApp({ config, db });
  t.after(() => app.close());
  await app.login(tenant.slug, PASSWORD);

  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "API task" },
  });
  assert.equal(created.status, 201);
  const card = created.data.card;
  assert.equal(card.status, "not_started");

  const status = await app.call(`/api/cards/${card.id}`, {
    method: "PATCH",
    body: { status: "in_progress", version: card.version },
  });
  assert.equal(status.status, 200);
  assert.equal(status.data.card.status, "in_progress");
  assert.ok(status.data.card.updates.length >= 1);

  const note = await app.call(`/api/cards/${card.id}/updates`, {
    method: "POST",
    body: { body: "Waiting on the design review" },
  });
  assert.equal(note.status, 201);
  const noteEntry = note.data.card.updates.find(
    (update) => update.body === "Waiting on the design review"
  );
  assert.ok(noteEntry);
  assert.equal(noteEntry.author, tenant.name);

  const item = await app.call(`/api/cards/${card.id}/checklist`, {
    method: "POST",
    body: { text: "Review copy" },
  });
  const itemId = item.data.card.checklist[0].id;
  const itemNote = await app.call(`/api/checklist/${itemId}/updates`, {
    method: "POST",
    body: { body: "Copy is with legal" },
  });
  assert.equal(itemNote.status, 201);
  assert.equal(itemNote.data.card.checklist[0].updates[0].body, "Copy is with legal");

  const settings = await app.call("/api/status-settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.data.intervalDays, 3);
  const updatedSettings = await app.call("/api/status-settings", {
    method: "PATCH",
    body: { intervalDays: 5 },
  });
  assert.equal(updatedSettings.status, 200);
  assert.equal(updatedSettings.data.intervalDays, 5);

  const board = await app.call("/api/board");
  assert.equal(board.data.updateIntervalDays, 5);
  const stored = board.data.cards.find((entry) => entry.id === card.id);
  assert.equal(stored.updates.length, 2);
  assert.equal(stored.checklist[0].updates.length, 1);
});
