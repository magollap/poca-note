import { getRevision, nowIso, seedReportSchedules } from "../db.js";
import { assert, clampText, isValidTime, isValidTimezone, localTimeParts, newId } from "../util.js";
import { listDashboards } from "../dashboards.js";
import { generateText } from "./ai.js";

export const REPORT_KINDS = ["daily", "weekly", "monthly", "brief"];
export const SCHEDULED_KINDS = ["daily", "weekly", "monthly"];

const COLUMN_LABEL = { todo: "To Do", doing: "Doing", review: "Under Review", done: "Done" };
const MAX_LISTED = 14;

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function toMinutes(value) {
  const [hours, minutes] = String(value || "08:00").split(":").map(Number);
  return hours * 60 + minutes;
}

function localDateOf(iso, timezone) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function labelFor(ymd, timezone, options) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    ...options,
  }).format(new Date(`${ymd}T12:00:00Z`));
}

export function periodFor(kind, now, timezone) {
  const today = localTimeParts(now, timezone).date;
  if (kind === "weekly") {
    const endYmd = addDays(today, -1);
    const startYmd = addDays(endYmd, -6);
    return {
      kind,
      key: startYmd,
      startYmd,
      endYmd,
      label: `${labelFor(startYmd, timezone, { month: "short", day: "numeric" })} – ${labelFor(
        endYmd,
        timezone,
        { month: "short", day: "numeric", year: "numeric" }
      )}`,
    };
  }
  if (kind === "monthly") {
    const firstOfThisMonth = `${today.slice(0, 8)}01`;
    const endYmd = addDays(firstOfThisMonth, -1);
    const startYmd = `${endYmd.slice(0, 8)}01`;
    return {
      kind,
      key: startYmd.slice(0, 7),
      startYmd,
      endYmd,
      label: labelFor(startYmd, timezone, { month: "long", year: "numeric" }),
    };
  }
  return {
    kind: "daily",
    key: today,
    startYmd: addDays(today, -1),
    endYmd: today,
    label: labelFor(today, timezone, { weekday: "long", month: "short", day: "numeric" }),
  };
}

function ensureSettingsRow(db, tenantId, config) {
  let row = db.prepare("SELECT * FROM report_settings WHERE tenant_id = ?").get(tenantId);
  if (row) return row;
  const timestamp = nowIso();
  const fallbackTime = config.reports?.defaultTime || "08:00";
  const timezone = config.reports?.defaultTimezone || "UTC";
  db.prepare(
    `INSERT INTO report_settings
       (tenant_id, daily_enabled, daily_time, weekly_enabled, weekly_day, weekly_time,
        monthly_enabled, monthly_day, monthly_time, timezone, updated_at)
     VALUES (?, 1, ?, 1, 1, ?, 1, 1, ?, ?, ?)`
  ).run(tenantId, fallbackTime, fallbackTime, fallbackTime, timezone, timestamp);
  return db.prepare("SELECT * FROM report_settings WHERE tenant_id = ?").get(tenantId);
}

/** Seed the three default schedules for a workspace that has none. */
export function ensureTenantSchedules(db, tenantId, config = {}) {
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM report_schedules WHERE tenant_id = ?")
    .get(tenantId);
  if (Number(count.count) > 0) return;
  const row = ensureSettingsRow(db, tenantId, config);
  seedReportSchedules(db, tenantId, {
    time: row.daily_time || config.reports?.defaultTime || "08:00",
    timezone: row.timezone || config.reports?.defaultTimezone || "UTC",
    weeklyTime: row.weekly_time,
    weeklyDay: row.weekly_day,
    monthlyTime: row.monthly_time,
    monthlyDay: row.monthly_day,
    dailyEnabled: Boolean(row.daily_enabled),
    weeklyEnabled: Boolean(row.weekly_enabled),
    monthlyEnabled: Boolean(row.monthly_enabled),
  });
}

export function serializeSchedule(row) {
  return {
    id: row.id,
    kind: row.kind,
    enabled: Boolean(row.enabled),
    time: row.send_time || "08:00",
    weekday: Number(row.weekday ?? 1),
    dayOfMonth: Number(row.day_of_month ?? 1),
    timezone: row.timezone || "UTC",
    label: row.label || "",
    createdAt: row.created_at,
  };
}

export function listReportSchedules(db, tenantId, config = {}) {
  ensureTenantSchedules(db, tenantId, config);
  return db
    .prepare("SELECT * FROM report_schedules WHERE tenant_id = ? ORDER BY created_at, id")
    .all(tenantId)
    .map(serializeSchedule);
}

