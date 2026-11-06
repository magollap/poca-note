import test from "node:test";
import assert from "node:assert/strict";
import {
  describeActions,
  parseActionsByRules,
  planActions,
  resolveDatePhrase,
  splitClauses,
} from "../server/services/actions.js";
import { addChecklistItem, createCard } from "../server/board.js";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

const NOW = new Date("2026-10-27T09:00:00Z");

function cardsFrom(db, tenantId) {
  return db
    .prepare(
      `SELECT id, column_key AS column, title, due_date AS dueDate, priority, version
       FROM cards WHERE tenant_id = ? AND deleted_at IS NULL`
    )
    .all(tenantId)
    .map((row) => ({ ...row, version: Number(row.version) }));
}

async function setup(t, configOverrides = {}) {
  const config = testConfig(configOverrides);
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

test("natural-language dates resolve against the current local day", () => {
  assert.equal(resolveDatePhrase("today", "2026-10-27"), "2026-10-27");
  assert.equal(resolveDatePhrase("tomorrow", "2026-10-27"), "2026-10-28");
  assert.equal(resolveDatePhrase("friday", "2026-10-27"), "2026-10-30");
  assert.equal(resolveDatePhrase("next friday", "2026-10-30"), "2026-11-06");
  assert.equal(resolveDatePhrase("in 2 weeks", "2026-10-27"), "2026-11-10");
  assert.equal(resolveDatePhrase("2026-11-02", "2026-10-27"), "2026-11-02");
  assert.equal(resolveDatePhrase("Nov 2", "2026-10-27"), "2026-11-02");
  assert.equal(resolveDatePhrase("not a date", "2026-10-27"), null);
});

test("clause splitting understands new lines, semicolons, and action verbs", () => {
  assert.deepEqual(
    splitClauses("Create a card and mark it done\nRename docs to handbook; delete the old card"),
    ["Create a card", "mark it done", "Rename docs to handbook", "delete the old card"]
  );
});

test("clause splitting leaves commas inside quoted titles alone", () => {
  assert.deepEqual(
    splitClauses(
      'Create a card "Pricing, billing, and refunds" in doing, add subtask "Check margins" to "Ship the beta", and mark "Ship the beta" as done'
    ),
    [
      'Create a card "Pricing, billing, and refunds" in doing',
      'add subtask "Check margins" to "Ship the beta"',
      'mark "Ship the beta" as done',
    ]
  );
});

test("the rules planner creates cards with dates, priorities, and columns", () => {
  const { actions, warnings } = parseActionsByRules({
    text: "Create a card 'Review pricing' due Friday high priority in doing",
    cards: [],
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(warnings.length, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create");
  assert.equal(actions[0].title, "Review pricing");
  assert.equal(actions[0].dueDate, "2026-10-30");
  assert.equal(actions[0].priority, "high");
  assert.equal(actions[0].column, "doing");
});

test("the rules planner resolves existing cards for complete, delete, update, and subtask", () => {
  const cards = [
    { id: "11111111-aaaa", column: "todo", title: "Ship the beta", dueDate: "", priority: "normal", version: 2 },
    { id: "22222222-bbbb", column: "doing", title: "Write docs", dueDate: "", priority: "high", version: 1 },
  ];

  const complete = parseActionsByRules({
    text: "Mark 'Ship the beta' as done",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(complete.actions[0].type, "complete");
  assert.equal(complete.actions[0].cardId, "11111111-aaaa");

  const remove = parseActionsByRules({ text: "delete Write docs", cards, now: NOW, timezone: "UTC" });
  assert.equal(remove.actions[0].type, "delete");
  assert.equal(remove.actions[0].cardId, "22222222-bbbb");

  const rename = parseActionsByRules({
    text: "rename Ship the beta to Ship v1.0",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(rename.actions[0].type, "update");
  assert.deepEqual(rename.actions[0].patch, { title: "Ship v1.0" });

  const due = parseActionsByRules({
    text: "set due date of Ship the beta to 2026-11-02",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.deepEqual(due.actions[0].patch, { dueDate: "2026-11-02" });

  const move = parseActionsByRules({ text: "move Write docs to doing", cards, now: NOW, timezone: "UTC" });
  assert.deepEqual(move.actions[0].patch, { column: "doing" });

  const review = parseActionsByRules({
    text: "move Write docs to under review",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.deepEqual(review.actions[0].patch, { column: "review" });

  const createReview = parseActionsByRules({
    text: "create a card QA the export under review",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(createReview.actions[0].type, "create");
  assert.equal(createReview.actions[0].column, "review");

  const subtask = parseActionsByRules({
    text: "add subtask 'Review copy' to 'Ship the beta'",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(subtask.actions[0].type, "subtask");
  assert.equal(subtask.actions[0].text, "Review copy");
  assert.equal(subtask.actions[0].cardId, "11111111-aaaa");
});

test("an unknown card becomes an unresolved action with a warning instead of a silent drop", () => {
  const result = parseActionsByRules({
    text: "mark 'Nonexistent card' as done",
    cards: [{ id: "11111111-aaaa", column: "todo", title: "Ship the beta", dueDate: "", priority: "normal", version: 1 }],
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].unresolved, true);
  assert.equal(result.actions[0].cardId, null);
  assert.match(result.warnings[0], /No card matches/);
});

test("describeActions summarizes mixed plans", () => {
  assert.equal(
    describeActions([{ type: "create" }, { type: "create" }, { type: "complete" }]),
    "Create 2 · complete 1"
  );
});

test("plan then apply executes every action against the live board", async (t) => {
  const { app, db, tenant } = await setup(t);

  const seed = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Ship the beta", column: "doing" },
  });
  assert.equal(seed.status, 201);

  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: {
      prompt:
        "Create a card 'Review pricing' due tomorrow high priority, add subtask 'Check margins' to 'Ship the beta', and mark 'Ship the beta' as done",
    },
  });
  assert.equal(planned.status, 200);
  assert.equal(planned.data.plan.source, "rules");
  assert.equal(planned.data.plan.actions.length, 3);
  assert.ok(planned.data.runId);

  const applied = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 3);
  assert.equal(applied.data.failed, 0);

  const board = await app.call("/api/board");
  const byTitle = new Map(board.data.cards.map((card) => [card.title, card]));
  assert.equal(byTitle.get("Review pricing").column, "todo");
  assert.equal(byTitle.get("Review pricing").priority, "high");
  assert.ok(byTitle.get("Review pricing").dueDate);
  assert.equal(byTitle.get("Ship the beta").column, "done");
  assert.equal(byTitle.get("Ship the beta").checklist.length, 1);
  assert.equal(byTitle.get("Ship the beta").checklist[0].text, "Check margins");

  const runs = await app.call("/api/ai/actions");
  assert.equal(runs.status, 200);
  assert.equal(runs.data.runs.length, 1);
  assert.equal(runs.data.runs[0].status, "applied");
  assert.equal(runs.data.runs[0].source, "rules");

  // The data survives a fresh read, scoped to the tenant.
  assert.equal(cardsFrom(db, tenant.id).length, 2);
});

test("applying the same saved plan twice is rejected", async (t) => {
  const { app } = await setup(t);
  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "create a card 'Only once'" },
  });
  const first = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(first.data.applied, 1);
  const second = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(second.status, 409);
  assert.match(second.data.message, /already applied/i);
});

test("a stale plan cannot overwrite a card that changed in the meantime", async (t) => {
  const { app } = await setup(t);
  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Racy card", column: "todo" },
  });
  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "mark 'Racy card' as done" },
  });
  // Somebody edits the card after the plan was made.
  await app.call(`/api/cards/${created.data.card.id}`, {
    method: "PATCH",
    body: { title: "Racy card v2", version: created.data.card.version },
  });

  const applied = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 0);
  assert.equal(applied.data.failed, 1);
  assert.match(applied.data.results[0].message, /changed on another device/i);

  const board = await app.call("/api/board");
  assert.equal(board.data.cards[0].column, "todo");
});

test("an unresolved action reports a readable failure without touching the board", async (t) => {
  const { app } = await setup(t);
  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "mark 'Ghost card' as done" },
  });
  assert.equal(planned.data.plan.actions[0].unresolved, true);
  assert.equal(planned.data.warnings.length, 1);

  const applied = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(applied.data.applied, 0);
  assert.equal(applied.data.failed, 1);
  assert.match(applied.data.results[0].message, /no longer exists/i);
});

