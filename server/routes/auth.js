import {
  authenticateUser,
  clearSessionCookie,
  createSession,
  deleteSession,
  loginPayload,
  publicUser,
  registerWorkspace,
  requestToken,
  setSessionCookie,
} from "../auth.js";
import { asyncHandler } from "../util.js";

export function mountAuthRoutes(app, { db, config, loginLimiter, registerLimiter, requireTenant }) {
  app.get("/api/auth/config", (req, res) => {
    res.json({
      appName: "poca-note",
      demo:
        config.demo.showCredentials
          ? { slug: config.demo.slug, name: config.demo.name, password: config.demo.password }
          : null,
      registrationOpen: config.registration.open,
    });
  });

  app.post(
    "/api/auth/register",
    registerLimiter,
    asyncHandler(async (req, res) => {
      const result = registerWorkspace(db, config, req.body || {});
      setSessionCookie(res, config, result.token);
      res.status(201).json(result);
    })
  );

  app.post(
    "/api/auth/login",
    loginLimiter,
    asyncHandler(async (req, res) => {
      const slug = String(req.body?.tenant || req.body?.slug || "").trim();
      const password = String(req.body?.password || "");
      const username = String(req.body?.username || req.body?.user || "").trim();
      if (!slug || !password) {
        return res.status(400).json({ error: "bad_request", message: "Tenant and password are required." });
      }
      const authenticated = authenticateUser(db, { tenant: slug, username, password });
      if (!authenticated) {
        return res.status(401).json({ error: "invalid_credentials", message: "Tenant, username, or password is incorrect." });
      }
      const session = createSession(db, authenticated.tenant.id, authenticated.user.id, config.sessionDays);
      setSessionCookie(res, config, session.token);
      return res.json({
        tenant: loginPayload(authenticated.tenant),
        user: authenticated.user,
        token: session.token,
        expiresAt: session.expiresAt,
      });
    })
  );

  app.post("/api/auth/logout", (req, res) => {
    const token = requestToken(req, config.cookieName);
    deleteSession(db, token);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireTenant, (req, res) => {
    const user = req.user || null;
    res.json({ tenant: loginPayload(req.tenant), user: publicUser(user) });
  });
}