function scheduleRow(db, tenantId, id) {
  const row = db
    .prepare("SELECT * FROM report_schedules WHERE id = ? AND tenant_id = ?")
    .get(id, tenantId);
  if (!row) throw Object.assign(new Error("Schedule not found"), { status: 404 });
  return row;
}

function normalizeSchedule(db, tenantId, body, config, current = null) {
  const kind = String(body.kind ?? current?.kind ?? "daily");
  assert(SCHEDULED_KINDS.includes(kind), 400, "Schedule kind must be daily, weekly, or monthly");
  const enabled = body.enabled === undefined ? (current ? Boolean(current.enabled) : true) : Boolean(body.enabled);
  const time = String(body.time ?? body.sendTime ?? current?.send_time ?? "08:00");
  assert(isValidTime(time), 400, "Schedule time must be HH:MM");
  const timezone = String(
    body.timezone ?? current?.timezone ?? getReportSettings(db, tenantId, config).timezone ?? "UTC"
  );
  assert(isValidTimezone(timezone), 400, "Report timezone must be a valid IANA timezone");
  const weekday = normalizeDay(body.weekday ?? current?.weekday ?? 1, { min: 0, max: 6, fallback: 1 });
  const dayOfMonth = normalizeDay(body.dayOfMonth ?? body.day ?? current?.day_of_month ?? 1, {
    min: 1,
    max: 28,
    fallback: 1,
  });
  const label = clampText(body.label ?? current?.label ?? "", 60);
  return { kind, enabled, time, timezone, weekday, dayOfMonth, label };
}

