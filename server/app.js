import fs from "node:fs";
import path from "node:path";
import express from "express";
import { createAuthMiddleware, createHtmlGate, createRequireEditor } from "./auth.js";
import { createEventHub } from "./services/events.js";
import { mountAuthRoutes } from "./routes/auth.js";
import { mountBoardRoutes } from "./routes/board.js";
import { mountEventRoutes } from "./routes/events.js";
import { mountLinkRoutes } from "./routes/link.js";
import { mountAiRoutes } from "./routes/ai.js";
import { mountUserRoutes } from "./routes/users.js";
import { mountReportRoutes } from "./routes/reports.js";
import { createRateLimiter } from "./util.js";

function securityHeaders(config) {
  return function headers(req, res, next) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.isProduction) {
      res.setHeader(
        "content-security-policy",
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          "connect-src 'self'",
          "font-src 'self' data:",
          "base-uri 'self'",
          "form-action 'self'",
          "frame-ancestors 'none'",
        ].join("; ")
      );
    }
    next();
  };
}

function originGuard(config) {
  const allowed = new Set();
  if (config.appOrigin) allowed.add(config.appOrigin.replace(/\/$/, ""));
  if (!config.isProduction) {
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:5173");
    allowed.add("http://localhost:5174");
    allowed.add("http://127.0.0.1:5174");
  }
  return function guard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next();
    const self = `${req.protocol}://${req.get("host")}`;
    if (origin === self || allowed.has(origin.replace(/\/$/, ""))) return next();
    return res.status(403).json({
      error: "origin_not_allowed",
      message: "Cross-origin request blocked. Sign in from the app origin.",
    });
  };
}

function htmlPage(res, config, file) {
  if (!fs.existsSync(file)) {
    res
      .status(503)
      .type("text/plain")
      .send("poca-note web build was not found. Run `npm run build`, or use `npm run dev` for development.");
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.sendFile(file);
}

export function createApp({ db, config, hub = createEventHub() }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(securityHeaders(config));
  app.use(express.json({ limit: "256kb" }));
  app.use(originGuard(config));

  const requireTenant = createAuthMiddleware({ db, config });
  const loginLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    key: (req) => `${req.ip}:${String(req.body?.tenant || req.body?.slug || "")}`,
  });
  const registerLimiter = createRateLimiter({
    windowMs: 60 * 60_000,
    max: config.registration.maxPerHour,
    key: (req) => `register:${req.ip}`,
  });
  const linkLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 40,
    key: (req) => `link:${req.tenant?.id || req.ip}`,
  });
  const aiLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    key: (req) => `ai:${req.tenant?.id || req.ip}`,
  });
  const reportLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 12,
    key: (req) => `report:${req.tenant?.id || req.ip}`,
  });

  mountAuthRoutes(app, { db, config, loginLimiter, registerLimiter, requireTenant });

  app.use("/api", requireTenant);
  // Observers can read everything in their workspace but cannot change it.
  const requireEditor = createRequireEditor();
  app.use("/api", (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    return requireEditor(req, res, next);
  });

  mountUserRoutes(app, { db });
  mountBoardRoutes(app, { db, hub });
  mountLinkRoutes(app, { db, config, linkLimiter });
  mountAiRoutes(app, { db, config, hub, aiLimiter });
  mountReportRoutes(app, { db, config, reportLimiter });
  mountEventRoutes(app, { db, hub });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", tenant: req.tenant.slug, revision: null, serverTime: new Date().toISOString() });
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "not_found", message: "API route not found." });
  });

  const gate = createHtmlGate({ db, config });
  const indexFile = path.join(config.webDist, "index.html");
  app.use(express.static(config.webDist, { index: false, maxAge: config.isProduction ? "1h" : 0 }));
  app.get("/", (req, res) => htmlPage(res, config, indexFile));
  app.get("/board", gate, (req, res) => htmlPage(res, config, indexFile));
  app.get("/skills", gate, (req, res) => htmlPage(res, config, indexFile));
  app.get("/reports", gate, (req, res) => htmlPage(res, config, indexFile));
  app.get("/login", gate, (req, res) => htmlPage(res, config, indexFile));

  app.use((req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    const status = Number(error.status) || 500;
    if (status >= 500) {
      console.error("[server] request failed:", error);
    }
    const errorCodes = {
      400: "bad_request",
      401: "unauthorized",
      403: "forbidden",
      404: "not_found",
      409: "conflict",
      422: "invalid_target",
      429: "rate_limited",
    };
    const payload = {
      error: errorCodes[status] || error.code || (status >= 500 ? "server_error" : "bad_request"),
      message: error.message || "Something went wrong.",
    };
    if (error.details) Object.assign(payload, error.details);
    if (status >= 500 && config.isProduction) payload.message = "Something went wrong.";
    res.status(status).json(payload);
  });

  return app;
}
