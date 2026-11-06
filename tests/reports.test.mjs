import test from "node:test";
import assert from "node:assert/strict";
import {
  boardSnapshot,
  generateReport,
  getReportSettings,
  latestReports,
  listReports,
  periodFor,
  performanceSeries,
  processScheduledReports,
  reportCounts,
  saveReportSettings,
} from "../server/services/reports.js";
import { testConfig, testDb, seedTenant, startApp } from "./helpers.mjs";

const NOW = new Date("2026-10-27T09:00:00Z");

function backdate(db, cardId, { created, updated = created, completed = null }) {
  db.prepare(
    "UPDATE cards SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?"
  ).run(created, updated, completed, cardId);
}

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

async function seedCard(app, db, body, dates = {}) {
  const created = await app.call("/api/cards", { method: "POST", body });
  assert.equal(created.status, 201);
  if (dates.created) backdate(db, created.data.card.id, dates);
  return created.data.card;
}

test("periods cover today, the previous seven days, and the previous calendar month", () => {
  const daily = periodFor("daily", NOW, "UTC");
  assert.equal(daily.key, "2026-10-27");
  assert.equal(daily.startYmd, "2026-10-26");
  assert.equal(daily.endYmd, "2026-10-27");

  const weekly = periodFor("weekly", NOW, "UTC");
  assert.equal(weekly.endYmd, "2026-10-26");
  assert.equal(weekly.startYmd, "2026-10-20");
  assert.equal(weekly.key, "2026-10-20");

  const monthly = periodFor("monthly", NOW, "UTC");
  assert.equal(monthly.key, "2026-09");
  assert.equal(monthly.startYmd, "2026-09-01");
  assert.equal(monthly.endYmd, "2026-09-30");

  // Timezones move the local day, and therefore the periods.
  const tokyo = periodFor("daily", new Date("2026-10-27T22:30:00Z"), "Asia/Tokyo");
  assert.equal(tokyo.key, "2026-10-28");
});

