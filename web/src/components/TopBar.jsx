import {
  BarChart3,
  CircleHelp,
  Search,
  Settings,
  Trash2,
} from "lucide-react";

function SyncState({ sync }) {
  if (!sync) return null;
  const label = sync.offline ? "Offline" : sync.syncing ? "Syncing" : sync.cached ? "Cached" : "Live";
  const dot = sync.offline ? "offline" : sync.cached ? "cached" : "";
  return (
    <span className="sync-state" title={sync.lastSync ? `Last sync ${new Date(sync.lastSync).toLocaleTimeString()}` : ""}>
      <span className={`sync-dot ${dot}`} />
      <span className="label">{label}</span>
    </span>
  );
}

export default function TopBar({
  tenant,
  search,
  sync,
  onOpenSettings,
  onOpenTrash,
  onOpenReports,
  onOpenHelp,
  trashCount = 0,
  children,
}) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {search ? (
          <div className="topbar-search">
            <Search size={14} />
            <input
              ref={search.inputRef}
              className="input"
              placeholder="Filter cards…"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  search.onChange("");
                  event.currentTarget.blur();
                }
              }}
              aria-label="Filter cards"
            />
            <span className="kbd">/</span>
          </div>
        ) : null}

        <span className="spacer" />
        <SyncState sync={sync} />
        {children}
        {onOpenReports ? (
          <button className="icon-btn" onClick={onOpenReports} title="Reports and daily brief (B)" aria-label="Reports">
            <BarChart3 size={16} />
          </button>
        ) : null}
        {onOpenTrash ? (
          <button
            className="icon-btn"
            onClick={onOpenTrash}
            title="Trash"
            aria-label={`Trash (${trashCount})`}
            style={{ position: "relative" }}
          >
            <Trash2 size={16} />
            {trashCount > 0 ? (
              <span
                className="badge"
                style={{
                  position: "absolute",
                  top: -3,
                  right: -3,
                  padding: "0 5px",
                  minWidth: 16,
                  height: 16,
                  justifyContent: "center",
                  fontSize: 9.5,
                  borderColor: "var(--accent)",
                  color: "var(--accent)",
                  background: "var(--panel)",
                }}
              >
                {trashCount}
              </span>
            ) : null}
          </button>
        ) : null}
        {onOpenHelp ? (
          <button className="icon-btn" onClick={onOpenHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <CircleHelp size={16} />
          </button>
        ) : null}
        {onOpenSettings ? (
          <button className="icon-btn" onClick={onOpenSettings} title="Workspace settings" aria-label="Workspace settings">
            <Settings size={16} />
          </button>
        ) : null}
        <button
          className="tenant-btn"
          onClick={onOpenSettings}
          title={`${tenant.name} — workspace settings`}
          type="button"
        >
          <span className="tenant-avatar">{tenant.name.slice(0, 1).toUpperCase()}</span>
          <span className="name">{tenant.name}</span>
        </button>
      </div>
    </header>
  );
}
