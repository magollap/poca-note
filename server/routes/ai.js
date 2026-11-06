import express from "express";
import {
  AI_FORMATS,
  AI_LENGTHS,
  AI_TONES,
  aiStatus,
  generateContent,
} from "../services/ai.js";
import {
  applyPlan,
  getActionRun,
  listActionRuns,
  planActions,
  saveActionRun,
  updateActionRun,
} from "../services/actions.js";
import { generateReport } from "../services/reports.js";
import { HttpError, asyncHandler, newId, nowIso } from "../util.js";

function serializeRun(row) {
  return {
    id: row.id,
    brief: row.brief,
    format: row.format,
    tone: row.tone,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function mountAiRoutes(app, { db, config, hub, aiLimiter }) {
  const router = express.Router();

  const emit = (req, revision) => {
    if (!hub || !revision) return;
    hub.publish(req.tenant.id, {
      revision,
      at: nowIso(),
      clientId: req.headers["x-client-id"] || null,
    });
  };

  router.get(
    "/ai/status",
    asyncHandler(async (req, res) => {
      const status = await aiStatus(config);
      // Provider and model names stay server-side: the UI only needs to know
      // whether generation is available.
      res.json({
        ready: status.effective !== "offline",
        mode: status.effective === "offline" ? "offline" : "online",
        formats: AI_FORMATS,
        tones: AI_TONES,
        lengths: AI_LENGTHS,
      });
    })
  );

  router.get("/ai/runs", (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 50);
    const runs = db
      .prepare(
        `SELECT * FROM ai_runs WHERE tenant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(req.tenant.id, limit)
      .map(serializeRun);
    res.json({ runs });
  });

  router.post(
    "/ai/generate",
    aiLimiter,
    asyncHandler(async (req, res) => {
      const brief = String(req.body?.brief || "").trim();
      if (brief.length < 10) {
        throw new HttpError(400, "Add a little more detail to the brief (at least 10 characters).");
      }
      if (brief.length > 8000) {
        throw new HttpError(400, "That brief is too long (8,000 characters max).");
      }
      const format = AI_FORMATS.includes(req.body?.format) ? req.body.format : "brief";
      const tone = AI_TONES.includes(req.body?.tone) ? req.body.tone : "practical";
      const length = AI_LENGTHS.includes(req.body?.length) ? req.body.length : "medium";

      const result = await generateContent({ config, brief, format, tone, length });
      const id = newId();
      const createdAt = nowIso();
      db.prepare(
        `INSERT INTO ai_runs
          (id, tenant_id, brief, format, tone, provider, model, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        req.tenant.id,
        brief,
        format,
        tone,
        result.provider,
        result.model || null,
        result.content,
        createdAt
      );
      res.json({
        run: {
          id,
          brief,
          format,
          tone,
          content: result.content,
          createdAt,
        },
        fallback: result.fallback,
      });
    })
  );

  // ----- board actions -----------------------------------------------------

  router.get("/ai/actions", (req, res) => {
    res.json({
      runs: listActionRuns(db, req.tenant.id, req.query.limit),
      history: listActionRuns(db, req.tenant.id, req.query.limit),
    });
  });

  router.get("/ai/actions/:id", (req, res) => {
    const run = getActionRun(db, req.tenant.id, req.params.id);
    if (!run) throw new HttpError(404, "That plan was not found.");
    res.json({ run });
  });

  router.post(
    "/ai/actions/plan",
    aiLimiter,
    asyncHandler(async (req, res) => {
      const plan = await planActions({
        db,
        config,
        tenantId: req.tenant.id,
        prompt: req.body?.prompt,
      });
      const runId = saveActionRun(db, {
        tenantId: req.tenant.id,
        userId: req.user?.id,
        prompt: plan.prompt,
        plan,
        status: "planned",
      });
      const { provider: _provider, model: _model, ...safePlan } = plan;
      res.json({
        runId,
        plan: safePlan,
        source: plan.source,
        warnings: plan.warnings || [],
      });
    })
  );

  router.post(
    "/ai/actions/apply",
    aiLimiter,
    asyncHandler(async (req, res) => {
      const runId = req.body?.runId || null;
      let plan = req.body?.plan || null;
      let run = null;

      if (runId) {
        run = getActionRun(db, req.tenant.id, runId);
        if (!run) throw new HttpError(404, "That plan was not found.");
        if (run.status === "applied") {
          throw new HttpError(409, "That plan was already applied.");
        }
        plan = run;
      }
      if (!plan || !Array.isArray(plan.actions) || plan.actions.length === 0) {
        throw new HttpError(400, "Provide a plan with at least one action, or a saved runId.");
      }

      const result = applyPlan({ db, tenantId: req.tenant.id, plan });
      emit(req, result.revision);

      const status = result.applied > 0 ? "applied" : "failed";
      const error = result.failed
        ? result.results
            .filter((entry) => !entry.ok)
            .map((entry) => entry.message)
            .join(" ")
            .slice(0, 2000)
        : null;

      let savedId = runId;
      if (runId) {
        updateActionRun(db, req.tenant.id, runId, { status, result, error });
      } else {
        savedId = saveActionRun(db, {
          tenantId: req.tenant.id,
          userId: req.user?.id,
          prompt: plan.prompt || plan.summary || "Board action plan",
          plan,
          status,
          result,
          error,
        });
      }

      res.json({ ...result, runId: savedId, status });
    })
  );

  // ----- daily brief -------------------------------------------------------

  router.post(
    "/ai/brief",
    aiLimiter,
    asyncHandler(async (req, res) => {
      const result = await generateReport({
        db,
        config,
        tenant: req.tenant,
        kind: "brief",
        trigger: "manual",
        withNarrative: req.body?.narrative !== false,
      });
      res.status(201).json(result);
    })
  );

  app.use("/api", router);
}