test("report settings default from the workspace setup and validate input", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  const initial = getReportSettings(db, tenant.id, config);
  assert.equal(initial.dailyEnabled, true);
  assert.equal(initial.dailyTime, "08:00");
  assert.equal(initial.timezone, "UTC");

  const saved = await app.call("/api/reports/settings", {
    method: "PUT",
    body: {
      dailyEnabled: false,
      dailyTime: "09:30",
      weeklyEnabled: true,
      weeklyDay: 5,
      weeklyTime: "17:00",
      monthlyEnabled: true,
      monthlyDay: 15,
      monthlyTime: "07:15",
      timezone: "Europe/Berlin",
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.dailyEnabled, false);
  assert.equal(saved.data.weeklyDay, 5);
  assert.equal(saved.data.monthlyDay, 15);
  assert.equal(saved.data.timezone, "Europe/Berlin");

  const badTime = await app.call("/api/reports/settings", {
    method: "PUT",
    body: { dailyTime: "25:99" },
  });
  assert.equal(badTime.status, 400);
  assert.match(badTime.data.message, /HH:MM/);

  const badZone = await app.call("/api/reports/settings", {
    method: "PUT",
    body: { timezone: "Mars/Olympus_Mons" },
  });
  assert.equal(badZone.status, 400);
  assert.match(badZone.data.message, /timezone/i);
});

test("the daily brief lists yesterday's leftovers, overdue work, and today", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  await seedCard(app, db, { title: "Old carryover", column: "doing" }, {
    created: "2026-10-24T09:00:00.000Z",
    updated: "2026-10-24T09:00:00.000Z",
  });
  await seedCard(app, db, { title: "Late invoice", dueDate: "2026-10-20" }, {
    created: "2026-10-21T09:00:00.000Z",
  });
  await seedCard(app, db, { title: "Due today", dueDate: "2026-10-27", priority: "high" }, {
    created: "2026-10-26T09:00:00.000Z",
  });
  await seedCard(app, db, { title: "Finished today", column: "done" }, {
    created: "2026-10-25T09:00:00.000Z",
    completed: "2026-10-27T08:00:00.000Z",
  });

  const snapshot = boardSnapshot(db, tenant.id, NOW, "UTC", periodFor("daily", NOW, "UTC"));
  assert.equal(snapshot.pendingFromYesterday.length, 3);
  assert.equal(snapshot.overdue.length, 1);
  assert.equal(snapshot.dueToday.length, 1);
  assert.equal(snapshot.completedToday.length, 1);
  assert.equal(snapshot.counts.done, 1);

  const { report } = await generateReport({
    db,
    config,
    tenant,
    kind: "daily",
    trigger: "manual",
    now: NOW,
    withNarrative: false,
  });

  assert.equal(report.kind, "daily");
  assert.equal(report.periodKey, "2026-10-27");
  assert.match(report.title, /Daily brief/);
  assert.match(report.content, /## Overdue/);
  assert.match(report.content, /## Due today/);
  assert.match(report.content, /## Still pending from yesterday/);
  assert.match(report.content, /## Completed today/);
  assert.match(report.content, /Late invoice/);
  assert.match(report.content, /Due today/);
  assert.match(report.content, /\| To Do \| Doing \| Under Review \| Done \|/);
  assert.equal(report.metrics.overdue, 1);
  assert.equal(report.metrics.pendingFromYesterday, 3);
  assert.equal(report.metrics.completedInPeriod, 1);
});

test("board snapshots count Under Review cards as open work", async (t) => {
  const { app, db, tenant } = await setup(t);
  await seedCard(app, db, { title: "In review", column: "review" });

  const snapshot = boardSnapshot(db, tenant.id, NOW, "UTC", periodFor("daily", NOW, "UTC"));
  assert.equal(snapshot.counts.review, 1);
  assert.equal(snapshot.counts.done, 0);
  assert.equal(snapshot.openCount, 1);
  assert.equal(snapshot.completionRate, 0);
});

test("weekly and monthly reports count work inside their period only", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  const doneThisWeek = await seedCard(app, db, { title: "Shipped this week", column: "done" });
  backdate(db, doneThisWeek.id, {
    created: "2026-10-21T10:00:00.000Z",
    completed: "2026-10-25T10:00:00.000Z",
  });
  const doneLastMonth = await seedCard(app, db, { title: "Shipped last month", column: "done" });
  backdate(db, doneLastMonth.id, {
    created: "2026-09-10T10:00:00.000Z",
    completed: "2026-09-20T10:00:00.000Z",
  });
  const openToday = await seedCard(app, db, { title: "Open now" });

  const weekly = await generateReport({
    db,
    config,
    tenant,
    kind: "weekly",
    trigger: "manual",
    now: NOW,
    withNarrative: false,
  });
  assert.equal(weekly.report.periodKey, "2026-10-20");
  assert.equal(weekly.report.metrics.completedInPeriod, 1);
  assert.match(weekly.report.content, /## Completed this week/);
  assert.match(weekly.report.content, /Shipped this week/);
  assert.doesNotMatch(weekly.report.content, /Shipped last month/);

  const monthly = await generateReport({
    db,
    config,
    tenant,
    kind: "monthly",
    trigger: "manual",
    now: NOW,
    withNarrative: false,
  });
  assert.equal(monthly.report.periodKey, "2026-09");
  assert.equal(monthly.report.metrics.completedInPeriod, 1);
  assert.match(monthly.report.content, /## Delivered/);
  assert.match(monthly.report.content, /Shipped last month/);
  assert.doesNotMatch(monthly.report.content, /Shipped this week/);

  assert.equal(openToday.column, "todo");
});

test("scheduled reports fire at their local time, once per period", async (t) => {
  const { db, config } = await setup(t);

  // Monday 2026-10-26 08:10 UTC: daily (08:00) and weekly (Monday 08:00) are due.
  const monday = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T08:10:00Z"),
    logger: null,
  });
  const kinds = monday.map((entry) => entry.kind).sort();
  assert.deepEqual(kinds, ["daily", "weekly"]);

  const afterFirst = db.prepare("SELECT COUNT(*) AS count FROM reports").get();
  assert.equal(Number(afterFirst.count), 2);

  // Running again in the same grace window must not duplicate anything.
  const repeat = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T09:00:00Z"),
    logger: null,
  });
  assert.deepEqual(repeat, []);
  const afterRepeat = db.prepare("SELECT COUNT(*) AS count FROM reports").get();
  assert.equal(Number(afterRepeat.count), 2);

  // Sunday 2026-11-01 08:05 UTC: monthly (day 1) is due, weekly is not.
  const sunday = await processScheduledReports({
    db,
    config,
    now: new Date("2026-11-01T08:05:00Z"),
    logger: null,
  });
  const sundayKinds = sunday.map((entry) => entry.kind).sort();
  assert.deepEqual(sundayKinds, ["daily", "monthly"]);
  const monthly = sunday.find((entry) => entry.kind === "monthly");
  assert.equal(monthly.periodKey, "2026-10");

  const rows = db.prepare("SELECT kind, trigger, period_key FROM reports ORDER BY created_at").all();
  assert.deepEqual(
    rows.map((row) => `${row.kind}:${row.trigger}:${row.period_key}`),
    ["daily:scheduled:2026-10-26", "weekly:scheduled:2026-10-19", "daily:scheduled:2026-11-01", "monthly:scheduled:2026-10"]
  );
});

test("scheduled reports skip disabled kinds, wrong weekdays, and the grace window", async (t) => {
  const { db, config, tenant } = await setup(t, { REPORTS_GRACE_MINUTES: "30" });

  saveReportSettings(
    db,
    tenant.id,
    { dailyEnabled: false, weeklyEnabled: true, weeklyDay: 3, weeklyTime: "09:00", monthlyEnabled: false },
    config
  );

  // Monday: weekly is configured for Wednesday, so nothing at all is due.
  assert.deepEqual(
    await processScheduledReports({ db, config, now: new Date("2026-10-26T09:05:00Z"), logger: null }),
    []
  );

  // Wednesday 09:05 is inside the 30 minute grace window.
  const wednesday = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-28T09:05:00Z"),
    logger: null,
  });
  assert.deepEqual(wednesday.map((entry) => entry.kind), ["weekly"]);

  // 09:45 is beyond the grace window.
  const late = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-28T09:45:00Z"),
    logger: null,
  });
  assert.deepEqual(late, []);
});