export function createReportSchedule(db, tenantId, body = {}, config = {}) {
  ensureTenantSchedules(db, tenantId, config);
  const next = normalizeSchedule(db, tenantId, body, config);
  const id = newId();
  db.prepare(
    `INSERT INTO report_schedules
       (id, tenant_id, kind, enabled, send_time, weekday, day_of_month, timezone, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    next.kind,
    next.enabled ? 1 : 0,
    next.time,
    next.weekday,
    next.dayOfMonth,
    next.timezone,
    next.label,
    nowIso()
  );
  return serializeSchedule(scheduleRow(db, tenantId, id));
}

export function updateReportSchedule(db, tenantId, id, body = {}, config = {}) {
  const current = scheduleRow(db, tenantId, id);
  const next = normalizeSchedule(db, tenantId, body, config, current);
  db.prepare(
    `UPDATE report_schedules
     SET kind = ?, enabled = ?, send_time = ?, weekday = ?, day_of_month = ?, timezone = ?, label = ?
     WHERE id = ? AND tenant_id = ?`
  ).run(
    next.kind,
    next.enabled ? 1 : 0,
    next.time,
    next.weekday,
    next.dayOfMonth,
    next.timezone,
    next.label,
    id,
    tenantId
  );
  return serializeSchedule(scheduleRow(db, tenantId, id));
}

export function deleteReportSchedule(db, tenantId, id) {
  scheduleRow(db, tenantId, id);
  const count = db
    .prepare("SELECT COUNT(*) AS count FROM report_schedules WHERE tenant_id = ?")
    .get(tenantId);
  assert(Number(count.count) > 1, 400, "Keep at least one schedule, or turn it off instead");
  db.prepare("DELETE FROM report_schedules WHERE id = ? AND tenant_id = ?").run(id, tenantId);
  return { deleted: true, id };
}

export function getReportSettings(db, tenantId, config) {
  const row = ensureSettingsRow(db, tenantId, config);
  ensureTenantSchedules(db, tenantId, config);
  const schedules = db
    .prepare("SELECT * FROM report_schedules WHERE tenant_id = ? ORDER BY created_at, id")
    .all(tenantId);
  const pick = (kind) => schedules.find((schedule) => schedule.kind === kind) || null;
  const daily = pick("daily");
  const weekly = pick("weekly");
  const monthly = pick("monthly");
  return {
    dailyEnabled: daily ? Boolean(daily.enabled) : false,
    dailyTime: daily?.send_time || row.daily_time || "08:00",
    weeklyEnabled: weekly ? Boolean(weekly.enabled) : false,
    weeklyDay: Number(weekly?.weekday ?? row.weekly_day ?? 1),
    weeklyTime: weekly?.send_time || row.weekly_time || "08:00",
    monthlyEnabled: monthly ? Boolean(monthly.enabled) : false,
    monthlyDay: Number(monthly?.day_of_month ?? row.monthly_day ?? 1),
    monthlyTime: monthly?.send_time || row.monthly_time || "08:00",
    timezone: schedules[0]?.timezone || row.timezone || "UTC",
    updatedAt: row.updated_at,
  };
}

function normalizeDay(value, { min, max, fallback }) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Legacy single-schedule endpoint: it edits the first schedule of each kind and
 * the workspace default timezone. The multi-schedule API is the fuller surface.
 */
export function saveReportSettings(db, tenantId, body = {}, config) {
  const current = getReportSettings(db, tenantId, config);
  const timezone = String(body.timezone ?? current.timezone ?? "UTC");
  assert(isValidTimezone(timezone), 400, "Report timezone must be a valid IANA timezone");

  const next = {
    dailyEnabled: body.dailyEnabled === undefined ? current.dailyEnabled : Boolean(body.dailyEnabled),
    dailyTime: String(body.dailyTime ?? current.dailyTime),
    weeklyEnabled: body.weeklyEnabled === undefined ? current.weeklyEnabled : Boolean(body.weeklyEnabled),
    weeklyDay: normalizeDay(body.weeklyDay ?? current.weeklyDay, { min: 0, max: 6, fallback: current.weeklyDay }),
    weeklyTime: String(body.weeklyTime ?? current.weeklyTime),
    monthlyEnabled:
      body.monthlyEnabled === undefined ? current.monthlyEnabled : Boolean(body.monthlyEnabled),
    monthlyDay: normalizeDay(body.monthlyDay ?? current.monthlyDay, { min: 1, max: 28, fallback: current.monthlyDay }),
    monthlyTime: String(body.monthlyTime ?? current.monthlyTime),
  };
  for (const key of ["dailyTime", "weeklyTime", "monthlyTime"]) {
    assert(isValidTime(next[key]), 400, "Report times must be HH:MM");
  }

  db.prepare(
    `UPDATE report_settings SET
       daily_enabled = ?, daily_time = ?,
       weekly_enabled = ?, weekly_day = ?, weekly_time = ?,
       monthly_enabled = ?, monthly_day = ?, monthly_time = ?,
       timezone = ?, updated_at = ?
     WHERE tenant_id = ?`
  ).run(
    next.dailyEnabled ? 1 : 0,
    next.dailyTime,
    next.weeklyEnabled ? 1 : 0,
    next.weeklyDay,
    next.weeklyTime,
    next.monthlyEnabled ? 1 : 0,
    next.monthlyDay,
    next.monthlyTime,
    timezone,
    nowIso(),
    tenantId
  );

  const schedules = db
    .prepare("SELECT * FROM report_schedules WHERE tenant_id = ? ORDER BY created_at, id")
    .all(tenantId);
  const apply = (kind, values) => {
    const row = schedules.find((schedule) => schedule.kind === kind);
    if (!row) return;
    db.prepare(
      `UPDATE report_schedules
       SET enabled = ?, send_time = ?, weekday = ?, day_of_month = ?, timezone = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(
      values.enabled ? 1 : 0,
      values.time,
      values.weekday ?? row.weekday,
      values.dayOfMonth ?? row.day_of_month,
      timezone,
      row.id,
      tenantId
    );
  };
  apply("daily", { enabled: next.dailyEnabled, time: next.dailyTime });
  apply("weekly", {
    enabled: next.weeklyEnabled,
    time: next.weeklyTime,
    weekday: next.weeklyDay,
  });
  apply("monthly", {
    enabled: next.monthlyEnabled,
    time: next.monthlyTime,
    dayOfMonth: next.monthlyDay,
  });
  // A single workspace timezone stays coherent across every extra schedule.
  db.prepare("UPDATE report_schedules SET timezone = ? WHERE tenant_id = ?").run(timezone, tenantId);

  return getReportSettings(db, tenantId, config);
}

function serializeCard(row, timezone) {
  return {
    id: row.id,
    title: row.title,
    column: row.column_key,
    dueDate: row.due_date || "",
    priority: row.priority || "normal",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || "",
    createdYmd: localDateOf(row.created_at, timezone),
    completedYmd: localDateOf(row.completed_at, timezone),
  };
}

const priorityRank = { high: 0, normal: 1, low: 2 };

