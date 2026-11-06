import { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  FileText,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import PerformanceCharts from "./PerformanceCharts";
import ReportsModal from "./ReportsModal";
import SchedulesEditor from "./SchedulesEditor";
import SettingsModal from "./SettingsModal";
import Sidebar from "./Sidebar";
import Toasts from "./Toasts";
import TopBar from "./TopBar";
import { api } from "../api";
import { formatRelative } from "../lib/format";
import { useDashboards } from "../hooks/useDashboards";
import { useToasts } from "../hooks/useToasts";
import { canEdit } from "../lib/roles";

const TILES = [
  {
    key: "daily",
    label: "Daily brief",
    icon: CalendarDays,
    accent: "green",
    empty: "Yesterday's carryover, overdue work, and today's queue.",
  },
  {
    key: "weekly",
    label: "Weekly report",
    icon: BarChart3,
    accent: "gold",
    empty: "What was completed and created in the last seven days.",
  },
  {
    key: "monthly",
    label: "Monthly report",
    icon: FileText,
    accent: "orange",
    empty: "The previous calendar month, delivered and carried forward.",
  },
  {
    key: "brief",
    label: "Snapshot",
    icon: Sparkles,
    accent: "emerald",
    empty: "A short, factual snapshot you can read in under a minute.",
  },
];

export default function ReportsPage({ tenant, navigate, onLogout, route }) {
  const toasts = useToasts();
  const editable = canEdit(tenant);
  const dashboardsApi = useDashboards(tenant);
  const [latest, setLatest] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modalKind, setModalKind] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  const query = new URLSearchParams(String(route || "").split("?")[1] || "");
  const requestedDashboardId = query.get("d");
  const activeDashboardId =
    dashboardsApi.dashboards.find((board) => board.id === requestedDashboardId)?.id ||
    dashboardsApi.dashboards[0]?.id ||
    null;

  const load = useCallback(async () => {
    try {
      const data = await api("/api/reports/latest");
      setLatest(data.latest || {});
      setSettings(data.settings || null);
    } catch (error) {
      toasts.error(error.message || "Could not load reports.");
    } finally {
      setLoading(false);
    }
  }, [toasts]);

  useEffect(() => {
    load();
  }, [load]);

  // A deleted board should not leave a stale ?d= in the address bar.
  useEffect(() => {
    if (!dashboardsApi.dashboards.length || !requestedDashboardId) return;
    const known = dashboardsApi.dashboards.some((board) => board.id === requestedDashboardId);
    if (!known) {
      navigate(`/reports?d=${dashboardsApi.dashboards[0].id}`, { replace: true });
    }
  }, [dashboardsApi.dashboards, requestedDashboardId, navigate]);

  return (
    <div className="app-shell">
      <Sidebar
        tenant={tenant}
        route={route}
        navigate={navigate}
        dashboards={dashboardsApi.dashboards}
        activeDashboardId={activeDashboardId}
        onSelectDashboard={(id) => navigate(`/reports?d=${id}`)}
        onCreateDashboard={dashboardsApi.create}
        onOpenSettings={() => setShowSettings(true)}
        canCreate={editable}
      />

      <div className="app-main">
        <TopBar
          tenant={tenant}
          onOpenSettings={() => setShowSettings(true)}
          onOpenReports={() => setModalKind("daily")}
        />

        <main className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">
                Reports <span className="page-kicker">performance</span>
              </h1>
              <p className="page-sub">
                Daily, weekly, and monthly throughput built from card history — plus saved editions of every
                report.
              </p>
            </div>
            <div className="page-head-actions">
              <button className="btn btn-sm" onClick={load}>
                <RefreshCw size={13} /> Refresh
              </button>
              {editable ? (
                <button className="btn btn-primary btn-sm" onClick={() => setModalKind("daily")}>
                  <Sparkles size={13} /> Generate report
                </button>
              ) : (
                <span className="badge badge-gold">Read-only · observer</span>
              )}
            </div>
          </div>

          <PerformanceCharts dashboardId={activeDashboardId} />

          <section className="panel">
            <div className="panel-head">
              <FileText size={15} className="muted" />
              <h2>Saved editions</h2>
              <span className="sub">
                {settings?.timezone ? `Workspace timezone ${settings.timezone}` : "Dashboard only"}
              </span>
            </div>
            <div className="panel-body">
              {loading ? (
                <div className="splash-inner" style={{ minHeight: 120 }}>
                  <Loader2 size={18} className="spin" /> Loading reports…
                </div>
              ) : (
                <div className="reports-strip reports-strip-page">
                  {TILES.map((tile) => {
                    const report = latest?.[tile.key] || null;
                    const Icon = tile.icon;
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        className={`report-tile ${tile.accent}`}
                        onClick={() => setModalKind(tile.key)}
                      >
                        <span className="report-tile-head">
                          <Icon size={13} />
                          {tile.label}
                          <span className="spacer" />
                          {report ? (
                            <span className="hint">{formatRelative(report.createdAt)}</span>
                          ) : (
                            <span className="badge badge-gold">not yet</span>
                          )}
                        </span>
                        <span className="report-tile-title">{report ? report.summary : tile.empty}</span>
                        <span className="report-tile-foot">
                          {report ? "Open edition" : editable ? "Generate now" : "Not generated yet"} →
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <CalendarDays size={15} style={{ color: "var(--amber)" }} />
              <h2>Schedules</h2>
              <span className="sub">Several schedules can run side by side</span>
            </div>
            <div className="panel-body">
              <SchedulesEditor
                toasts={toasts}
                readOnly={!editable}
                onChanged={() => {
                  load();
                }}
              />
            </div>
          </section>
        </main>
      </div>

      {modalKind ? (
        <ReportsModal
          initialKind={modalKind}
          onClose={() => setModalKind(null)}
          onGenerated={load}
          toasts={toasts}
          readOnly={!editable}
        />
      ) : null}

      {showSettings ? (
        <SettingsModal
          tenant={tenant}
          onClose={() => {
            setShowSettings(false);
            dashboardsApi.reload();
          }}
          onLogout={onLogout}
          toasts={toasts}
        />
      ) : null}

      <Toasts toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}
