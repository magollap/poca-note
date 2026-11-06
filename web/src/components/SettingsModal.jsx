import { useEffect, useState } from "react";
import {
  Activity,
  CalendarClock,
  KeyRound,
  LayoutGrid,
  Loader2,
  LogOut,
  Moon,
  Palette,
  Plus,
  ShieldCheck,
  Sun,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import Modal from "./Modal";
import SchedulesEditor from "./SchedulesEditor";
import { api } from "../api";
import { useDashboards } from "../hooks/useDashboards";
import { useTheme } from "../hooks/useTheme";
import { ASSIGNABLE_ROLES, ROLE_META, canEdit, roleMeta } from "../lib/roles";

const BOARD_ACCENTS = ["emerald", "amber", "orange", "green", "gold", "violet", "cyan", "rose", "sky"];

function BoardRow({ board, canDelete, onRename, onRecolor, onDelete, toasts, readOnly = false }) {
  const [name, setName] = useState(board.name);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(board.name);
  }, [board.name]);

  const commitName = async () => {
    const value = name.trim();
    if (!value || value === board.name) {
      setName(board.name);
      return;
    }
    setBusy(true);
    try {
      await onRename(board.id, value);
      toasts.success("Board renamed.");
    } catch (error) {
      setName(board.name);
      toasts.error(error.message || "Could not rename that board.");
    } finally {
      setBusy(false);
    }
  };

  const recolor = async (accent) => {
    setBusy(true);
    try {
      await onRecolor(board.id, accent);
    } catch (error) {
      toasts.error(error.message || "Could not recolor that board.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${board.name}”? Its cards move to your oldest board.`)) return;
    setBusy(true);
    try {
      await onDelete(board.id);
      toasts.success(`Board “${board.name}” deleted; its cards were kept.`);
    } catch (error) {
      toasts.error(error.message || "Could not delete that board.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="board-row">
      <span className={`dash-dot ${board.accent || "emerald"}`} />
      <input
        className="input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(board.name);
            event.currentTarget.blur();
          }
        }}
        maxLength={60}
        disabled={busy || readOnly}
        aria-label={`Rename board ${board.name}`}
      />
      <select
        className="select board-accent"
        value={board.accent || "emerald"}
        onChange={(event) => recolor(event.target.value)}
        disabled={busy || readOnly}
        aria-label={`Color for ${board.name}`}
      >
        {BOARD_ACCENTS.map((accent) => (
          <option key={accent} value={accent}>
            {accent}
          </option>
        ))}
      </select>
      <span className="badge">{board.counts.open} open</span>
      {readOnly ? null : (
        <button
          type="button"
          className="icon-btn"
          onClick={remove}
          disabled={!canDelete || busy}
          title={canDelete ? "Delete board" : "Keep at least one board"}
          aria-label={`Delete ${board.name}`}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

export default function SettingsModal({ tenant, onClose, onLogout, toasts }) {
  const role = roleMeta(tenant);
  const editable = canEdit(tenant);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [team, setTeam] = useState(null);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberForm, setMemberForm] = useState({ username: "", displayName: "", password: "", role: "editor" });
  const { theme, toggle } = useTheme();
  const boards = useDashboards(tenant);
  const [boardForm, setBoardForm] = useState({ name: "", accent: "emerald" });
  const [boardBusy, setBoardBusy] = useState(false);
  const [intervalDays, setIntervalDays] = useState(3);
  const [intervalBusy, setIntervalBusy] = useState(false);
  const [savedIntervalDays, setSavedIntervalDays] = useState(3);

  const loadTeam = async () => {
    try {
      const data = await api("/api/users");
      setTeam(data);
    } catch {
      setTeam(null);
    }
  };

  useEffect(() => {
    loadTeam();
    api("/api/status-settings")
      .then((data) => {
        const days = Number(data.intervalDays) || 3;
        setIntervalDays(days);
        setSavedIntervalDays(days);
      })
      .catch(() => {
        // keep the default until the workspace settings can be read
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveInterval = async () => {
    const days = Number(intervalDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      toasts.error("Use a whole number of days between 1 and 365.");
      return;
    }
    setIntervalBusy(true);
    try {
      const result = await api("/api/status-settings", {
        method: "PATCH",
        body: { intervalDays: days },
      });
      const saved = Number(result.intervalDays) || days;
      setIntervalDays(saved);
      setSavedIntervalDays(saved);
      toasts.success(`Status check-ins now use a ${saved} day window.`);
    } catch (error) {
      toasts.error(error.message || "Could not save that check-in window.");
    } finally {
      setIntervalBusy(false);
    }
  };

  const addMember = async (event) => {
    event.preventDefault();
    setMemberBusy(true);
    try {
      await api("/api/users", { method: "POST", body: memberForm });
      setMemberForm({ username: "", displayName: "", password: "", role: "editor" });
      await loadTeam();
      toasts.success("Teammate login created.");
    } catch (error) {
      toasts.error(error.message || "Could not add that teammate.");
    } finally {
      setMemberBusy(false);
    }
  };

  const changeRole = async (user, nextRole) => {
    if (nextRole === user.role) return;
    setMemberBusy(true);
    try {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { role: nextRole } });
      await loadTeam();
      toasts.success(`@${user.username} is now ${ROLE_META[nextRole]?.label || nextRole}.`);
    } catch (error) {
      toasts.error(error.message || "Could not change that role.");
      await loadTeam();
    } finally {
      setMemberBusy(false);
    }
  };

  const removeMember = async (user) => {
    if (!window.confirm(`Remove the login for @${user.username}?`)) return;
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      await loadTeam();
      toasts.success(`Removed @${user.username}.`);
    } catch (error) {
      toasts.error(error.message || "Could not remove that teammate.");
    }
  };

  const resetPassword = async (user) => {
    const password = window.prompt(`New password for @${user.username} (at least 8 characters):`);
    if (password === null) return;
    if (password.length < 8) {
      toasts.error("Use a password of at least 8 characters.");
      return;
    }
    try {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: { password } });
      toasts.success(`Password updated for @${user.username}.`);
    } catch (error) {
      toasts.error(error.message || "Could not update that password.");
    }
  };

  const addBoard = async (event) => {
    event.preventDefault();
    const name = boardForm.name.trim();
    if (!name) return;
    setBoardBusy(true);
    try {
      await boards.create(name, boardForm.accent);
      setBoardForm({ name: "", accent: "emerald" });
      toasts.success(`Board “${name}” created.`);
    } catch (error) {
      toasts.error(error.message || "Could not create that board.");
    } finally {
      setBoardBusy(false);
    }
  };

  return (
    <Modal
      title="Workspace settings"
      subtitle={`${tenant.name} · @${tenant.slug} · ${role.label}`}
      onClose={onClose}
      icon={<ShieldCheck size={16} className="muted" />}
      footer={
        <>
          {confirmLogout ? (
            <>
              <span className="hint" style={{ color: "var(--yellow)" }}>
                Sign out of this workspace?
              </span>
              <button className="btn btn-sm" onClick={() => setConfirmLogout(false)}>
                Cancel
              </button>
              <button className="btn btn-danger btn-sm" onClick={onLogout}>
                <LogOut size={13} /> Sign out
              </button>
            </>
          ) : (
            <button className="btn btn-sm" onClick={() => setConfirmLogout(true)}>
              <LogOut size={13} /> Sign out
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="modal-body">
        <>
            <div className="tenant-line">
              <span className="tenant-avatar" style={{ width: 32, height: 32, fontSize: 13 }}>
                {tenant.name.slice(0, 1).toUpperCase()}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{tenant.name}</div>
                <div className="hint mono">tenant: {tenant.slug}</div>
              </div>
              <span className="spacer" />
              <span className={`badge ${role.badge}`}>{role.label}</span>
            </div>
            <p className="hint" style={{ margin: "0 0 4px" }}>
              {role.summary}
            </p>

            <section className="settings-section">
              <h3>
                <Palette size={12} style={{ verticalAlign: -1 }} /> Appearance
              </h3>
              <label className="switch theme-switch settings-theme">
                <input type="checkbox" checked={theme === "light"} onChange={toggle} />
                <span className="theme-switch-face">
                  {theme === "light" ? <Sun size={13} /> : <Moon size={13} />}
                  <span>{theme === "light" ? "Light theme" : "Dark theme"}</span>
                </span>
              </label>
              <span className="hint">
                The choice is stored in this browser and applies to every board, report, and AI page.
              </span>
            </section>

            <section className="settings-section">
              <h3>
                <LayoutGrid size={12} style={{ verticalAlign: -1 }} /> Boards
              </h3>
              <div className="board-list">
                {boards.dashboards.map((board) => (
                  <BoardRow
                    key={board.id}
                    board={board}
                    canDelete={boards.dashboards.length > 1}
                    onRename={boards.rename}
                    onRecolor={boards.recolor}
                    onDelete={boards.remove}
                    toasts={toasts}
                    readOnly={!editable}
                  />
                ))}
                {boards.loading ? <span className="hint">Loading boards…</span> : null}
              </div>
              {editable ? (
                <form className="board-add" onSubmit={addBoard}>
                <input
                  className="input"
                  value={boardForm.name}
                  onChange={(event) =>
                    setBoardForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="New board name"
                  maxLength={60}
                  aria-label="New board name"
                />
                <select
                  className="select board-accent"
                  value={boardForm.accent}
                  onChange={(event) =>
                    setBoardForm((current) => ({ ...current, accent: event.target.value }))
                  }
                  aria-label="New board color"
                >
                  {BOARD_ACCENTS.map((accent) => (
                    <option key={accent} value={accent}>
                      {accent}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-sm"
                  type="submit"
                  disabled={boardBusy || !boardForm.name.trim()}
                >
                  {boardBusy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Add board
                </button>
                </form>
              ) : (
                <span className="hint">Observers can read board settings but cannot change them.</span>
              )}
              <span className="hint">
                Each board keeps its own cards. Deleting a board moves its cards, including trashed ones, to
                the oldest remaining board — the last board cannot be deleted.
              </span>
            </section>

            <section className="settings-section">
              <h3>
                <Activity size={12} style={{ verticalAlign: -1 }} /> Status check-ins
              </h3>
              <div className="status-setting-row">
                <label htmlFor="status-interval">Ask for an update after</label>
                <input
                  id="status-interval"
                  type="number"
                  min={1}
                  max={365}
                  className="input"
                  value={intervalDays}
                  onChange={(event) => setIntervalDays(event.target.value)}
                  disabled={!editable || intervalBusy}
                />
                <span className="hint">days</span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={saveInterval}
                  disabled={!editable || intervalBusy || Number(intervalDays) === savedIntervalDays}
                >
                  {intervalBusy ? <Loader2 size={12} className="spin" /> : null}
                  Save
                </button>
              </div>
              <span className="hint">
                Open cards and subtasks with no status update in this many days are flagged
                <b> Needs update</b> on the board and in the daily check-in reminder. One day means
                a daily habit; seven days suits longer projects.
              </span>
            </section>

            <section className="settings-section">
              <h3>
                <CalendarClock size={12} style={{ verticalAlign: -1 }} /> Report schedules
              </h3>
              <SchedulesEditor toasts={toasts} readOnly={!editable} />
              <span className="hint">
                Reports stay dashboard-only. Add as many schedules as you need and pause any of them
                without deleting the history.
              </span>
            </section>

            {team ? (
              <section className="settings-section">
                <h3>
                  <Users size={12} style={{ verticalAlign: -1 }} /> Teammates
                </h3>
                <div className="team-list">
                  {team.users.map((user) => (
                    <div
                      className={`team-row${user.id === team.currentUserId ? " is-you" : ""}`}
                      key={user.id}
                    >
                      <span className="tenant-avatar" style={{ width: 26, height: 26, fontSize: 11 }}>
                        {(user.displayName || user.username).slice(0, 1).toUpperCase()}
                      </span>
                      <span className="who">
                        <b>
                          {user.displayName}
                          {user.id === team.currentUserId ? " (you)" : ""}
                        </b>
                        <span>@{user.username}</span>
                      </span>
                      {team.canManage ? (
                        <select
                          className="select team-role"
                          value={user.role}
                          onChange={(event) => changeRole(user, event.target.value)}
                          disabled={memberBusy}
                          aria-label={`Role for @${user.username}`}
                          title="Change this teammate’s role"
                        >
                          {ASSIGNABLE_ROLES.map((value) => (
                            <option key={value} value={value}>
                              {ROLE_META[value]?.label || value}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`badge ${ROLE_META[user.role]?.badge || ""}`}>
                          {ROLE_META[user.role]?.label || user.role}
                        </span>
                      )}
                      {team.canManage ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Reset password for @${user.username}`}
                          aria-label={`Reset password for @${user.username}`}
                          onClick={() => resetPassword(user)}
                        >
                          <KeyRound size={13} />
                        </button>
                      ) : null}
                      {team.canManage && user.id !== team.currentUserId ? (
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Remove @${user.username}`}
                          aria-label={`Remove @${user.username}`}
                          onClick={() => removeMember(user)}
                        >
                          <Trash2 size={13} />
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {team.canManage ? (
                  <form className="team-add" onSubmit={addMember}>
                    <div className="field">
                      <label htmlFor="member-username">Username</label>
                      <input
                        id="member-username"
                        className="input"
                        value={memberForm.username}
                        onChange={(event) =>
                          setMemberForm((current) => ({ ...current, username: event.target.value }))
                        }
                        placeholder="sam"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="member-name">Display name</label>
                      <input
                        id="member-name"
                        className="input"
                        value={memberForm.displayName}
                        onChange={(event) =>
                          setMemberForm((current) => ({ ...current, displayName: event.target.value }))
                        }
                        placeholder="Sam Rivera"
                        autoComplete="off"
                      />
                    </div>
                    <div className="field full">
                      <label htmlFor="member-password">Temporary password</label>
                      <input
                        id="member-password"
                        className="input"
                        type="password"
                        value={memberForm.password}
                        onChange={(event) =>
                          setMemberForm((current) => ({ ...current, password: event.target.value }))
                        }
                        placeholder="At least 8 characters"
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    <div className="field full">
                      <label htmlFor="member-role">Role</label>
                      <select
                        id="member-role"
                        className="select"
                        value={memberForm.role}
                        onChange={(event) =>
                          setMemberForm((current) => ({ ...current, role: event.target.value }))
                        }
                      >
                        {ASSIGNABLE_ROLES.map((value) => (
                          <option key={value} value={value}>
                            {ROLE_META[value]?.label || value}
                          </option>
                        ))}
                      </select>
                      <span className="hint">
                        {ROLE_META[memberForm.role]?.summary || "Choose what this teammate can do."}
                      </span>
                    </div>
                    <div className="full" style={{ display: "flex", justifyContent: "flex-end" }}>
                      <button className="btn btn-primary btn-sm" type="submit" disabled={memberBusy}>
                        {memberBusy ? <Loader2 size={13} className="spin" /> : <UserPlus size={13} />}
                        {memberBusy ? "Adding…" : "Add teammate"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <span className="hint">Only a workspace owner can add teammates or change their roles.</span>
                )}
                <span className="hint">
                  Owners can change content and workspace settings. Editors can change boards, cards,
                  reports, and AI plans. Observers have read-only access. A workspace always keeps at least
                  one owner.
                </span>
              </section>
            ) : null}
        </>
      </div>
    </Modal>
  );
}
