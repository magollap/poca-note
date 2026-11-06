import express from "express";
import {
  addCardUpdate,
  addChecklistItem,
  addChecklistUpdate,
  createCard,
  deleteChecklistItem,
  emptyTrash,
  getCard,
  getUpdateIntervalDays,
  loadBoard,
  loadTrash,
  patchCard,
  patchChecklistItem,
  purgeCard,
  restoreCard,
  setUpdateIntervalDays,
  softDeleteCard,
} from "../board.js";
import { getRevision } from "../db.js";
import {
  createDashboard,
  deleteDashboard,
  listDashboards,
  patchDashboard,
  resolveDashboardId,
} from "../dashboards.js";
import { HttpError, nowIso } from "../util.js";

export function mountBoardRoutes(app, { db, hub }) {
  const router = express.Router();

  const emit = (req, revision) => {
    hub.publish(req.tenant.id, {
      revision,
      at: nowIso(),
      clientId: req.headers["x-client-id"] || null,
    });
  };

  router.get("/board", (req, res) => {
    const dashboardId = resolveDashboardId(db, req.tenant.id, req.query.dashboardId || null);
    res.json({
      ...loadBoard(db, req.tenant.id, { dashboardId }),
      tenant: req.tenant,
    });
  });

  router.get("/dashboards", (req, res) => {
    res.json({ dashboards: listDashboards(db, req.tenant.id) });
  });

  router.post("/dashboards", (req, res) => {
    const result = createDashboard(db, req.tenant.id, req.body || {});
    emit(req, result.revision);
    res.status(201).json(result);
  });

  router.patch("/dashboards/:id", (req, res) => {
    const result = patchDashboard(db, req.tenant.id, req.params.id, req.body || {});
    emit(req, result.revision);
    res.json(result);
  });

  router.delete("/dashboards/:id", (req, res) => {
    const result = deleteDashboard(db, req.tenant.id, req.params.id);
    emit(req, result.revision);
    res.json(result);
  });

  router.get("/trash", (req, res) => {
    res.json(loadTrash(db, req.tenant.id));
  });

  router.post("/cards", (req, res) => {
    const result = createCard(db, req.tenant.id, req.body || {});
    emit(req, result.revision);
    res.status(201).json(result);
  });

  router.get("/cards/:id", (req, res) => {
    const card = getCard(db, req.tenant.id, req.params.id);
    if (!card) throw new HttpError(404, "Card not found");
    res.json({ card, revision: getRevision(db, req.tenant.id) });
  });

  router.patch("/cards/:id", (req, res) => {
    const result = patchCard(db, req.tenant.id, req.params.id, req.body || {}, req.user);
    emit(req, result.revision);
    res.json(result);
  });

  router.delete("/cards/:id", (req, res) => {
    const result = softDeleteCard(db, req.tenant.id, req.params.id);
    emit(req, result.revision);
    res.json(result);
  });

  router.post("/cards/:id/restore", (req, res) => {
    const result = restoreCard(db, req.tenant.id, req.params.id);
    emit(req, result.revision);
    res.json(result);
  });

  router.delete("/cards/:id/purge", (req, res) => {
    const result = purgeCard(db, req.tenant.id, req.params.id);
    emit(req, result.revision);
    res.json(result);
  });

  router.delete("/trash", (req, res) => {
    const result = emptyTrash(db, req.tenant.id);
    emit(req, result.revision);
    res.json(result);
  });

  router.post("/cards/:id/checklist", (req, res) => {
    const result = addChecklistItem(db, req.tenant.id, req.params.id, req.body || {});
    emit(req, result.revision);
    res.status(201).json({ card: result.card, revision: result.revision, itemId: result.itemId });
  });

  router.patch("/checklist/:id", (req, res) => {
    const result = patchChecklistItem(db, req.tenant.id, req.params.id, req.body || {}, req.user);
    emit(req, result.revision);
    res.json(result);
  });

  router.post("/cards/:id/updates", (req, res) => {
    const result = addCardUpdate(db, req.tenant.id, req.params.id, req.body || {}, req.user);
    emit(req, result.revision);
    res.status(201).json(result);
  });

  router.post("/checklist/:id/updates", (req, res) => {
    const result = addChecklistUpdate(db, req.tenant.id, req.params.id, req.body || {}, req.user);
    emit(req, result.revision);
    res.status(201).json(result);
  });

  router.get("/status-settings", (req, res) => {
    res.json({ intervalDays: getUpdateIntervalDays(db, req.tenant.id) });
  });

  router.patch("/status-settings", (req, res) => {
    const result = setUpdateIntervalDays(db, req.tenant.id, (req.body || {}).intervalDays);
    emit(req, result.revision);
    res.json(result);
  });

  router.delete("/checklist/:id", (req, res) => {
    const result = deleteChecklistItem(db, req.tenant.id, req.params.id);
    emit(req, result.revision);
    res.json(result);
  });

  app.use("/api", router);
}