test("disabling the report scheduler stops all generation", async (t) => {
  const { db, config } = await setup(t, { REPORTS_ENABLED: "0" });
  const results = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T08:10:00Z"),
    logger: null,
  });
  assert.deepEqual(results, []);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM reports").get().count), 0);
});

test("the reports API lists, generates, and scopes reports per tenant", async (t) => {
  const { app, db, config } = await setup(t);
  seedTenant(db, { slug: "beta", name: "Beta Labs" });
  await seedCard(app, db, { title: "Acme card" }, {
    created: "2020-01-01T09:00:00.000Z",
  });

  const empty = await app.call("/api/reports");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.reports, []);
  assert.deepEqual(empty.data.counts, { daily: 0, weekly: 0, monthly: 0, brief: 0 });
  assert.deepEqual(empty.data.kinds, ["daily", "weekly", "monthly", "brief"]);
  assert.equal(empty.data.settings.dailyEnabled, true);
  assert.equal(empty.data.latest.daily, null);

  const created = await app.call("/api/reports", {
    method: "POST",
    body: { kind: "daily", narrative: false },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.report.kind, "daily");
  assert.match(created.data.report.content, /Acme card/);

  const brief = await app.call("/api/ai/brief", { method: "POST", body: { narrative: false } });
  assert.equal(brief.status, 201);
  assert.equal(brief.data.report.kind, "brief");
  assert.match(brief.data.report.title, /Daily brief/);

  const list = await app.call("/api/reports");
  assert.equal(list.data.reports.length, 2);
  assert.equal(list.data.counts.daily, 1);
  assert.equal(list.data.counts.brief, 1);
  assert.ok(list.data.latest.daily);
  assert.ok(list.data.latest.brief);

  const filtered = await app.call("/api/reports?kind=brief");
  assert.equal(filtered.data.reports.length, 1);
  assert.equal(filtered.data.reports[0].kind, "brief");

  const latest = await app.call("/api/reports/latest");
  assert.equal(latest.status, 200);
  assert.equal(latest.data.counts.daily, 1);

  const invalid = await app.call("/api/reports", { method: "POST", body: { kind: "yearly" } });
  assert.equal(invalid.status, 400);

  // A second workspace sees none of Acme's reports.
  await app.login("beta");
  const beta = await app.call("/api/reports");
  assert.equal(beta.status, 200);
  assert.deepEqual(beta.data.reports, []);
  assert.equal(beta.data.latest.daily, null);
  assert.equal(listReports(db, "tenant-beta").length, 0);
  assert.deepEqual(latestReports(db, "tenant-beta"), {
    brief: null,
    daily: null,
    weekly: null,
    monthly: null,
  });
  assert.deepEqual(reportCounts(db, "tenant-beta"), { daily: 0, weekly: 0, monthly: 0, brief: 0 });
});

