export const COLUMNS = [
  { key: "todo", label: "To Do", dot: "todo" },
  { key: "doing", label: "Doing", dot: "doing" },
  { key: "review", label: "Under Review", dot: "review" },
  { key: "done", label: "Done", dot: "done" },
];

export const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((column) => [column.key, column.label]));

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateOnly(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}

export function formatDue(value) {
  const date = parseDateOnly(value);
  if (!date) return "";
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const diff = Math.round((date.getTime() - start.getTime()) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const formatted = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return diff < 0 ? `${formatted} · overdue` : formatted;
}

export function isOverdue(value, column) {
  if (!value || column === "done") return false;
  const date = parseDateOnly(value);
  if (!date) return false;
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return date.getTime() < start.getTime();
}

export function formatRelative(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 86_400 * 7) return `${Math.round(seconds / 86_400)}d ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function formatDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function shortHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "";
  }
}

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.not_started;
}

export const STATUSES = ["not_started", "in_progress", "blocked", "done"];

export const STATUS_META = {
  not_started: { label: "Not started", className: "status-not-started" },
  in_progress: { label: "In progress", className: "status-in-progress" },
  blocked: { label: "Blocked", className: "status-blocked" },
  done: { label: "Done", className: "status-done" },
};

/** True when the last recorded activity is older than the check-in interval. */
export function needsUpdate(lastActivity, intervalDays = 3) {
  if (!lastActivity) return false;
  const time = new Date(lastActivity).getTime();
  if (!Number.isFinite(time)) return false;
  return Date.now() - time > Math.max(1, Number(intervalDays) || 3) * 86_400_000;
}

export function cardNeedsUpdate(card, intervalDays = 3) {
  if (!card || card.status === "done" || card.column === "done") return false;
  return needsUpdate(card.lastUpdateAt || card.createdAt, intervalDays);
}

export function subtaskNeedsUpdate(item, intervalDays = 3) {
  if (!item || item.done || item.status === "done") return false;
  return needsUpdate(item.lastUpdateAt || item.createdAt, intervalDays);
}

export function checklistProgress(checklist = []) {
  const total = checklist.length;
  const done = checklist.filter((item) => item.done).length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0 };
}

export function sortCards(cards, column) {
  return cards
    .filter((card) => card.column === column)
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

export function endPosition(cards, column) {
  const list = sortCards(cards, column);
  return list.length ? list[list.length - 1].position + 1000 : 1000;
}

export function truncate(value, length = 80) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function matchesQuery(card, query) {
  const search = String(query || "").trim().toLowerCase().replace(/^task\s+/, "").replace(/^#/, "");
  if (!search) return true;
  const checklist = Array.isArray(card.checklist) ? card.checklist : [];
  return [card.taskNo, card.title, card.notes, card.linkTitle, card.linkUrl, ...checklist.map((item) => item.text), ...checklist.map((item) => item.taskNo)]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}

export function relativeDayLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(date);
}
