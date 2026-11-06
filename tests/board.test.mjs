import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  addChecklistItem,
  createCard,
  deleteChecklistItem,
  emptyTrash,
  getCard,
  loadBoard,
  loadTrash,
  patchCard,
  patchChecklistItem,
  purgeCard,
  restoreCard,
  softDeleteCard,
} from "../server/board.js";
import { openDb } from "../server/db.js";
import { HttpError } from "../server/util.js";
import { testConfig, testDb, seedTenant } from "./helpers.mjs";

function setup(t) {
  const config = testConfig();
  const db = testDb(config);
  const tenant = seedTenant(db);
  t.after(() => db.close());
  return { db, tenant };
}

test("creating a card appends it to the column and bumps the revision", (t) => {
  const { db, tenant } = setup(t);
  const first = createCard(db, tenant.id, { title: "First", column: "todo" });
  const second = createCard(db, tenant.id, { title: "Second", column: "todo" });
  assert.equal(first.card.column, "todo");
  assert.equal(first.card.version, 1);
  assert.equal(first.card.position, 1000);
  assert.equal(second.card.position, 2000);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(loadBoard(db, tenant.id).cards.length, 2);
});

test("cards moved to Done get a completion timestamp and lose it when moved back", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Finish", column: "todo" });
  const done = patchCard(db, tenant.id, card.id, { column: "done", version: card.version });
  assert.equal(done.card.column, "done");
  assert.ok(done.card.completedAt);

  const back = patchCard(db, tenant.id, card.id, { column: "doing", version: done.card.version });
  assert.equal(back.card.column, "doing");
  assert.equal(back.card.completedAt, "");
});

test("the Under Review column sits between Doing and Done", (t) => {
  const { db, tenant } = setup(t);
  const todo = createCard(db, tenant.id, { title: "Ready for QA", column: "todo" });
  const review = patchCard(db, tenant.id, todo.card.id, {
    column: "review",
    version: todo.card.version,
  });
  assert.equal(review.card.column, "review");
  assert.equal(review.card.status, "in_progress");
  assert.equal(review.card.completedAt, "");
  assert.ok(review.card.updates.some((update) => update.body === "Moved to Under Review"));

  const direct = createCard(db, tenant.id, { title: "Testing now", column: "review" });
  assert.equal(direct.card.column, "review");
  assert.equal(direct.card.status, "in_progress");

  const done = patchCard(db, tenant.id, review.card.id, {
    column: "done",
    version: review.card.version,
  });
  assert.equal(done.card.status, "done");
  assert.ok(done.card.completedAt);

  const reopened = patchCard(db, tenant.id, done.card.id, {
    column: "review",
    version: done.card.version,
  });
  assert.equal(reopened.card.status, "in_progress");
  assert.equal(reopened.card.completedAt, "");
});

test("legacy three-column databases gain the review column on open", (t) => {
  const config = testConfig();
  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO tenants (id, slug, name, password_hash, created_at)
    VALUES ('legacy-tenant', 'legacy', 'Legacy Workspace', 'x', '2026-01-01T00:00:00.000Z');

    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      dashboard_id TEXT,
      task_no TEXT,
      column_key TEXT NOT NULL CHECK (column_key IN ('todo', 'doing', 'done')),
      position REAL NOT NULL,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      link_url TEXT,
      link_title TEXT,
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
      status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (status IN ('not_started', 'in_progress', 'blocked', 'done')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      deleted_at TEXT
    );
    INSERT INTO cards
      (id, tenant_id, column_key, position, title, status, version, created_at, updated_at)
    VALUES
      ('legacy-card', 'legacy-tenant', 'doing', 1000, 'Legacy work', 'in_progress', 1,
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  legacy.close();

  const db = openDb(config.databasePath);
  t.after(() => db.close());

  const board = loadBoard(db, "legacy-tenant");
  assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].title, "Legacy work");

  const review = createCard(db, "legacy-tenant", { title: "QA pass", column: "review" });
  assert.equal(review.card.column, "review");
  assert.equal(review.card.status, "in_progress");
});

test("moving a card into another column appends it after that column's cards", (t) => {
  const { db, tenant } = setup(t);
  createCard(db, tenant.id, { title: "Existing", column: "doing" });
  const moving = createCard(db, tenant.id, { title: "Moving", column: "todo" });
  const moved = patchCard(db, tenant.id, moving.card.id, {
    column: "doing",
    version: moving.card.version,
  });
  assert.equal(moved.card.column, "doing");
  assert.ok(moved.card.position > 1000);
});

test("stale versions are rejected with a 409 carrying the current card", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Original", column: "todo" });
  patchCard(db, tenant.id, card.id, { title: "Updated", version: card.version });

  assert.throws(
    () => patchCard(db, tenant.id, card.id, { title: "Stale", version: card.version }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 409);
      assert.equal(error.details.card.version, 2);
      assert.equal(error.details.card.title, "Updated");
      return true;
    }
  );
});

