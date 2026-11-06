import { useState } from "react";
import {
  BarChart3,
  Check,
  LayoutGrid,
  ListTodo,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import { roleMeta } from "../lib/roles";

const ACCENTS = ["emerald", "amber", "orange", "green", "gold", "violet", "cyan", "rose", "sky"];

const NAV = [
  { key: "tasks", label: "Tasks", path: "/board", icon: ListTodo },
  { key: "reports", label: "Reports", path: "/reports", icon: BarChart3 },
  { key: "skills", label: "AI Skills", path: "/skills", icon: Sparkles },
];

export default function Sidebar({
  tenant,
  route,
  navigate,
  dashboards = [],
  activeDashboardId,
  onSelectDashboard,
  onCreateDashboard,
  onOpenSettings,
  onOpenTrash,
  trashCount = 0,
  canCreate = true,
}) {
  const { theme, toggle } = useTheme();
  const role = roleMeta(tenant);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const path = String(route || "").split("?")[0];
  const active = dashboards.find((dashboard) => dashboard.id === activeDashboardId) || dashboards[0];
  const dashboardQuery = active?.id ? `?d=${active.id}` : "";
  // Tasks and Reports both stay on the selected dashboard instead of jumping to the first one.
  const target = (itemPath) =>
    itemPath === "/board" || itemPath === "/reports" ? `${itemPath}${dashboardQuery}` : itemPath;

  const submit = async (event) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      const accent = ACCENTS[dashboards.length % ACCENTS.length];
      const created = await onCreateDashboard?.(value, accent);
      setName("");
      setAdding(false);
      if (created?.id) onSelectDashboard?.(created.id);
    } catch (err) {
      setError(err.message || "Could not create that board.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-head">
        <a
          className="brand"
          href="/board"
          onClick={(event) => {
            event.preventDefault();
            navigate(target("/board"));
          }}
          aria-label="poca-note board"
        >
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={17} strokeWidth={2.2} />
          </span>
          <span>
            poca<em>·</em>note
          </span>
        </a>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Dashboards</span>
            {canCreate ? (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setAdding((value) => !value)}
                title="New dashboard"
                aria-label="New dashboard"
              >
                <Plus size={13} />
              </button>
            ) : null}
          </div>

          <nav className="sidebar-list" aria-label="Dashboards">
            {dashboards.map((dashboard) => {
              const isActive = active?.id === dashboard.id;
              return (
                <button
                  key={dashboard.id}
                  type="button"
                  className={`sidebar-item ${isActive ? "active" : ""}`}
                  onClick={() => onSelectDashboard?.(dashboard.id)}
                  title={`${dashboard.name} · ${dashboard.counts.open} open`}
                >
                  <span className={`dash-dot ${dashboard.accent || "emerald"}`} />
                  <span className="sidebar-item-label">{dashboard.name}</span>
                  <span className="sidebar-count">{dashboard.counts.open}</span>
                </button>
              );
            })}
            {dashboards.length === 0 ? <span className="hint">Loading boards…</span> : null}
          </nav>

          {adding && canCreate ? (
            <form className="sidebar-add" onSubmit={submit}>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Board name"
                aria-label="New dashboard name"
                maxLength={60}
                autoFocus
              />
              <div className="sidebar-add-actions">
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setError("");
                  }}
                  aria-label="Cancel"
                >
                  <X size={13} />
                </button>
                <button className="icon-btn" type="submit" disabled={busy || !name.trim()} aria-label="Create board">
                  <Check size={13} />
                </button>
              </div>
              {error ? <span className="hint" style={{ color: "var(--red)" }}>{error}</span> : null}
            </form>
          ) : null}
        </div>

        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Workspace</span>
          </div>
          <nav className="sidebar-list" aria-label="Workspace">
            {NAV.map((item) => {
              const Icon = item.icon;
              const isActive =
                item.path === "/board"
                  ? path === "/board"
                  : path === item.path;
              return (
                <a
                  key={item.key}
                  href={target(item.path)}
                  className={`sidebar-item ${isActive ? "active" : ""}`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(target(item.path));
                  }}
                >
                  <Icon size={15} />
                  <span className="sidebar-item-label">{item.label}</span>
                </a>
              );
            })}
            {onOpenTrash ? (
              <button type="button" className="sidebar-item" onClick={onOpenTrash}>
                <Trash2 size={15} />
                <span className="sidebar-item-label">Trash</span>
                {trashCount > 0 ? <span className="sidebar-count">{trashCount}</span> : null}
              </button>
            ) : null}
            <button type="button" className="sidebar-item" onClick={onOpenSettings}>
              <Settings size={15} />
              <span className="sidebar-item-label">Settings</span>
            </button>
          </nav>
        </div>
      </div>

      <div className="sidebar-foot">
        <label className="switch theme-switch" title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
          <input type="checkbox" checked={theme === "light"} onChange={toggle} />
          <span className="theme-switch-face">
            {theme === "dark" ? <Moon size={12} /> : <Sun size={12} />}
            <span>{theme === "dark" ? "Dark" : "Light"}</span>
          </span>
        </label>
        <button type="button" className="sidebar-user" onClick={onOpenSettings} title="Workspace settings">
          <span className="tenant-avatar">{tenant.name.slice(0, 1).toUpperCase()}</span>
          <span className="who">
            <b>{tenant.name}</b>
            <span>
              @{tenant.slug} · {role.label}
            </span>
          </span>
        </button>
      </div>
    </aside>
  );
}
