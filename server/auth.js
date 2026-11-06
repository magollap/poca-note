import crypto from "node:crypto";
import {
  countOwners,
  createTenant,
  createUser,
  deleteUser,
  getTenantById,
  getTenantBySlug,
  getUserById,
  getUserByUsername,
  touchUserLogin,
  updateUser,
} from "./db.js";
import { HttpError, nowIso, parseCookies, sha256 } from "./util.js";

const SCRYPT_KEYLEN = 64;

export const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;
export const USER_ROLES = ["owner", "editor", "observer"];

export function isUserRole(value) {
  return USER_ROLES.includes(value);
}

/** Owners and editors can change workspace content; observers are read-only. */
export function canEditContent(role) {
  return role === "owner" || role === "editor";
}

export const RESERVED_SLUGS = new Set([
  "api",
  "app",
  "assets",
  "auth",
  "board",
  "health",
  "login",
  "new",
  "reports",
  "settings",
  "skills",
  "static",
  "trash",
  "users",
]);

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, salt, expectedHex] = stored.split("$");
  if (!salt || !expectedHex) return false;
  const actual = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function seedDemoTenant(db, config) {
  const count = db.prepare("SELECT COUNT(*) AS count FROM tenants").get();
  if (Number(count.count) > 0) return false;
  createTenant(db, {
    id: crypto.randomUUID(),
    slug: config.demo.slug,
    name: config.demo.name,
    passwordHash: hashPassword(config.demo.password),
    reportTime: config.reports.defaultTime,
    reportTimezone: config.reports.defaultTimezone,
  });
  return true;
}

export function createSession(db, tenantId, userId, days) {
  const token = crypto.randomBytes(32).toString("base64url");
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + days * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO sessions (token_hash, tenant_id, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sha256(token), tenantId, userId || null, createdAt.toISOString(), expiresAt.toISOString());
  return { token, expiresAt: expiresAt.toISOString() };
}

