import { getRevision } from "../db.js";

export function mountEventRoutes(app, { db, hub }) {
  app.get("/api/events", (req, res) => {
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.setHeader("x-accel-buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const unsubscribe = hub.subscribe(req.tenant.id, res, {
      revision: getRevision(db, req.tenant.id),
      serverTime: new Date().toISOString(),
    });

    req.on("close", unsubscribe);
    req.on("error", unsubscribe);
  });
}