test("plans fall back to the offline template when no model is available", async (t) => {
  const { app } = await setup(t, { AI_PROVIDER: "offline" });
  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "Please tidy up the pricing page copy" },
  });
  assert.equal(planned.status, 200);
  assert.equal(planned.data.plan.source, "offline");
  assert.equal(planned.data.plan.actions.length, 1);
  assert.equal(planned.data.plan.actions[0].type, "create");
  assert.match(planned.data.warnings[0], /offline fallback/i);
});

test("an LLM JSON plan is used when the rules recognize nothing", async (t) => {
  const config = testConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" });
  const db = testDb(config);
  const tenant = seedTenant(db);
  t.after(() => db.close());

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (href.includes("api.anthropic.com")) {
      const body = JSON.parse(init.body);
      assert.match(body.system, /board action planner/i);
      assert.match(body.messages[0].content, /Today is/);
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Tidy the pricing page",
                actions: [
                  {
                    type: "create",
                    title: "Tidy the pricing page",
                    column: "todo",
                    priority: "normal",
                    dueDate: null,
                  },
                ],
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const plan = await planActions({
    db,
    config,
    tenantId: tenant.id,
    prompt: "Please tidy up the pricing page copy",
    now: NOW,
  });
  assert.equal(plan.source, "llm");
  assert.equal(plan.provider, "anthropic");
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "create");
  assert.equal(plan.actions[0].title, "Tidy the pricing page");
});

