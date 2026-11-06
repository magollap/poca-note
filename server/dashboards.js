import {
  DASHBOARD_ACCENTS,
  bumpRevision,
  nowIso,
  withTx,
} from "./db.js";
import { HttpError, assert, clampText, newId } from "./util.js";

function serializeDashboard(row, counts = {}) {
  return {
    id: row.id,
    name: row.name,
    accent: row.accent || "emerald",
    position: Number(row.position),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    counts: {
      todo: Number(counts.todo || 0),
      doing: Number(counts.doing || 0),
      review: Number(counts.review || 0),
      done: Number(counts.done || 0),
      open:
        Number(counts.todo || 0) + Number(counts.doing || 0) + Number(counts.review || 0),
      total: Number(counts.total || 0),
    },
  };
}

export function listDashboards(db, tenantId) {
  const rows = db
    .prepare(
      `SELECT d.*,
         SUM(CASE WHEN c.deleted_at IS NULL AND c.column_key = 'todo' THEN 1 ELSE 0 END) AS todo,
         SUM(CASE WHEN c.deleted_at IS NULL AND c.column_key = 'doing' THEN 1 ELSE 0 END) AS doing,
         SUM(CASE WHEN c.deleted_at IS NULL AND c.column_key = 'review' THEN 1 ELSE 0 END) AS review,
         SUM(CASE WHEN c.deleted_at IS NULL AND c.column_key = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN c.deleted_at IS NULL THEN 1 ELSE 0 END) AS total
       FROM dashboards d
       LEFT JOIN cards c ON c.dashboard_id = d.id AND c.tenant_id = d.tenant_id
       WHERE d.tenant_id = ?
       GROUP BY d.id
       ORDER BY d.position, d.created_at`
    )
    .all(tenantId);
  return rows.map((row) => serializeDashboard(row, row));
}

export function ensureFirstDashboard(db, tenantId) {
  const row = db
    .prepare("SELECT * FROM dashboards WHERE tenant_id = ? ORDER BY position, created_at LIMIT 1")
    .get(tenantId);
  if (row) return row;
  const timestamp = nowIso();
  const id = newId();
  db.prepare(
    `INSERT INTO dashboards (id, tenant_id, name, accent, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, ?, ?)`
  ).run(id, tenantId, "My board", "emerald", timestamp, timestamp);
  return db.prepare("SELECT * FROM dashboards WHERE id = ?").get(id);
}

export function resolveDashboardId(db, tenantId, requested) {
  if (requested === undefined || requested === null || requested === "") {
    return ensureFirstDashboard(db, tenantId).id;
  }
  const row = db
    .prepare("SELECT id FROM dashboards WHERE id = ? AND tenant_id = ?")
    .get(String(requested), tenantId);
  if (!row) throw new HttpError(404, "Dashboard not found");
  return row.id;
}

export function getDashboard(db, tenantId, dashboardId) {
  const row = db
    .prepare("SELECT * FROM dashboards WHERE id = ? AND tenant_id = ?")
    .get(dashboardId, tenantId);
  if (!row) throw new HttpError(404, "Dashboard not found");
  return row;
}

function validateName(value) {
  const name = clampText(value, 60);
  assert(name, 400, "A dashboard name is required");
  return name;
}

function validateAccent(value) {
  const accent = clampText(value, 20) || "violet";
  assert(DASHBOARD_ACCENTS.includes(accent), 400, "Unknown dashboard accent colour");
  return accent;
}

export function createDashboard(db, tenantId, body = {}) {
  const name = validateName(body.name);
  const accent = validateAccent(body.accent);
  const positionRow = db
    .prepare("SELECT MAX(position) AS max_position FROM dashboards WHERE tenant_id = ?")
    .get(tenantId);
  const position = Number(positionRow?.max_position ?? 0) + 1000;
  const timestamp = nowIso();
  const id = newId();
  const revision = withTx(db, () => {
    db.prepare(
      `INSERT INTO dashboards (id, tenant_id, name, accent, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, tenantId, name, accent, position, timestamp, timestamp);
    return bumpRevision(db, tenantId);
  });
  const row = getDashboard(db, tenantId, id);
  return { dashboard: serializeDashboard(row), revision };
}

export function patchDashboard(db, tenantId, dashboardId, body = {}) {
  const current = getDashboard(db, tenantId, dashboardId);
  const updates = [];
  const values = [];
  if (body.name !== undefined) {
    updates.push("name = ?");
    values.push(validateName(body.name));
  }
  if (body.accent !== undefined) {
    updates.push("accent = ?");
    values.push(validateAccent(body.accent));
  }
  if (body.position !== undefined) {
    const position = Number(body.position);
    assert(Number.isFinite(position), 400, "Position must be a number");
    updates.push("position = ?");
    values.push(position);
  }
  assert(updates.length > 0, 400, "Nothing to update on this dashboard");

  const revision = withTx(db, () => {
    db.prepare(
      `UPDATE dashboards SET ${updates.join(", ")}, updated_at = ?
       WHERE id = ? AND tenant_id = ?`
    ).run(...values, nowIso(), current.id, tenantId);
    return bumpRevision(db, tenantId);
  });
  return { dashboard: serializeDashboard(getDashboard(db, tenantId, dashboardId)), revision };
}

/**
 * Deleting a board moves its cards (including trashed ones) to the oldest
 * remaining board rather than destroying work. The last board cannot be deleted.
 */
export function deleteDashboard(db, tenantId, dashboardId) {
  const current = getDashboard(db, tenantId, dashboardId);
  const total = db
    .prepare("SELECT COUNT(*) AS count FROM dashboards WHERE tenant_id = ?")
    .get(tenantId);
  assert(Number(total.count) > 1, 400, "A workspace needs at least one board");

  const fallback = db
    .prepare(
      `SELECT * FROM dashboards WHERE tenant_id = ? AND id <> ?
       ORDER BY position, created_at LIMIT 1`
    )
    .get(tenantId, current.id);
  assert(fallback, 400, "A workspace needs at least one board");

  const revision = withTx(db, () => {
    db.prepare("UPDATE cards SET dashboard_id = ? WHERE tenant_id = ? AND dashboard_id = ?").run(
      fallback.id,
      tenantId,
      current.id
    );
    db.prepare("DELETE FROM dashboards WHERE id = ? AND tenant_id = ?").run(current.id, tenantId);
    return bumpRevision(db, tenantId);
  });
  return { revision, movedTo: fallback.id };
}
