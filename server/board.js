import {
  allocateTaskNo,
  bumpRevision,
  getRevision,
  nowIso,
  withTx,
} from "./db.js";
import {
  HttpError,
  assert,
  cleanTitle,
  clampText,
  isHttpUrl,
  newId,
  normalizeDate,
} from "./util.js";
import { resolveDashboardId } from "./dashboards.js";

export const COLUMNS = ["todo", "doing", "review", "done"];
export const PRIORITIES = ["low", "normal", "high"];
export const STATUSES = ["not_started", "in_progress", "blocked", "done"];
export const STATUS_LABELS = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};
export const DEFAULT_UPDATE_INTERVAL_DAYS = 3;

const COLUMN_LABELS = { todo: "To Do", doing: "Doing", review: "Under Review", done: "Done" };

export function statusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.not_started;
}

function validateStatus(value) {
  assert(STATUSES.includes(value), 400, "Status must be not_started, in_progress, blocked, or done");
  return value;
}

/** Keep a card's status consistent with the column it lives in. */
function statusForColumn(column, currentStatus) {
  if (column === "done") return "done";
  if (currentStatus === "done") return column === "todo" ? "not_started" : "in_progress";
  if ((column === "doing" || column === "review") && currentStatus === "not_started") {
    return "in_progress";
  }
  return currentStatus;
}

function serializeUpdate(row) {
  return {
    id: row.id,
    cardId: row.card_id || row.cardId,
    checklistItemId: row.checklist_item_id || row.checklistItemId || "",
    taskNo: row.task_no || row.taskNo || "",
    author: row.author || "",
    kind: row.kind || "note",
    status: row.status || "",
    body: row.body || "",
    createdAt: row.created_at || row.createdAt,
  };
}

function serializeChecklist(row, updates = []) {
  const done = Boolean(row.done);
  return {
    id: row.id,
    taskNo: row.task_no || row.taskNo || "",
    text: row.text,
    done,
    status: row.status || (done ? "done" : "not_started"),
    position: Number(row.position),
    createdAt: row.created_at || row.createdAt,
    lastUpdateAt: updates[0]?.created_at || updates[0]?.createdAt || row.created_at || row.createdAt || "",
    updates: updates.map(serializeUpdate),
  };
}

export function serializeCard(row, checklist = [], updates = [], itemUpdates = new Map()) {
  return {
    id: row.id,
    taskNo: row.task_no || "",
    dashboardId: row.dashboard_id || "",
    column: row.column_key,
    position: Number(row.position),
    title: row.title,
    notes: row.notes || "",
    linkUrl: row.link_url || "",
    linkTitle: row.link_title || "",
    dueDate: row.due_date || "",
    priority: row.priority || "normal",
    status: row.status || (row.column_key === "done" ? "done" : "not_started"),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || "",
    lastUpdateAt: updates[0]?.created_at || updates[0]?.createdAt || row.created_at,
    updates: updates.map(serializeUpdate),
    deletedAt: row.deleted_at || "",
    checklist: checklist.map((item) => serializeChecklist(item, itemUpdates.get(item.id) || [])),
  };
}

function groupUpdates(rows) {
  const byCard = new Map();
  const byItem = new Map();
  for (const row of rows) {
    if (row.checklist_item_id) {
      if (!byItem.has(row.checklist_item_id)) byItem.set(row.checklist_item_id, []);
      byItem.get(row.checklist_item_id).push(row);
    } else {
      if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
      byCard.get(row.card_id).push(row);
    }
  }
  return { byCard, byItem };
}