function sortCards(cards) {
  return [...cards].sort((a, b) => {
    const priority = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    if (priority !== 0) return priority;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

export function boardSnapshot(db, tenantId, now, timezone, period) {
  const today = localTimeParts(now, timezone).date;
  const rows = db
    .prepare(
      `SELECT id, column_key, title, due_date, priority, created_at, updated_at, completed_at
       FROM cards WHERE tenant_id = ? AND deleted_at IS NULL
       ORDER BY position, created_at`
    )
    .all(tenantId)
    .map((row) => serializeCard(row, timezone));

  const counts = { todo: 0, doing: 0, review: 0, done: 0 };
  for (const card of rows) counts[card.column] = (counts[card.column] || 0) + 1;

  const open = rows.filter((card) => card.column !== "done");
  const pendingFromYesterday = sortCards(
    open.filter((card) => card.createdYmd && card.createdYmd < today)
  );
  const overdue = sortCards(open.filter((card) => card.dueDate && card.dueDate < today));
  const dueToday = sortCards(open.filter((card) => card.dueDate === today));
  const dueThisWeek = sortCards(
    open.filter((card) => card.dueDate && card.dueDate >= today && card.dueDate <= addDays(today, 7))
  );
  const stale = sortCards(
    open.filter((card) => card.updatedAt && localDateOf(card.updatedAt, timezone) < addDays(today, -7))
  );
  const highPriorityOpen = sortCards(open.filter((card) => card.priority === "high"));

  const inWindow = (ymd) => Boolean(ymd) && ymd >= period.startYmd && ymd <= period.endYmd;
  const createdInPeriod = rows.filter((card) => inWindow(card.createdYmd));
  const completedInPeriod = rows.filter((card) => inWindow(card.completedYmd));
  const completedToday = rows.filter((card) => card.completedYmd === today);

  const checklistRow = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(done) AS done FROM checklist_items WHERE tenant_id = ?`
    )
    .get(tenantId);
  const trashRow = db
    .prepare("SELECT COUNT(*) AS count FROM cards WHERE tenant_id = ? AND deleted_at IS NOT NULL")
    .get(tenantId);

  const total = rows.length;
  return {
    today,
    period: { startYmd: period.startYmd, endYmd: period.endYmd, key: period.key },
    counts,
    total,
    openCount: open.length,
    completionRate: total ? Math.round((counts.done / total) * 100) : 0,
    pendingFromYesterday,
    overdue,
    dueToday,
    dueThisWeek,
    stale,
    highPriorityOpen,
    createdInPeriod,
    completedInPeriod,
    completedToday,
    checklist: {
      total: Number(checklistRow?.total || 0),
      done: Number(checklistRow?.done || 0),
    },
    trashCount: Number(trashRow?.count || 0),
    cards: rows,
  };
}

function escapeMd(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/([*_`[\]])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

function cardLine(card, { showColumn = true, showDue = true } = {}) {
  const meta = [];
  if (showColumn) meta.push(COLUMN_LABEL[card.column] || card.column);
  if (showDue && card.dueDate) meta.push(`due ${card.dueDate}`);
  if (card.priority && card.priority !== "normal") meta.push(card.priority);
  const suffix = meta.length ? ` — ${meta.join(" · ")}` : "";
  return `- **${escapeMd(card.title)}**${suffix}`;
}

function cardSection(cards, options) {
  if (!cards.length) return "_Nothing here._";
  const visible = cards.slice(0, MAX_LISTED).map((card) => cardLine(card, options));
  if (cards.length > visible.length) {
    visible.push(`- …and ${cards.length - visible.length} more`);
  }
  return visible.join("\n");
}

function statsTable(snapshot) {
  return [
    "| To Do | Doing | Under Review | Done | Still open | Completion |",
    "| --- | --- | --- | --- | --- | --- |",
    `| ${snapshot.counts.todo} | ${snapshot.counts.doing} | ${snapshot.counts.review} | ${snapshot.counts.done} | ${snapshot.openCount} | ${snapshot.completionRate}% |`,
  ].join("\n");
}

function dailyMarkdown(tenant, snapshot, period) {
  const lines = [
    `# Daily brief · ${period.label}`,
    "",
    `**${snapshot.pendingFromYesterday.length} pending from yesterday · ${snapshot.overdue.length} overdue · ${snapshot.dueToday.length} due today · ${snapshot.completedToday.length} completed today**`,
    "",
  ];

  if (snapshot.overdue.length) {
    lines.push("## Overdue", "", cardSection(snapshot.overdue), "");
  }
  if (snapshot.dueToday.length) {
    lines.push("## Due today", "", cardSection(snapshot.dueToday), "");
  }
  lines.push(
    "## Still pending from yesterday",
    "",
    cardSection(snapshot.pendingFromYesterday),
    ""
  );
  if (snapshot.completedToday.length) {
    lines.push(
      "## Completed today",
      "",
      cardSection(snapshot.completedToday, { showColumn: false, showDue: false }),
      ""
    );
  }
  if (snapshot.highPriorityOpen.length) {
    lines.push("## High priority, still open", "", cardSection(snapshot.highPriorityOpen), "");
  }
  lines.push(
    "## Board at a glance",
    "",
    statsTable(snapshot),
    "",
    `_${tenant.name} · trash ${snapshot.trashCount} · checklist ${snapshot.checklist.done}/${snapshot.checklist.total} done_`
  );
  return lines.join("\n");
}

function weeklyMarkdown(tenant, snapshot, period) {
  const lines = [
    `# Weekly report · ${period.label}`,
    "",
    `**${snapshot.completedInPeriod.length} completed · ${snapshot.createdInPeriod.length} created · ${snapshot.openCount} still open**`,
    "",
    "## Completed this week",
    "",
    cardSection(snapshot.completedInPeriod, { showColumn: false, showDue: false }),
    "",
    "## Added this week",
    "",
    cardSection(snapshot.createdInPeriod, { showColumn: true, showDue: true }),
    "",
    "## Carried over",
    "",
    cardSection(snapshot.pendingFromYesterday),
    "",
  ];
  if (snapshot.overdue.length) {
    lines.push("## Overdue", "", cardSection(snapshot.overdue), "");
  }
  lines.push(
    "## By the numbers",
    "",
    statsTable(snapshot),
    "",
    `- High priority still open: **${snapshot.highPriorityOpen.length}**`,
    `- Stale for more than a week: **${snapshot.stale.length}**`,
    `- Checklist progress: **${snapshot.checklist.done}/${snapshot.checklist.total}**`,
    `- Cards in trash: **${snapshot.trashCount}**`,
    "",
    `_${tenant.name} · week of ${period.startYmd} to ${period.endYmd}_`
  );
  return lines.join("\n");
}

function monthlyMarkdown(tenant, snapshot, period) {
  const byPriority = { high: 0, normal: 0, low: 0 };
  for (const card of snapshot.completedInPeriod) {
    byPriority[card.priority] = (byPriority[card.priority] || 0) + 1;
  }
  const lines = [
    `# Monthly report · ${period.label}`,
    "",
    `**${snapshot.completedInPeriod.length} completed · ${snapshot.createdInPeriod.length} created · ${snapshot.openCount} carried into the next month**`,
    "",
    "## Delivered",
    "",
    cardSection(snapshot.completedInPeriod, { showColumn: false, showDue: false }),
    "",
    "## Started this month",
    "",
    cardSection(snapshot.createdInPeriod, { showColumn: true, showDue: true }),
    "",
    "## Carried forward",
    "",
    cardSection(snapshot.pendingFromYesterday),
    "",
    "## By the numbers",
    "",
    statsTable(snapshot),
    "",
    `- Completed by priority: high **${byPriority.high}** · normal **${byPriority.normal}** · low **${byPriority.low}**`,
    `- Still open with a deadline: **${snapshot.overdue.length + snapshot.dueToday.length}**`,
    `- High priority still open: **${snapshot.highPriorityOpen.length}**`,
    `- Checklist progress: **${snapshot.checklist.done}/${snapshot.checklist.total}**`,
    "",
    `_${tenant.name} · ${period.startYmd} to ${period.endYmd}_`
  ];
  return lines.join("\n");
}

function reportTitle(kind, period) {
  if (kind === "weekly") return `Weekly report · ${period.label}`;
  if (kind === "monthly") return `Monthly report · ${period.label}`;
  return `Daily brief · ${period.label}`;
}

function buildDeterministic(kind, tenant, snapshot, period) {
  if (kind === "weekly") return weeklyMarkdown(tenant, snapshot, period);
  if (kind === "monthly") return monthlyMarkdown(tenant, snapshot, period);
  return dailyMarkdown(tenant, snapshot, period);
}

function summaryLine(kind, snapshot, period) {
  if (kind === "weekly") {
    return `${snapshot.completedInPeriod.length} completed · ${snapshot.createdInPeriod.length} created · ${snapshot.openCount} still open`;
  }
  if (kind === "monthly") {
    return `${snapshot.completedInPeriod.length} completed · ${snapshot.createdInPeriod.length} created · ${snapshot.openCount} carried forward`;
  }
  return `${snapshot.pendingFromYesterday.length} pending from yesterday · ${snapshot.overdue.length} overdue · ${snapshot.dueToday.length} due today`;
}

const SUMMARY_SYSTEM = [
  "You are poca-note's reporting assistant for a small, focused team.",
  "Write a short, factual opening for a work report.",
  "Return plain prose only: 2–3 sentences, no headings, no bullet lists, no Markdown fences.",
  "Use only the facts supplied. Never invent names, metrics, or commitments.",
].join(" ");

function narrativeFacts(kind, snapshot, period, tenant) {
  const facts = [
    `Workspace: ${tenant.name}`,
    `Period: ${period.label} (${period.startYmd} to ${period.endYmd})`,
    `Open cards: ${snapshot.openCount}`,
    `To Do / Doing / Under Review / Done: ${snapshot.counts.todo} / ${snapshot.counts.doing} / ${snapshot.counts.review} / ${snapshot.counts.done}`,
    `Completed in period: ${snapshot.completedInPeriod.length}`,
    `Created in period: ${snapshot.createdInPeriod.length}`,
    `Pending from yesterday: ${snapshot.pendingFromYesterday.length}`,
    `Overdue: ${snapshot.overdue.length}`,
    `Due today: ${snapshot.dueToday.length}`,
    `High priority open: ${snapshot.highPriorityOpen.length}`,
    `Stale for over a week: ${snapshot.stale.length}`,
  ];
  if (snapshot.overdue.length) {
    facts.push(`Overdue titles: ${snapshot.overdue.slice(0, 5).map((card) => card.title).join("; ")}`);
  }
  if (snapshot.completedInPeriod.length) {
    facts.push(
      `Completed titles: ${snapshot.completedInPeriod.slice(0, 5).map((card) => card.title).join("; ")}`
    );
  }
  return `Report kind: ${kind}. Summarize the state of work in 2-3 sentences, focused on what needs attention next.\n\n${facts.join("\n")}`;
}

function cleanNarrative(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

async function modelNarrative({ config, kind, snapshot, period, tenant }) {
  try {
    const result = await generateText({
      config,
      system: SUMMARY_SYSTEM,
      prompt: narrativeFacts(kind, snapshot, period, tenant),
      maxTokens: 320,
      temperature: 0.3,
    });
    if (!result.content) return null;
    const text = cleanNarrative(result.content);
    if (!text) return null;
    return { text, provider: result.provider, model: result.model };
  } catch {
    return null;
  }
}

function serializeReport(row) {
  let metrics = null;
  try {
    metrics = JSON.parse(row.metrics);
  } catch {
    metrics = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    scheduleId: row.schedule_id || null,
    periodKey: row.period_key,
    trigger: row.trigger,
    title: row.title,
    summary: row.summary,
    content: row.content,
    metrics,
    createdAt: row.created_at,
  };
}

/**
 * Build and persist a report. Scheduled reports are deduplicated per
 * (tenant, kind, period) by a partial unique index.
 */
export async function generateReport({
  db,
  config,
  tenant,
  kind = "daily",
  trigger = "manual",
  scheduleId = null,
  now = new Date(),
  withNarrative = true,
  logger = console,
}) {
  const safeKind = REPORT_KINDS.includes(kind) ? kind : "daily";
  const settings = getReportSettings(db, tenant.id, config);
  const timezone = settings.timezone;
  const period = periodFor(safeKind === "brief" ? "daily" : safeKind, now, timezone);
  const snapshot = boardSnapshot(db, tenant.id, now, timezone, period);

  let content = buildDeterministic(safeKind === "brief" ? "daily" : safeKind, tenant, snapshot, period);
  let provider = null;
  if (withNarrative) {
    const narrative = await modelNarrative({ config, kind: safeKind, snapshot, period, tenant });
    if (narrative) {
      provider = narrative.provider;
      const lines = content.split("\n");
      const insertAt = lines.findIndex((line) => line.startsWith("**"));
      if (insertAt >= 0) {
        lines.splice(insertAt + 1, 0, "", narrative.text);
        content = lines.join("\n");
      }
    }
  }

  const id = newId();
  const createdAt = nowIso();
  const title = reportTitle(safeKind === "brief" ? "daily" : safeKind, period);
  const summary = summaryLine(safeKind === "brief" ? "daily" : safeKind, snapshot, period);
  const metrics = {
    period: { key: period.key, startYmd: period.startYmd, endYmd: period.endYmd, label: period.label },
    counts: snapshot.counts,
    total: snapshot.total,
    openCount: snapshot.openCount,
    completionRate: snapshot.completionRate,
    pendingFromYesterday: snapshot.pendingFromYesterday.length,
    overdue: snapshot.overdue.length,
    dueToday: snapshot.dueToday.length,
    completedInPeriod: snapshot.completedInPeriod.length,
    createdInPeriod: snapshot.createdInPeriod.length,
    highPriorityOpen: snapshot.highPriorityOpen.length,
    stale: snapshot.stale.length,
    checklist: snapshot.checklist,
    trashCount: snapshot.trashCount,
  };

  const statement =
    trigger === "scheduled"
      ? `INSERT OR IGNORE INTO reports
           (id, tenant_id, schedule_id, kind, period_key, trigger, title, summary, content, metrics, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO reports
           (id, tenant_id, schedule_id, kind, period_key, trigger, title, summary, content, metrics, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const run = db
    .prepare(statement)
    .run(
      id,
      tenant.id,
      scheduleId,
      safeKind,
      period.key,
      trigger,
      title,
      summary,
      content,
      JSON.stringify(metrics),
      provider,
      createdAt
    );
  if (trigger === "scheduled" && Number(run.changes) === 0) {
    const existing = db
      .prepare(
        `SELECT * FROM reports
         WHERE tenant_id = ? AND schedule_id IS ? AND kind = ? AND period_key = ? AND trigger = 'scheduled'`
      )
      .get(tenant.id, scheduleId, safeKind, period.key);
    return { duplicate: true, report: existing ? serializeReport(existing) : null };
  }
  if (trigger === "scheduled") {
    logger?.log?.(`[reports] generated ${safeKind} report for ${tenant.slug} (${period.key})`);
  }
  const row = db.prepare("SELECT * FROM reports WHERE id = ?").get(id);
  return { duplicate: false, report: serializeReport(row), revision: getRevision(db, tenant.id) };
}

export function listReports(db, tenantId, { kind = null, limit = 20 } = {}) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 60);
  const rows = kind && REPORT_KINDS.includes(kind)
    ? db
        .prepare("SELECT * FROM reports WHERE tenant_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?")
        .all(tenantId, kind, size)
    : db
        .prepare("SELECT * FROM reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(tenantId, size);
  return rows.map(serializeReport);
}

export function latestReports(db, tenantId) {
  const kinds = ["brief", "daily", "weekly", "monthly"];
  const out = {};
  for (const kind of kinds) {
    const row = db
      .prepare("SELECT * FROM reports WHERE tenant_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
      .get(tenantId, kind);
    out[kind] = row ? serializeReport(row) : null;
  }
  return out;
}

export function reportCounts(db, tenantId) {
  const rows = db
    .prepare("SELECT kind, COUNT(*) AS count FROM reports WHERE tenant_id = ? GROUP BY kind")
    .all(tenantId);
  const counts = { daily: 0, weekly: 0, monthly: 0, brief: 0 };
  for (const row of rows) counts[row.kind] = Number(row.count);
  return counts;
}

function startOfWeekMonday(ymd) {
  const day = weekdayOf(ymd);
  return addDays(ymd, -((day + 6) % 7));
}

function addMonths(ymd, delta) {
  const [year, month] = ymd.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 10);
}

function lastDayOfMonth(ymd) {
  const [year, month] = ymd.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Bucketed throughput for the performance charts: how much work was created and
 * completed in each day/week/month, plus the backlog at the end of the bucket.
 * Everything is computed from card timestamps; nothing is estimated.
 */
export function performanceSeries(
  db,
  tenantId,
  { range = "daily", timezone = "UTC", now = new Date(), dashboardId = null } = {}
) {
  const safeRange = ["daily", "weekly", "monthly"].includes(range) ? range : "daily";
  const today = localTimeParts(now, timezone).date;
  const buckets = [];

  if (safeRange === "daily") {
    for (let offset = 13; offset >= 0; offset -= 1) {
      const key = addDays(today, -offset);
      buckets.push({
        key,
        label: labelFor(key, timezone, { month: "short", day: "numeric" }),
        startYmd: key,
        endYmd: key,
      });
    }
  } else if (safeRange === "weekly") {
    const current = startOfWeekMonday(today);
    for (let offset = 7; offset >= 0; offset -= 1) {
      const startYmd = addDays(current, -7 * offset);
      const endYmd = addDays(startYmd, 6);
      buckets.push({
        key: startYmd,
        label: labelFor(startYmd, timezone, { month: "short", day: "numeric" }),
        startYmd,
        endYmd,
      });
    }
  } else {
    const firstOfMonth = `${today.slice(0, 8)}01`;
    for (let offset = 5; offset >= 0; offset -= 1) {
      const startYmd = addMonths(firstOfMonth, -offset);
      buckets.push({
        key: startYmd.slice(0, 7),
        label: labelFor(startYmd, timezone, { month: "short", year: "numeric" }),
        startYmd,
        endYmd: lastDayOfMonth(startYmd),
      });
    }
  }

  const scope = dashboardId ? " AND dashboard_id = ?" : "";
  const args = dashboardId ? [tenantId, dashboardId] : [tenantId];
  const rows = db
    .prepare(
      `SELECT id, dashboard_id, column_key, priority, created_at, completed_at
       FROM cards WHERE tenant_id = ? AND deleted_at IS NULL${scope}`
    )
    .all(...args)
    .map((row) => ({
      ...row,
      createdYmd: localDateOf(row.created_at, timezone),
      completedYmd: localDateOf(row.completed_at, timezone),
    }));

  const series = buckets.map((bucket) => {
    const created = rows.filter(
      (card) => card.createdYmd >= bucket.startYmd && card.createdYmd <= bucket.endYmd
    ).length;
    const completed = rows.filter(
      (card) => card.completedYmd && card.completedYmd >= bucket.startYmd && card.completedYmd <= bucket.endYmd
    ).length;
    const backlog = rows.filter(
      (card) =>
        card.createdYmd &&
        card.createdYmd <= bucket.endYmd &&
        (!card.completedYmd || card.completedYmd > bucket.endYmd)
    ).length;
    return { ...bucket, created, completed, backlog };
  });

  const byColumn = { todo: 0, doing: 0, review: 0, done: 0 };
  const byPriority = { high: 0, normal: 0, low: 0 };
  for (const card of rows) {
    byColumn[card.column_key] = (byColumn[card.column_key] || 0) + 1;
    if (card.column_key !== "done") {
      byPriority[card.priority] = (byPriority[card.priority] || 0) + 1;
    }
  }
  const total = rows.length;
  const done = byColumn.done || 0;
  const open = total - done;
  const createdTotal = series.reduce((sum, bucket) => sum + bucket.created, 0);
  const completedTotal = series.reduce((sum, bucket) => sum + bucket.completed, 0);

  return {
    range: safeRange,
    timezone,
    dashboardId: dashboardId || null,
    generatedAt: nowIso(),
    buckets: series,
    totals: {
      created: createdTotal,
      completed: completedTotal,
      net: createdTotal - completedTotal,
      open,
      done,
      total,
      completionRate: total ? Math.round((done / total) * 100) : 0,
    },
    byColumn,
    byPriority,
    byDashboard: listDashboards(db, tenantId),
    cardCount: rows.length,
  };
}

export async function processScheduledReports({ db, config, now = new Date(), logger = console }) {
  if (config.reports?.enabled === false) return [];
  ensureTenantSchedulesEverywhere(db, config);
  const rows = db
    .prepare(
      `SELECT s.*, t.id AS tenant_id, t.slug, t.name
       FROM report_schedules s JOIN tenants t ON t.id = s.tenant_id
       WHERE s.enabled = 1
       ORDER BY s.created_at,
         CASE s.kind WHEN 'daily' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END,
         s.id`
    )
    .all();
  const results = [];
  for (const row of rows) {
    const timezone = row.timezone || "UTC";
    const local = localTimeParts(now, timezone);
    const weekday = weekdayOf(local.date);
    const dayOfMonth = Number(local.date.slice(8, 10));
    const due =
      row.kind === "weekly"
        ? weekday === Number(row.weekday ?? 1)
        : row.kind === "monthly"
          ? dayOfMonth === Number(row.day_of_month ?? 1)
          : true;
    if (!due) continue;

    const delta = local.minutes - toMinutes(row.send_time);
    if (delta < 0 || delta > config.reports.graceMinutes) continue;
    try {
      const period = periodFor(row.kind, now, timezone);
      const existing = db
        .prepare(
          `SELECT id FROM reports
           WHERE tenant_id = ? AND schedule_id = ? AND period_key = ? AND trigger = 'scheduled'`
        )
        .get(row.tenant_id, row.id, period.key);
      if (existing) continue;
      const result = await generateReport({
        db,
        config,
        tenant: { id: row.tenant_id, slug: row.slug, name: row.name },
        kind: row.kind,
        trigger: "scheduled",
        scheduleId: row.id,
        now,
        logger,
      });
      results.push({
        tenant: row.slug,
        kind: row.kind,
        scheduleId: row.id,
        periodKey: period.key,
        ...result,
      });
    } catch (error) {
      logger?.error?.(`[reports] ${row.kind} report failed for ${row.slug}:`, error);
      results.push({ tenant: row.slug, kind: row.kind, scheduleId: row.id, error: error.message });
    }
  }
  return results;
}

function ensureTenantSchedulesEverywhere(db, config) {
  const tenants = db
    .prepare(
      `SELECT t.id FROM tenants t
       LEFT JOIN report_schedules s ON s.tenant_id = t.id
       WHERE s.id IS NULL`
    )
    .all();
  for (const tenant of tenants) ensureTenantSchedules(db, tenant.id, config);
}

export function startReportScheduler({ db, config, logger = console }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processScheduledReports({ db, config, logger });
    } catch (error) {
      logger?.error?.("[reports] scheduler tick failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.reports.intervalMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
