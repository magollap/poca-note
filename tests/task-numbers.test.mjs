import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateTaskNo,
  formatTaskNo,
  initializeTaskCounters,
  openDb,
  taskNoPeriod,
} from "../server/db.js";
import { addChecklistItem, createCard } from "../server/board.js";
import { parseActionsByRules } from "../server/services/actions.js";
import { matchesQuery } from "../web/src/lib/format.js";
import { testConfig, testDb, seedTenant } from "./helpers.mjs";

const NOW = new Date("2026-10-27T09:00:00Z");
const NEXT_MONTH = new Date("2026-11-03T09:00:00Z");

function counter(db, tenantId, period) {
  return Number(
    db
      .prepare("SELECT next_no FROM task_number_counters WHERE tenant_id = ? AND period = ?")
      .get(tenantId, period)?.next_no
  );
}

test("numbers are YYMM followed by a five digit monthly sequence", () => {
  const config = testConfig();
  const db = testDb(config);
  try {
    const tenant = seedTenant(db);
    initializeTaskCounters(db);

    assert.equal(taskNoPeriod(NOW), "2610");
    assert.equal(formatTaskNo("2610", 7), "261000007");

    const first = allocateTaskNo(db, tenant.id, NOW);
    const second = allocateTaskNo(db, tenant.id, NOW);
    const third = allocateTaskNo(db, tenant.id, NOW);
    assert.equal(first, "261000001");
    assert.equal(second, "261000002");
    assert.equal(third, "261000003");
    assert.equal(counter(db, tenant.id, "2610"), 4);

    // A new month starts a fresh sequence with that month's prefix.
    const november = allocateTaskNo(db, tenant.id, NEXT_MONTH);
    assert.equal(november, "261100001");
    assert.equal(counter(db, tenant.id, "2611"), 2);
  } finally {
    db.close();
  }
});

test("cards and subtasks draw from the same per-workspace series", () => {
  const config = testConfig();
  const db = testDb(config);
  try {
    const tenant = seedTenant(db);
    const first = createCard(db, tenant.id, { title: "First card" }).card;
    const step = addChecklistItem(db, tenant.id, first.id, { text: "First subtask" });
    const second = createCard(db, tenant.id, { title: "Second card" }).card;
    const stepTwo = addChecklistItem(db, tenant.id, second.id, { text: "Second subtask" });
    const stepNo = db
      .prepare("SELECT task_no FROM checklist_items WHERE id = ?")
      .get(step.itemId).task_no;
    const stepTwoNo = db
      .prepare("SELECT task_no FROM checklist_items WHERE id = ?")
      .get(stepTwo.itemId).task_no;

    const numbers = [first.taskNo, stepNo, second.taskNo, stepTwoNo];
    assert.ok(numbers.every((value) => /^\d{4}\d{5}$/.test(value)), numbers.join(","));
    assert.equal(new Set(numbers).size, 4);
    assert.deepEqual(
      numbers.map(Number),
      numbers.map((_, index) => Number(numbers[0]) + index)
    );
  } finally {
    db.close();
  }
});

test("two workspaces keep independent series and may reuse a number", () => {
  const config = testConfig();
  const db = testDb(config);
  try {
    const acme = seedTenant(db, { slug: "acme" });
    const other = seedTenant(db, { slug: "other" });
    initializeTaskCounters(db);
    const acmeNo = allocateTaskNo(db, acme.id, NOW);
    const otherNo = allocateTaskNo(db, other.id, NOW);
    assert.equal(acmeNo, otherNo);
    assert.equal(allocateTaskNo(db, acme.id, NOW), "261000002");
  } finally {
    db.close();
  }
});

test("legacy six digit numbers are renumbered into the YYMM series", () => {
  const config = testConfig();
  const db = testDb(config);
  try {
    const tenant = seedTenant(db);
    const card = createCard(db, tenant.id, { title: "Existing card" }).card;
    db.prepare("UPDATE cards SET task_no = '123456', created_at = ? WHERE id = ?").run(
      NOW.toISOString(),
      card.id
    );

    // The app runs this migration on startup before allocating any new numbers.
    initializeTaskCounters(db);
    const renumbered = db.prepare("SELECT task_no FROM cards WHERE id = ?").get(card.id).task_no;
    assert.equal(renumbered, "261000001");
    assert.equal(allocateTaskNo(db, tenant.id, NOW), "261000002");
  } finally {
    db.close();
  }
});

test("rules understand “Task 261000001”, “#261000001”, and a bare number", () => {
  const cards = [
    {
      id: "11111111-aaaa",
      taskNo: "261000001",
      column: "todo",
      title: "Ship the beta",
      dueDate: "",
      priority: "normal",
      version: 2,
      checklist: [{ id: "ci-1", taskNo: "261000002", text: "Review copy", done: false }],
    },
  ];
  const parse = (text) => parseActionsByRules({ text, cards, now: NOW, timezone: "UTC" });

  for (const text of [
    "mark Task 261000001 as done",
    "mark #261000001 as done",
    "mark 261000001 as done",
  ]) {
    const result = parse(text);
    assert.equal(result.actions[0]?.type, "complete", text);
    assert.equal(result.actions[0]?.cardId, "11111111-aaaa", text);
  }

  for (const text of [
    "mark Task 261000002 as done",
    "complete task 261000002",
    "finish #261000002",
  ]) {
    const result = parse(text);
    assert.equal(result.actions[0]?.type, "subtask_complete", text);
    assert.equal(result.actions[0]?.checklistItemId, "ci-1", text);
  }

  const rename = parse("rename Task 261000002 to 'Final copy'");
  assert.equal(rename.actions[0]?.type, "subtask_update");
  assert.equal(rename.actions[0]?.text, "Final copy");

  const remove = parse("delete Task 261000002");
  assert.equal(remove.actions[0]?.type, "subtask_delete");
  assert.equal(remove.actions[0]?.checklistItemId, "ci-1");
});

test("board search accepts the “Task N” and “#N” spellings", () => {
  const card = {
    taskNo: "261000003",
    title: "Renew the domain",
    notes: "",
    linkTitle: "",
    linkUrl: "",
    checklist: [{ taskNo: "261000004", text: "Pay invoice" }],
  };
  assert.equal(matchesQuery(card, "Task 261000003"), true);
  assert.equal(matchesQuery(card, "#261000003"), true);
  assert.equal(matchesQuery(card, "261000003"), true);
  assert.equal(matchesQuery(card, "task 261000004"), true);
  assert.equal(matchesQuery(card, "task 999999999"), false);
});

test("the task number counter table is keyed by month in a fresh database", () => {
  const config = testConfig();
  const db = openDb(config.databasePath);
  try {
    const columns = db.prepare("PRAGMA table_info(task_number_counters)").all();
    assert.deepEqual(
      columns.map((column) => column.name),
      ["tenant_id", "period", "next_no"]
    );
  } finally {
    db.close();
  }
});