test("manual reports are not deduplicated but scheduled ones are", async (t) => {
  const { db, config, tenant } = await setup(t);

  const first = await generateReport({
    db,
    config,
    tenant,
    kind: "daily",
    trigger: "manual",
    now: NOW,
    withNarrative: false,
  });
  const second = await generateReport({
    db,
    config,
    tenant,
    kind: "daily",
    trigger: "manual",
    now: NOW,
    withNarrative: false,
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false);
  assert.notEqual(first.report.id, second.report.id);
});

test("multiple schedules of the same kind each fire once per period", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  saveReportSettings(
    db,
    tenant.id,
    { weeklyEnabled: false, monthlyEnabled: false, dailyTime: "08:00" },
    config
  );

  const added = await app.call("/api/reports/schedules", {
    method: "POST",
    body: { kind: "daily", time: "09:30", timezone: "UTC", label: "Mid-morning" },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.schedules.length, 4);
  assert.ok(added.data.schedules.some((schedule) => schedule.label === "Mid-morning"));

  const morning = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T08:05:00Z"),
    logger: null,
  });
  assert.deepEqual(morning.map((entry) => entry.kind), ["daily"]);

  // The 09:30 schedule is still pending at 08:05.
  const midMorning = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T09:35:00Z"),
    logger: null,
  });
  assert.deepEqual(midMorning.map((entry) => entry.kind), ["daily"]);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM reports").get().count), 2);

  // Same period again: the per-schedule unique index stops a third run.
  const repeat = await processScheduledReports({
    db,
    config,
    now: new Date("2026-10-26T09:45:00Z"),
    logger: null,
  });
  assert.deepEqual(repeat, []);

  const bySchedule = db
    .prepare("SELECT schedule_id, COUNT(*) AS count FROM reports GROUP BY schedule_id")
    .all();
  assert.equal(bySchedule.length, 2);
  assert.ok(bySchedule.every((row) => Number(row.count) === 1 && row.schedule_id));
});