test("patching without a version is a 400 and does not modify the card", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Guarded" });
  assert.throws(
    () => patchCard(db, tenant.id, card.id, { title: "No version" }),
    (error) => error.status === 400
  );
  assert.equal(getCard(db, tenant.id, card.id).title, "Guarded");
});

test("checklist items can be added, toggled, and removed while touching the card version", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Checklist card" });
  const added = addChecklistItem(db, tenant.id, card.id, { text: "Step one" });
  assert.equal(added.card.checklist.length, 1);
  assert.equal(added.card.version, card.version + 1);

  const toggled = patchChecklistItem(db, tenant.id, added.itemId, { done: true });
  assert.equal(toggled.card.checklist[0].done, true);

  const removed = deleteChecklistItem(db, tenant.id, added.itemId);
  assert.equal(removed.card.checklist.length, 0);
  assert.equal(removed.card.version, toggled.card.version + 1);
});

test("deletion hides the card, keeps it in trash, and restores it intact", (t) => {
  const { db, tenant } = setup(t);
  const { card } = createCard(db, tenant.id, { title: "Recoverable", notes: "keep me" });
  const item = addChecklistItem(db, tenant.id, card.id, { text: "Step" });

  const deleted = softDeleteCard(db, tenant.id, card.id);
  assert.ok(deleted.card.deletedAt);
  assert.equal(loadBoard(db, tenant.id).cards.length, 0);
  assert.equal(loadBoard(db, tenant.id).trashCount, 1);
  assert.equal(loadTrash(db, tenant.id).cards.length, 1);

  const restored = restoreCard(db, tenant.id, card.id);
  assert.equal(restored.card.title, "Recoverable");
  assert.equal(restored.card.notes, "keep me");
  assert.equal(restored.card.checklist.length, 1);
  assert.equal(restored.card.checklist[0].id, item.itemId);
  assert.equal(loadBoard(db, tenant.id).trashCount, 0);
});

test("purging requires a deleted card and emptyTrash only removes deleted cards", (t) => {
  const { db, tenant } = setup(t);
  const kept = createCard(db, tenant.id, { title: "Keep" });
  const dropped = createCard(db, tenant.id, { title: "Drop" });

  assert.throws(
    () => purgeCard(db, tenant.id, kept.card.id),
    (error) => error.status === 400
  );

  softDeleteCard(db, tenant.id, dropped.card.id);
  const purged = purgeCard(db, tenant.id, dropped.card.id);
  assert.ok(purged.revision > 0);
  assert.equal(getCard(db, tenant.id, dropped.card.id), null);

  const second = createCard(db, tenant.id, { title: "Drop too" });
  softDeleteCard(db, tenant.id, second.card.id);
  emptyTrash(db, tenant.id);
  assert.equal(loadTrash(db, tenant.id).cards.length, 0);
  assert.equal(loadBoard(db, tenant.id).cards.length, 1);
});

test("validation rejects bad columns, dates, priorities, and unsafe links", (t) => {
  const { db, tenant } = setup(t);
  const cases = [
    [{ title: "" }, "title"],
    [{ title: "x", column: "later" }, "column"],
    [{ title: "x", dueDate: "11/01/2026" }, "date"],
    [{ title: "x", priority: "urgent" }, "priority"],
    [{ title: "x", linkUrl: "javascript:alert(1)" }, "link"],
    [{ title: "x", linkUrl: "file:///etc/passwd" }, "link"],
  ];
  for (const [body] of cases) {
    assert.throws(() => createCard(db, tenant.id, body), (error) => error.status === 400);
  }
});

test("reordering into tight gaps normalizes positions so ordering stays stable", (t) => {
  const { db, tenant } = setup(t);
  const cards = [1, 2, 3].map((n) => createCard(db, tenant.id, { title: `Card ${n}`, column: "todo" }).card);
  // Insert between the first two repeatedly by patching positions.
  let version = cards[2].version;
  const between = patchCard(db, tenant.id, cards[2].id, { position: 1500, version });
  version = between.card.version;
  const again = patchCard(db, tenant.id, cards[2].id, { position: 1250, version });
  assert.equal(again.card.position, 1250);

  const board = loadBoard(db, tenant.id);
  const positions = board.cards.filter((card) => card.column === "todo").map((card) => card.position);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(new Set(positions).size, positions.length);
});

test("the board revision increases monotonically across mutations", (t) => {
  const { db, tenant } = setup(t);
  const { card, revision } = createCard(db, tenant.id, { title: "Revision" });
  const updated = patchCard(db, tenant.id, card.id, { notes: "n", version: card.version });
  assert.equal(updated.revision, revision + 1);
  const deleted = softDeleteCard(db, tenant.id, card.id);
  assert.equal(deleted.revision, updated.revision + 1);
  const restored = restoreCard(db, tenant.id, card.id);
  assert.equal(restored.revision, deleted.revision + 1);
});