export function deleteSession(db, token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

function ownerForTenant(db, tenantId) {
  return db
    .prepare(
      `SELECT * FROM users
       WHERE tenant_id = ? AND role = 'owner'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(tenantId);
}

export function lookupSession(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash, s.expires_at, s.user_id,
              t.id AS tenant_id, t.slug, t.name,
              u.id AS uid, u.username, u.display_name, u.role
       FROM sessions s
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
    return null;
  }

  // Sessions created before per-user logins resolve to the workspace owner.
  let user = row.uid
    ? { id: row.uid, username: row.username, displayName: row.display_name, role: row.role }
    : ownerForTenant(db, row.tenant_id);
  if (user && user.display_name !== undefined) {
    user = {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    };
  }
  if (!user) return null;
  if (!row.user_id) {
    db.prepare("UPDATE sessions SET user_id = ? WHERE token_hash = ?").run(user.id, row.token_hash);
  }

  return {
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    tenant: { id: row.tenant_id, slug: row.slug, name: row.name },
    user: publicUser(user),
  };
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.displayName || user.username,
    role: user.role,
  };
}

export function loginPayload(tenant) {
  return { id: tenant.id, slug: tenant.slug, name: tenant.name };
}

/** Verify a workspace + username + password combination. */
export function authenticateUser(db, { tenant, username, password }) {
  const workspace = getTenantBySlug(db, String(tenant || "").trim());
  if (!workspace) return null;

  const loginName = String(username || "").trim();
  let user = loginName
    ? getUserByUsername(db, workspace.id, loginName)
    : ownerForTenant(db, workspace.id);

  // A workspace slug is also accepted as the owner's login name.
  if (!user && loginName.toLowerCase() === workspace.slug.toLowerCase()) {
    user = ownerForTenant(db, workspace.id);
  }
  if (!user || !verifyPassword(password, user.password_hash)) return null;

  touchUserLogin(db, user.id);
  return { tenant: workspace, user: publicUser(user) };
}

function normalizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 49);
}

/**
 * Self-service signup: create a workspace and its owner login in one step.
 * Throws HttpError with a user-facing message on invalid input.
 */
export function registerWorkspace(db, config, body = {}) {
  if (!config.registration.open) {
    throw new HttpError(403, "Sign-ups are closed on this server. Ask an administrator for an account.");
  }

  const slug = normalizeSlug(body.tenant ?? body.workspace ?? body.slug);
  const name = String(body.name || body.workspaceName || "").trim().slice(0, 120) || slug;
  const username = String(body.username || "").trim() || slug;
  const password = String(body.password || "");

  if (!WORKSPACE_SLUG_RE.test(slug)) {
    throw new HttpError(400, "Choose a workspace address of 2–49 letters, numbers, or hyphens.");
  }
  if (RESERVED_SLUGS.has(slug)) {
    throw new HttpError(400, `"${slug}" is reserved. Pick a different workspace address.`);
  }
  if (getTenantBySlug(db, slug)) {
    throw new HttpError(409, `The workspace "${slug}" already exists. Choose another address or sign in.`);
  }
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, "Usernames are 2–32 characters: letters, numbers, dots, dashes, underscores.");
  }
  if (password.length < 8) {
    throw new HttpError(400, "Use a password of at least 8 characters.");
  }
  if (password.length > 200) {
    throw new HttpError(400, "That password is too long.");
  }

  const tenantId = crypto.randomUUID();
  try {
    createTenant(db, {
      id: tenantId,
      slug,
      name,
      passwordHash: hashPassword(password),
      ownerUsername: username,
      reportTime: config.reports.defaultTime,
      reportTimezone: config.reports.defaultTimezone,
    });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message))) {
      throw new HttpError(409, `The workspace "${slug}" already exists. Choose another address or sign in.`);
    }
    throw error;
  }

  const tenant = getTenantById(db, tenantId);
  const user = getUserByUsername(db, tenantId, username);
  const session = createSession(db, tenantId, user.id, config.sessionDays);
  return {
    tenant: loginPayload(tenant),
    user: publicUser(user),
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** Owner-only helper used by the user-management routes. */
export function addWorkspaceMember(db, tenantId, { username, displayName, password, role = "editor" }) {
  const name = String(username || "").trim();
  if (!USERNAME_RE.test(name)) {
    throw new HttpError(400, "Usernames are 2–32 characters: letters, numbers, dots, dashes, underscores.");
  }
  if (String(password || "").length < 8) {
    throw new HttpError(400, "Use a password of at least 8 characters.");
  }
  if (!isUserRole(role)) {
    throw new HttpError(400, "Role must be owner, editor, or observer.");
  }
  if (getUserByUsername(db, tenantId, name)) {
    throw new HttpError(409, `"${name}" already has a login in this workspace.`);
  }
  try {
    return createUser(db, {
      id: crypto.randomUUID(),
      tenantId,
      username: name,
      displayName: String(displayName || "").trim().slice(0, 120) || name,
      passwordHash: hashPassword(password),
      role,
    });
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message))) {
      throw new HttpError(409, `"${name}" already has a login in this workspace.`);
    }
    throw error;
  }
}

export function updateWorkspaceMember(db, tenantId, userId, body = {}) {
  const user = getUserById(db, userId);
  if (!user || user.tenant_id !== tenantId) throw new HttpError(404, "That teammate was not found.");

  const nextRole = body.role === undefined ? undefined : String(body.role);
  if (nextRole !== undefined && !isUserRole(nextRole)) {
    throw new HttpError(400, "Role must be owner, editor, or observer.");
  }
  if (
    user.role === "owner" &&
    nextRole !== undefined &&
    nextRole !== "owner" &&
    countOwners(db, tenantId) <= 1
  ) {
    throw new HttpError(400, "A workspace needs at least one owner.");
  }
  const password = body.password === undefined ? undefined : String(body.password);
  if (password !== undefined && password.length < 8) {
    throw new HttpError(400, "Use a password of at least 8 characters.");
  }
  if (password !== undefined && password.length > 200) {
    throw new HttpError(400, "That password is too long.");
  }
  return publicUser(
    updateUser(db, tenantId, userId, {
      displayName:
        body.displayName === undefined ? undefined : String(body.displayName).trim().slice(0, 120),
      passwordHash: password === undefined ? undefined : hashPassword(password),
      role: nextRole,
    })
  );
}

export function removeWorkspaceMember(db, tenantId, userId, actorId) {
  const user = getUserById(db, userId);
  if (!user || user.tenant_id !== tenantId) throw new HttpError(404, "That teammate was not found.");
  if (user.id === actorId) throw new HttpError(400, "You cannot remove your own login.");
  if (user.role === "owner" && countOwners(db, tenantId) <= 1) {
    throw new HttpError(400, "A workspace needs at least one owner.");
  }
  deleteUser(db, tenantId, userId);
}

export function createRequireOwner() {
  return function requireOwner(req, res, next) {
    if (req.user?.role !== "owner") {
      return res.status(403).json({
        error: "forbidden",
        message: "Only a workspace owner can change this setting.",
      });
    }
    next();
  };
}

export function createRequireEditor() {
  return function requireEditor(req, res, next) {
    if (!canEditContent(req.user?.role)) {
      return res.status(403).json({
        error: "forbidden",
        message: "Observers have read-only access to this workspace.",
      });
    }
    next();
  };
}

export function requestToken(req, cookieName) {
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[cookieName] || null;
}

export function sessionCookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(config.cookieSecure),
    path: "/",
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(res, config, token) {
  res.cookie(config.cookieName || "poca_session", token, sessionCookieOptions(config));
}

export function clearSessionCookie(res, config) {
  res.clearCookie(config.cookieName || "poca_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: Boolean(config.cookieSecure),
    path: "/",
  });
}

export function createAuthMiddleware({ db, config }) {
  return function requireTenant(req, res, next) {
    const token = requestToken(req, config.cookieName);
    const session = lookupSession(db, token);
    if (!session) {
      return res.status(401).json({
        error: "unauthorized",
        message: "Sign in to access this workspace.",
      });
    }
    req.tenant = session.tenant;
    req.user = session.user;
    req.sessionToken = token;
    req.session = session;
    next();
  };
}

/**
 * Browser-facing guard for HTML routes. In dev Vite serves the SPA, so the
 * client also enforces this; in production this redirect happens server-side.
 */
export function createHtmlGate({ db, config }) {
  return function htmlGate(req, res, next) {
    const token = requestToken(req, config.cookieName);
    const session = lookupSession(db, token);
    if (req.path === "/login") {
      if (session) return res.redirect("/board");
      return next();
    }
    if (!session) {
      const next = encodeURIComponent(req.originalUrl || "/board");
      return res.redirect(`/login?next=${next}`);
    }
    next();
  };
}

export function tenantById(db, id) {
  const tenant = getTenantById(db, id);
  return tenant ? loginPayload(tenant) : null;
}

export function tenantBySlug(db, slug) {
  const tenant = getTenantBySlug(db, slug);
  return tenant ? loginPayload(tenant) : null;
}

export function ensureDemoSeed(db, config) {
  return seedDemoTenant(db, config);
}

export { nowIso };