test("action plans are tenant-scoped", async (t) => {
  const { app, db } = await setup(t);
  seedTenant(db, { slug: "beta", name: "Beta Labs" });
  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "create a card 'Acme only'" },
  });

  await app.login("beta");
  const hijack = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(hijack.status, 404);

  const runs = await app.call("/api/ai/actions");
  assert.equal(runs.data.runs.length, 0);
});

test("the plan endpoint validates the prompt length", async (t) => {
  const { app } = await setup(t);
  const empty = await app.call("/api/ai/actions/plan", { method: "POST", body: { prompt: "x" } });
  assert.equal(empty.status, 400);

  const huge = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: "a".repeat(4001) },
  });
  assert.equal(huge.status, 400);
});

test("every card and subtask gets a unique YYMM task number", async (t) => {
  const { app } = await setup(t);

  const first = await app.call("/api/cards", { method: "POST", body: { title: "Launch page" } });
  const second = await app.call("/api/cards", { method: "POST", body: { title: "Write docs" } });
  assert.match(first.data.card.taskNo, /^\d{4}\d{5}$/);
  assert.match(second.data.card.taskNo, /^\d{4}\d{5}$/);

  const added = await app.call(`/api/cards/${first.data.card.id}/checklist`, {
    method: "POST",
    body: { text: "Proofread copy" },
  });
  const stepNo = added.data.card.checklist[0].taskNo;
  assert.match(stepNo, /^\d{4}\d{5}$/);

  const numbers = [first.data.card.taskNo, second.data.card.taskNo, stepNo];
  assert.equal(new Set(numbers).size, numbers.length);

  const board = await app.call("/api/board");
  const loaded = board.data.cards.find((card) => card.id === first.data.card.id);
  assert.equal(loaded.taskNo, first.data.card.taskNo);
  assert.equal(loaded.checklist[0].taskNo, stepNo);
});

