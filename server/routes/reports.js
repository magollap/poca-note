import express from "express";
import {
  REPORT_KINDS,
  createReportSchedule,
  deleteReportSchedule,
  generateReport,
  getReportSettings,
  latestReports,
  listReportSchedules,
  listReports,
  performanceSeries,
  reportCounts,
  saveReportSettings,
  updateReportSchedule,
} from "../services/reports.js";
import { HttpError, asyncHandler } from "../util.js";
import { createRequireOwner } from "../auth.js";

export function mountReportRoutes(app, { db, config, reportLimiter }) {
  const router = express.Router();
  const requireOwner = createRequireOwner();

  const payload = (req, extra = {}) => ({
    reports: listReports(db, req.tenant.id, { kind: req.query.kind, limit: req.query.limit }),
    latest: latestReports(db, req.tenant.id),
    counts: reportCounts(db, req.tenant.id),
    settings: getReportSettings(db, req.tenant.id, config),
    schedules: listReportSchedules(db, req.tenant.id, config),
    kinds: REPORT_KINDS,
    ...extra,
  });

  router.get("/reports", (req, res) => {
    res.json(payload(req));
  });

  router.get("/reports/latest", (req, res) => {
    res.json({
      latest: latestReports(db, req.tenant.id),
      counts: reportCounts(db, req.tenant.id),
      settings: getReportSettings(db, req.tenant.id, config),
      schedules: listReportSchedules(db, req.tenant.id, config),
    });
  });

  router.get("/reports/performance", (req, res) => {
    const timezone = getReportSettings(db, req.tenant.id, config).timezone;
    res.json(
      performanceSeries(db, req.tenant.id, {
        range: String(req.query.range || "daily"),
        timezone,
        dashboardId: req.query.dashboardId ? String(req.query.dashboardId) : null,
      })
    );
  });

  router.get("/reports/settings", (req, res) => {
    res.json(getReportSettings(db, req.tenant.id, config));
  });

  router.put("/reports/settings", requireOwner, (req, res) => {
    res.json(saveReportSettings(db, req.tenant.id, req.body || {}, config));
  });

  router.get("/reports/schedules", (req, res) => {
    res.json({
      schedules: listReportSchedules(db, req.tenant.id, config),
      settings: getReportSettings(db, req.tenant.id, config),
    });
  });

  router.post("/reports/schedules", (req, res) => {
    const schedule = createReportSchedule(db, req.tenant.id, req.body || {}, config);
    res.status(201).json({ schedule, schedules: listReportSchedules(db, req.tenant.id, config) });
  });

  router.patch("/reports/schedules/:id", (req, res) => {
    const schedule = updateReportSchedule(db, req.tenant.id, req.params.id, req.body || {}, config);
    res.json({ schedule, schedules: listReportSchedules(db, req.tenant.id, config) });
  });

  router.delete("/reports/schedules/:id", (req, res) => {
    const result = deleteReportSchedule(db, req.tenant.id, req.params.id);
    res.json({ ...result, schedules: listReportSchedules(db, req.tenant.id, config) });
  });

  router.post(
    "/reports",
    reportLimiter,
    asyncHandler(async (req, res) => {
      const kind = String(req.body?.kind || "daily");
      if (!REPORT_KINDS.includes(kind)) {
        throw new HttpError(400, "Report kind must be daily, weekly, monthly, or brief.");
      }
      const result = await generateReport({
        db,
        config,
        tenant: req.tenant,
        kind,
        trigger: "manual",
        withNarrative: req.body?.narrative !== false,
      });
      res.status(201).json(result);
    })
  );

  app.use("/api", router);
}
