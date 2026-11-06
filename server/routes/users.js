import express from "express";
import {
  addWorkspaceMember,
  createRequireOwner,
  publicUser,
  removeWorkspaceMember,
  updateWorkspaceMember,
} from "../auth.js";
import { listUsers } from "../db.js";
import { HttpError } from "../util.js";

function serializeUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.displayName || row.username,
    role: row.role,
    createdAt: row.created_at || row.createdAt || null,
    lastLoginAt: row.last_login_at || row.lastLoginAt || null,
  };
}

export function mountUserRoutes(app, { db }) {
  const router = express.Router();
  const requireOwner = createRequireOwner();

  router.get("/users", (req, res) => {
    res.json({
      users: listUsers(db, req.tenant.id).map(serializeUser),
      currentUserId: req.user?.id || null,
      canManage: req.user?.role === "owner",
    });
  });

  router.post("/users", requireOwner, (req, res) => {
    const user = addWorkspaceMember(db, req.tenant.id, req.body || {});
    res.status(201).json({ user: publicUser(user) });
  });

  router.patch("/users/:id", requireOwner, (req, res) => {
    const user = updateWorkspaceMember(db, req.tenant.id, req.params.id, req.body || {});
    res.json({ user });
  });

  router.delete("/users/:id", requireOwner, (req, res) => {
    if (!req.user) throw new HttpError(401, "Sign in to manage teammates.");
    removeWorkspaceMember(db, req.tenant.id, req.params.id, req.user.id);
    res.json({ ok: true });
  });

  app.use("/api", router);
}