test("rules recognize cards and subtasks by their task number", () => {
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

  const completeCard = parseActionsByRules({
    text: "mark #261000001 as done",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(completeCard.actions[0].type, "complete");
  assert.equal(completeCard.actions[0].cardId, "11111111-aaaa");

  const completeStep = parseActionsByRules({
    text: "mark subtask #261000002 as done",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(completeStep.actions[0].type, "subtask_complete");
  assert.equal(completeStep.actions[0].checklistItemId, "ci-1");
  assert.equal(completeStep.actions[0].taskNo, "261000002");
  assert.equal(completeStep.actions[0].cardId, "11111111-aaaa");

  const renameStep = parseActionsByRules({
    text: "rename #261000002 to 'Review final copy'",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(renameStep.actions[0].type, "subtask_update");
  assert.equal(renameStep.actions[0].text, "Review final copy");

  const deleteStep = parseActionsByRules({
    text: "delete subtask #261000002",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(deleteStep.actions[0].type, "subtask_delete");
  assert.equal(deleteStep.actions[0].checklistItemId, "ci-1");

  const addStep = parseActionsByRules({
    text: "add subtask 'Run QA' to #261000001",
    cards,
    now: NOW,
    timezone: "UTC",
  });
  assert.equal(addStep.actions[0].type, "subtask");
  assert.equal(addStep.actions[0].cardId, "11111111-aaaa");
  assert.equal(addStep.actions[0].cardTaskNo, "261000001");
  assert.equal(addStep.actions[0].text, "Run QA");
});

test("applying a task-number plan completes, renames, and adds subtasks", async (t) => {
  const { app } = await setup(t);

  const created = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Launch page", column: "todo" },
  });
  const cardNo = created.data.card.taskNo;
  const added = await app.call(`/api/cards/${created.data.card.id}/checklist`, {
    method: "POST",
    body: { text: "Proofread copy" },
  });
  const stepNo = added.data.card.checklist[0].taskNo;

  const planned = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: {
      prompt: `mark #${stepNo} as done, rename subtask #${stepNo} to "Proofread final copy", add subtask "Publish" to #${cardNo}, and complete #${cardNo}`,
    },
  });
  assert.equal(planned.status, 200);
  assert.equal(planned.data.plan.source, "rules");
  assert.equal(planned.data.plan.actions.length, 4);

  const applied = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: planned.data.runId },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.applied, 4);
  assert.equal(applied.data.failed, 0);

  let board = await app.call("/api/board");
  let card = board.data.cards.find((entry) => entry.id === created.data.card.id);
  assert.equal(card.column, "done");
  assert.equal(card.checklist.length, 2);
  const renamed = card.checklist.find((item) => item.taskNo === stepNo);
  assert.equal(renamed.text, "Proofread final copy");
  assert.equal(renamed.done, true);
  assert.ok(card.checklist.some((item) => item.text === "Publish"));

  const removal = await app.call("/api/ai/actions/plan", {
    method: "POST",
    body: { prompt: `delete subtask #${stepNo}` },
  });
  assert.equal(removal.data.plan.actions[0].type, "subtask_delete");
  const removed = await app.call("/api/ai/actions/apply", {
    method: "POST",
    body: { runId: removal.data.runId },
  });
  assert.equal(removed.data.applied, 1);

  board = await app.call("/api/board");
  card = board.data.cards.find((entry) => entry.id === created.data.card.id);
  assert.equal(card.checklist.some((item) => item.taskNo === stepNo), false);
});

test("the planner prompt lists task numbers and accepts them in LLM JSON", async (t) => {
  const config = testConfig({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key" });
  const db = testDb(config);
  const tenant = seedTenant(db);
  t.after(() => db.close());

  const created = createCard(db, tenant.id, { title: "Launch page" });
  const added = addChecklistItem(db, tenant.id, created.card.id, { text: "Proofread copy" });
  const cardNo = created.card.taskNo;
  const stepNo = added.card.checklist[0].taskNo;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    if (href.includes("api.anthropic.com")) {
      const body = JSON.parse(init.body);
      assert.match(body.messages[0].content, new RegExp(`Task ${cardNo}`));
      assert.match(body.messages[0].content, new RegExp(`Task ${stepNo}`));
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Tick the proofreading step",
                actions: [{ type: "subtask_complete", taskNo: stepNo }],
              }),
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const plan = await planActions({
    db,
    config,
    tenantId: tenant.id,
    prompt: "Please tick the proofreading step",
    now: NOW,
  });
  assert.equal(plan.source, "llm");
  assert.equal(plan.actions[0].type, "subtask_complete");
  assert.equal(plan.actions[0].checklistItemId, added.itemId);
  assert.equal(plan.actions[0].taskNo, stepNo);
});