/** Record a status change or a written progress note. */
function insertTaskUpdate(db, tenantId, { cardId, checklistItemId = null, taskNo = "", actor = null, kind = "note", status = "", body = "" }) {
  const id = newId();
  db.prepare(
    `INSERT INTO task_updates
      (id, tenant_id, card_id, checklist_item_id, task_no, author, kind, status, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    tenantId,
    cardId,
    checklistItemId,
    taskNo || null,
    actor?.displayName || actor?.username || "",
    kind,
    status || null,
    body || "",
    nowIso()
  );
  return id;
}

export function getUpdateIntervalDays(db, tenantId) {
  const row = db
    .prepare("SELECT update_interval_days FROM tenant_state WHERE tenant_id = ?")
    .get(tenantId);
  const value = Number(row?.update_interval_days);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_UPDATE_INTERVAL_DAYS;
}

export function setUpdateIntervalDays(db, tenantId, days) {
  const value = Number(days);
  assert(
    Number.isInteger(value) && value >= 1 && value <= 365,
    400,
    "Update interval must be a whole number of days between 1 and 365"
  );
  const revision = withTx(db, () => {
    db.prepare(
      `INSERT INTO tenant_state (tenant_id, revision, update_interval_days, updated_at)
       VALUES (?, 2, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE
         SET update_interval_days = excluded.update_interval_days,
             updated_at = excluded.updated_at`
    ).run(tenantId, value, nowIso());
    return bumpRevision(db, tenantId);
  });
  return { intervalDays: value, revision };
}


export function loadBoard(db, tenantId, { dashboardId = null } = {}) {
  const scope = dashboardId ? " AND dashboard_id = ?" : "";
  const scopeArgs = dashboardId ? [dashboardId] : [];
  const cards = db
    .prepare(
      `SELECT * FROM cards
       WHERE tenant_id = ? AND deleted_at IS NULL${scope}
       ORDER BY column_key, position, created_at`
    )
    .all(tenantId, ...scopeArgs);
  const checklistRows = db
    .prepare(
      `SELECT ci.* FROM checklist_items ci
       JOIN cards c ON c.id = ci.card_id
       WHERE ci.tenant_id = ? AND c.deleted_at IS NULL${dashboardId ? " AND c.dashboard_id = ?" : ""}
       ORDER BY ci.position, ci.created_at`
    )
    .all(tenantId, ...scopeArgs);
  const updateRows = db
    .prepare(
      `SELECT tu.* FROM task_updates tu
       JOIN cards c ON c.id = tu.card_id
       WHERE tu.tenant_id = ? AND c.deleted_at IS NULL${dashboardId ? " AND c.dashboard_id = ?" : ""}
       ORDER BY tu.created_at DESC`
    )
    .all(tenantId, ...scopeArgs);
  const byCard = new Map();
  for (const row of checklistRows) {
    if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
    byCard.get(row.card_id).push(row);
  }
  const updateGroups = groupUpdates(updateRows);
  const trash = db
    .prepare(
      `SELECT COUNT(*) AS count FROM cards WHERE tenant_id = ? AND deleted_at IS NOT NULL`
    )
    .get(tenantId);
  return {
    revision: getRevision(db, tenantId),
    dashboardId: dashboardId || null,
    updateIntervalDays: getUpdateIntervalDays(db, tenantId),
    cards: cards.map((row) =>
      serializeCard(
        row,
        byCard.get(row.id) || [],
        updateGroups.byCard.get(row.id) || [],
        updateGroups.byItem
      )
    ),
    trashCount: Number(trash.count || 0),
    serverTime: nowIso(),
  };
}

export function loadTrash(db, tenantId) {
  const cards = db
    .prepare(
      `SELECT * FROM cards
       WHERE tenant_id = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC`
    )
    .all(tenantId);
  const checklistRows = db
    .prepare(
      `SELECT ci.* FROM checklist_items ci
       JOIN cards c ON c.id = ci.card_id
       WHERE ci.tenant_id = ? AND c.deleted_at IS NOT NULL
       ORDER BY ci.position, ci.created_at`
    )
    .all(tenantId);
  const byCard = new Map();
  for (const row of checklistRows) {
    if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
    byCard.get(row.card_id).push(row);
  }
  return {
    revision: getRevision(db, tenantId),
    cards: cards.map((row) => ({
      ...serializeCard(row, byCard.get(row.id) || []),
      deletedAt: row.deleted_at,
    })),
  };
}

export function getCard(db, tenantId, cardId, { includeDeleted = false } = {}) {
  const row = db
    .prepare(
      `SELECT * FROM cards
       WHERE id = ? AND tenant_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`
    )
    .get(cardId, tenantId);
  if (!row) return null;
  const checklist = db
    .prepare(
      `SELECT * FROM checklist_items WHERE card_id = ? AND tenant_id = ?
       ORDER BY position, created_at`
    )
    .all(cardId, tenantId);
  const updateRows = db
    .prepare(
      `SELECT * FROM task_updates WHERE card_id = ? AND tenant_id = ?
       ORDER BY created_at DESC`
    )
    .all(cardId, tenantId);
  const updateGroups = groupUpdates(updateRows);
  return serializeCard(
    row,
    checklist,
    updateGroups.byCard.get(cardId) || [],
    updateGroups.byItem
  );
}

function requireCard(db, tenantId, cardId, options) {
  const card = getCard(db, tenantId, cardId, options);
  if (!card) throw new HttpError(404, "Card not found");
  return card;
}

function endPosition(db, tenantId, dashboardId, column) {
  const row = db
    .prepare(
      `SELECT MAX(position) AS max_position FROM cards
       WHERE tenant_id = ? AND dashboard_id = ? AND column_key = ? AND deleted_at IS NULL`
    )
    .get(tenantId, dashboardId, column);
  return Number(row?.max_position ?? 0) + 1000;
}

function normalizePositions(db, tenantId, dashboardId, column) {
  const rows = db
    .prepare(
      `SELECT id FROM cards
       WHERE tenant_id = ? AND dashboard_id = ? AND column_key = ? AND deleted_at IS NULL
       ORDER BY position, created_at`
    )
    .all(tenantId, dashboardId, column);
  const update = db.prepare("UPDATE cards SET position = ? WHERE id = ? AND tenant_id = ?");
  rows.forEach((row, index) => update.run((index + 1) * 1000, row.id, tenantId));
}

function touchedPositionsNeedNormalizing(db, tenantId, dashboardId, column) {
  const rows = db
    .prepare(
      `SELECT position FROM cards
       WHERE tenant_id = ? AND dashboard_id = ? AND column_key = ? AND deleted_at IS NULL
       ORDER BY position, created_at`
    )
    .all(tenantId, dashboardId, column);
  for (let i = 1; i < rows.length; i += 1) {
    const gap = Number(rows[i].position) - Number(rows[i - 1].position);
    if (!Number.isFinite(gap) || gap < 0.001) return true;
  }
  return false;
}

function validateUrl(value) {
  const url = clampText(value, 2000);
  if (!url) return null;
  assert(isHttpUrl(url), 400, "Link must be an http(s) URL");
  return url;
}

function validatePriority(value) {
  if (value === undefined || value === null || value === "") return "normal";
  assert(PRIORITIES.includes(value), 400, "Priority must be low, normal, or high");
  return value;
}

function validateColumn(value) {
  assert(COLUMNS.includes(value), 400, "Column must be todo, doing, review, or done");
  return value;
}

function validateDueDate(value) {
  if (value === undefined) return null;
  if (value === null || value === "") return null;
  const normalized = normalizeDate(value);
  assert(normalized !== undefined, 400, "Due date must be YYYY-MM-DD");
  return normalized;
}

function validateNotes(value) {
  return clampText(value, 20_000);
}

export function createCard(db, tenantId, body) {
  const title = cleanTitle(body.title);
  assert(title, 400, "A card title is required");
  let column = validateColumn(body.column || "todo");
  const dashboardId = resolveDashboardId(db, tenantId, body.dashboardId);
  const notes = validateNotes(body.notes);
  const linkUrl = validateUrl(body.linkUrl);
  const linkTitle = clampText(body.linkTitle, 500);
  const dueDate = validateDueDate(body.dueDate);
  assert(dueDate !== undefined, 400, "Due date must be YYYY-MM-DD");
  const priority = validatePriority(body.priority);
  const explicitStatus = body.status !== undefined;
  const requestedStatus = explicitStatus ? validateStatus(body.status) : "not_started";
  if (explicitStatus) {
    if (requestedStatus === "done") column = "done";
    else if (column === "done") column = "doing";
  }
  const status = explicitStatus ? requestedStatus : statusForColumn(column, requestedStatus);
  let position = Number(body.position);
  if (!Number.isFinite(position)) position = endPosition(db, tenantId, dashboardId, column);
  const id = newId();
  const timestamp = nowIso();

  const revision = withTx(db, () => {
    const taskNo = allocateTaskNo(db, tenantId);
    db.prepare(
      `INSERT INTO cards
        (id, tenant_id, dashboard_id, task_no, column_key, position, title, notes, link_url, link_title,
         due_date, priority, status, version, created_at, updated_at, completed_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)`
    ).run(
      id,
      tenantId,
      dashboardId,
      taskNo,
      column,
      position,
      title,
      notes || "",
      linkUrl,
      linkTitle || null,
      dueDate || null,
      priority,
      status,
      timestamp,
      timestamp,
      column === "done" ? timestamp : null
    );
    return bumpRevision(db, tenantId);
  });

  return { card: getCard(db, tenantId, id), revision };
}

export function patchCard(db, tenantId, cardId, body, actor = null) {
  const current = requireCard(db, tenantId, cardId);
  assert(Number.isInteger(body.version), 400, "A card version is required");
  if (body.version !== current.version) {
    throw new HttpError(409, "This card changed on another device.", {
      card: current,
      revision: getRevision(db, tenantId),
    });
  }

  const updates = [];
  const values = [];
  const set = (column, value) => {
    updates.push(`${column} = ?`);
    values.push(value);
  };

  if (body.title !== undefined) {
    const title = cleanTitle(body.title);
    assert(title, 400, "A card title is required");
    set("title", title);
  }
  if (body.notes !== undefined) set("notes", validateNotes(body.notes));
  if (body.linkUrl !== undefined) set("link_url", validateUrl(body.linkUrl));
  if (body.linkTitle !== undefined) set("link_title", clampText(body.linkTitle, 500) || null);
  if (body.dueDate !== undefined) {
    const dueDate = validateDueDate(body.dueDate);
    assert(dueDate !== undefined, 400, "Due date must be YYYY-MM-DD");
    set("due_date", dueDate);
  }
  if (body.priority !== undefined) set("priority", validatePriority(body.priority));

  const statusRequested = body.status !== undefined;
  if (statusRequested) validateStatus(body.status);

  const explicitColumn = body.column !== undefined;
  let targetColumn = explicitColumn ? validateColumn(body.column) : current.column;
  let targetStatus = statusRequested ? body.status : current.status;

  if (statusRequested) {
    // "Done" always lands in the Done column; leaving Done reopens the card.
    if (targetStatus === "done") targetColumn = "done";
    else if (targetColumn === "done") targetColumn = "doing";
  } else if (explicitColumn) {
    targetStatus = statusForColumn(targetColumn, current.status);
  }

  const columnChanged = targetColumn !== current.column;
  if (columnChanged) {
    set("column_key", targetColumn);
    if (targetColumn === "done") {
      if (current.column !== "done") set("completed_at", nowIso());
    } else {
      set("completed_at", null);
    }
  }
  if (targetStatus !== current.status) set("status", targetStatus);

  let position = null;
  if (body.position !== undefined) {
    position = Number(body.position);
    assert(Number.isFinite(position), 400, "Position must be a number");
    set("position", position);
  } else if (columnChanged) {
    position = endPosition(db, tenantId, current.dashboardId, targetColumn);
    set("position", position);
  }

  assert(updates.length > 0, 400, "Nothing to update on this card");

  const timestamp = nowIso();
  const revision = withTx(db, () => {
    db.prepare(
      `UPDATE cards
       SET ${updates.join(", ")}, version = version + 1, updated_at = ?
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`
    ).run(...values, timestamp, cardId, tenantId);

    if (columnChanged) {
      normalizePositions(db, tenantId, current.dashboardId, current.column);
    }
    if (position !== null && touchedPositionsNeedNormalizing(db, tenantId, current.dashboardId, targetColumn)) {
      normalizePositions(db, tenantId, current.dashboardId, targetColumn);
    }
    if (targetStatus !== current.status || columnChanged) {
      insertTaskUpdate(db, tenantId, {
        cardId,
        taskNo: current.taskNo,
        actor,
        kind: "status",
        status: targetStatus,
        body: columnChanged ? `Moved to ${COLUMN_LABELS[targetColumn] || targetColumn}` : "",
      });
    }
    return bumpRevision(db, tenantId);
  });

  return { card: getCard(db, tenantId, cardId), revision };
}

export function softDeleteCard(db, tenantId, cardId) {
  const current = requireCard(db, tenantId, cardId);
  const timestamp = nowIso();
  const revision = withTx(db, () => {
    db.prepare(
      `UPDATE cards SET deleted_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND tenant_id = ?`
    ).run(timestamp, timestamp, cardId, tenantId);
    return bumpRevision(db, tenantId);
  });
  return { revision, card: { ...current, deletedAt: timestamp } };
}

export function restoreCard(db, tenantId, cardId) {
  const current = requireCard(db, tenantId, cardId, { includeDeleted: true });
  assert(Boolean(current.deletedAt), 400, "Card is not in the trash");
  const timestamp = nowIso();
  const revision = withTx(db, () => {
    db.prepare(
      `UPDATE cards SET deleted_at = NULL, updated_at = ?, version = version + 1
       WHERE id = ? AND tenant_id = ? AND deleted_at IS NOT NULL`
    ).run(timestamp, cardId, tenantId);
    if (touchedPositionsNeedNormalizing(db, tenantId, current.dashboardId, current.column)) {
      normalizePositions(db, tenantId, current.dashboardId, current.column);
    }
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, cardId), revision };
}

export function purgeCard(db, tenantId, cardId) {
  const current = requireCard(db, tenantId, cardId, { includeDeleted: true });
  assert(Boolean(current.deletedAt), 400, "Card must be deleted before purging");
  const revision = withTx(db, () => {
    db.prepare("DELETE FROM cards WHERE id = ? AND tenant_id = ?").run(cardId, tenantId);
    return bumpRevision(db, tenantId);
  });
  return { revision };
}

export function emptyTrash(db, tenantId) {
  const revision = withTx(db, () => {
    const result = db
      .prepare("DELETE FROM cards WHERE tenant_id = ? AND deleted_at IS NOT NULL")
      .run(tenantId);
    if (Number(result.changes) === 0) return getRevision(db, tenantId);
    return bumpRevision(db, tenantId);
  });
  return { revision };
}

function touchCard(db, tenantId, cardId) {
  db.prepare(
    "UPDATE cards SET version = version + 1, updated_at = ? WHERE id = ? AND tenant_id = ?"
  ).run(nowIso(), cardId, tenantId);
}

export function addChecklistItem(db, tenantId, cardId, body) {
  const card = requireCard(db, tenantId, cardId);
  const text = clampText(body.text, 500, { allowEmpty: false });
  assert(text, 400, "Checklist text is required");
  let position = Number(body.position);
  if (!Number.isFinite(position)) {
    const row = db
      .prepare(
        "SELECT MAX(position) AS max_position FROM checklist_items WHERE card_id = ? AND tenant_id = ?"
      )
      .get(cardId, tenantId);
    position = Number(row?.max_position ?? 0) + 1000;
  }
  const id = newId();
  const revision = withTx(db, () => {
    db.prepare(
      `INSERT INTO checklist_items (id, card_id, tenant_id, task_no, text, done, position, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(id, cardId, tenantId, allocateTaskNo(db, tenantId), text, position, nowIso());
    touchCard(db, tenantId, cardId);
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, card.id), revision, itemId: id };
}

function requireChecklistItem(db, tenantId, itemId) {
  const row = db
    .prepare(
      `SELECT ci.* FROM checklist_items ci
       JOIN cards c ON c.id = ci.card_id
       WHERE ci.id = ? AND ci.tenant_id = ? AND c.deleted_at IS NULL`
    )
    .get(itemId, tenantId);
  if (!row) throw new HttpError(404, "Checklist item not found");
  return row;
}

export function patchChecklistItem(db, tenantId, itemId, body, actor = null) {
  const item = requireChecklistItem(db, tenantId, itemId);
  const currentStatus = item.status || (item.done ? "done" : "not_started");
  const currentDone = Boolean(item.done);
  const updates = [];
  const values = [];
  if (body.text !== undefined) {
    const text = clampText(body.text, 500, { allowEmpty: false });
    assert(text, 400, "Checklist text is required");
    updates.push("text = ?");
    values.push(text);
  }

  let nextStatus = body.status !== undefined ? validateStatus(body.status) : currentStatus;
  let nextDone = currentDone;
  if (body.done !== undefined) {
    nextDone = Boolean(body.done);
    if (body.status === undefined) nextStatus = nextDone ? "done" : "not_started";
  } else if (body.status !== undefined) {
    nextDone = nextStatus === "done";
  }

  if (body.done !== undefined || nextDone !== currentDone) {
    updates.push("done = ?");
    values.push(nextDone ? 1 : 0);
  }
  if (nextStatus !== currentStatus) {
    updates.push("status = ?");
    values.push(nextStatus);
  }
  if (body.position !== undefined) {
    const position = Number(body.position);
    assert(Number.isFinite(position), 400, "Position must be a number");
    updates.push("position = ?");
    values.push(position);
  }
  assert(updates.length > 0, 400, "Nothing to update");
  const revision = withTx(db, () => {
    db.prepare(
      `UPDATE checklist_items SET ${updates.join(", ")} WHERE id = ? AND tenant_id = ?`
    ).run(...values, itemId, tenantId);
    touchCard(db, tenantId, item.card_id);
    if (nextStatus !== currentStatus || nextDone !== currentDone) {
      insertTaskUpdate(db, tenantId, {
        cardId: item.card_id,
        checklistItemId: item.id,
        taskNo: item.task_no,
        actor,
        kind: "status",
        status: nextStatus,
      });
    }
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, item.card_id), revision };
}

/** Append a written status update to a card's timeline. */
export function addCardUpdate(db, tenantId, cardId, body, actor = null) {
  const card = requireCard(db, tenantId, cardId);
  const text = clampText(body.body ?? body.text, 4000, { allowEmpty: false });
  assert(text, 400, "An update needs some text");
  const revision = withTx(db, () => {
    insertTaskUpdate(db, tenantId, {
      cardId,
      taskNo: card.taskNo,
      actor,
      kind: "note",
      body: text,
    });
    db.prepare("UPDATE cards SET updated_at = ? WHERE id = ? AND tenant_id = ?").run(
      nowIso(),
      cardId,
      tenantId
    );
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, cardId), revision };
}

/** Append a written status update to a checklist subtask's timeline. */
export function addChecklistUpdate(db, tenantId, itemId, body, actor = null) {
  const item = requireChecklistItem(db, tenantId, itemId);
  const text = clampText(body.body ?? body.text, 4000, { allowEmpty: false });
  assert(text, 400, "An update needs some text");
  const revision = withTx(db, () => {
    insertTaskUpdate(db, tenantId, {
      cardId: item.card_id,
      checklistItemId: item.id,
      taskNo: item.task_no,
      actor,
      kind: "note",
      body: text,
    });
    db.prepare("UPDATE cards SET updated_at = ? WHERE id = ? AND tenant_id = ?").run(
      nowIso(),
      item.card_id,
      tenantId
    );
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, item.card_id), revision };
}

export function deleteChecklistItem(db, tenantId, itemId) {
  const item = requireChecklistItem(db, tenantId, itemId);
  const revision = withTx(db, () => {
    db.prepare("DELETE FROM checklist_items WHERE id = ? AND tenant_id = ?").run(itemId, tenantId);
    touchCard(db, tenantId, item.card_id);
    return bumpRevision(db, tenantId);
  });
  return { card: getCard(db, tenantId, item.card_id), revision };
}

export function boardStats(db, tenantId, { dashboardId = null } = {}) {
  const board = loadBoard(db, tenantId, { dashboardId });
  const counts = { todo: 0, doing: 0, done: 0 };
  for (const card of board.cards) counts[card.column] += 1;
  return { revision: board.revision, counts, trashCount: board.trashCount };
}