test("report schedules can be edited, paused, and deleted", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  const initial = await app.call("/api/reports/schedules");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.schedules.length, 3);

  const weekly = initial.data.schedules.find((schedule) => schedule.kind === "weekly");
  const patched = await app.call(`/api/reports/schedules/${weekly.id}`, {
    method: "PATCH",
    body: { enabled: false, time: "17:30", weekday: 5, label: "Friday wrap-up" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.schedule.enabled, false);
  assert.equal(patched.data.schedule.time, "17:30");
  assert.equal(patched.data.schedule.weekday, 5);
  assert.equal(patched.data.schedule.label, "Friday wrap-up");

  const bad = await app.call(`/api/reports/schedules/${weekly.id}`, {
    method: "PATCH",
    body: { time: "99:99" },
  });
  assert.equal(bad.status, 400);

  const unknown = await app.call("/api/reports/schedules/nope", {
    method: "PATCH",
    body: { time: "09:00" },
  });
  assert.equal(unknown.status, 404);

  const removed = await app.call(`/api/reports/schedules/${weekly.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.equal(removed.data.schedules.length, 2);

  // Keep at least one schedule so a workspace cannot end up without automation.
  for (const schedule of removed.data.schedules) {
    await app.call(`/api/reports/schedules/${schedule.id}`, { method: "DELETE" });
  }
  const remaining = await app.call("/api/reports/schedules");
  assert.equal(remaining.data.schedules.length, 1);
  const lastDelete = await app.call(`/api/reports/schedules/${remaining.data.schedules[0].id}`, {
    method: "DELETE",
  });
  assert.equal(lastDelete.status, 400);
  assert.match(lastDelete.data.message, /at least one schedule/i);

  // Tenant scoping: another workspace cannot see or touch these schedules.
  seedTenant(db, { slug: "beta", name: "Beta Labs" });
  await app.login("beta");
  const beta = await app.call("/api/reports/schedules");
  assert.equal(beta.data.schedules.length, 3);
  const foreign = await app.call(`/api/reports/schedules/${remaining.data.schedules[0].id}`, {
    method: "PATCH",
    body: { time: "10:00" },
  });
  assert.equal(foreign.status, 404);
  assert.equal(config.reports.enabled, true);
});

test("performance series reports created, completed, and backlog points", async (t) => {
  const { app, db, config, tenant } = await setup(t);

  const doneCard = await seedCard(app, db, { title: "Shipped", column: "done" });
  backdate(db, doneCard.id, {
    created: "2026-10-25T09:00:00.000Z",
    completed: "2026-10-26T15:00:00.000Z",
  });
  const openCard = await seedCard(app, db, { title: "Still open", priority: "high" }, {
    created: "2026-10-27T09:00:00.000Z",
  });

  const daily = performanceSeries(db, tenant.id, {
    range: "daily",
    timezone: "UTC",
    now: NOW,
  });
  assert.equal(daily.buckets.length, 14);
  assert.equal(daily.buckets.at(-1).key, "2026-10-27");
  assert.equal(daily.buckets.at(-1).created, 1);
  assert.equal(daily.buckets.at(-1).backlog, 1);
  const completedBucket = daily.buckets.find((bucket) => bucket.key === "2026-10-26");
  assert.equal(completedBucket.completed, 1);
  assert.equal(completedBucket.backlog, 0);
  assert.equal(daily.totals.created, 2);
  assert.equal(daily.totals.completed, 1);
  assert.equal(daily.totals.open, 1);
  assert.equal(daily.byPriority.high, 1);
  assert.equal(daily.byDashboard.length, 1);

  const weekly = performanceSeries(db, tenant.id, { range: "weekly", timezone: "UTC", now: NOW });
  assert.equal(weekly.buckets.length, 8);
  assert.equal(weekly.buckets.at(-1).startYmd, "2026-10-26");
  assert.equal(weekly.buckets.at(-1).endYmd, "2026-11-01");
  assert.equal(weekly.buckets.at(-1).completed, 1);
  assert.equal(weekly.buckets.at(-1).created, 1);

  const monthly = performanceSeries(db, tenant.id, { range: "monthly", timezone: "UTC", now: NOW });
  assert.equal(monthly.buckets.length, 6);
  assert.equal(monthly.buckets.at(-1).key, "2026-10");
  assert.equal(monthly.buckets.at(-1).endYmd, "2026-10-31");

  // A second board's cards are excluded when the chart is scoped to one board.
  const second = await app.call("/api/dashboards", {
    method: "POST",
    body: { name: "Side project", accent: "cyan" },
  });
  const side = await app.call("/api/cards", {
    method: "POST",
    body: { title: "Side task", dashboardId: second.data.dashboard.id },
  });
  backdate(db, side.data.card.id, { created: "2026-10-27T09:00:00.000Z" });
  const scoped = performanceSeries(db, tenant.id, {
    range: "daily",
    timezone: "UTC",
    now: NOW,
    dashboardId: second.data.dashboard.id,
  });
  assert.equal(scoped.cardCount, 1);
  assert.equal(scoped.buckets.at(-1).created, 1);

  const route = await app.call("/api/reports/performance?range=weekly");
  assert.equal(route.status, 200);
  assert.equal(route.data.range, "weekly");
  assert.equal(route.data.buckets.length, 8);
  assert.equal(route.data.totals.created, 3);

  assert.equal(openCard.column, "todo");
});
