import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  CheckCircle2,
  Clock,
  FileText,
  History,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Markdown from "./Markdown";
import Modal from "./Modal";
import SchedulesEditor from "./SchedulesEditor";
import { api } from "../api";
import { formatDateTime, formatRelative, truncate } from "../lib/format";

const TABS = [
  { key: "daily", label: "Daily", icon: CalendarDays },
  { key: "weekly", label: "Weekly", icon: BarChart3 },
  { key: "monthly", label: "Monthly", icon: FileText },
  { key: "brief", label: "Brief", icon: Sparkles },
];

const EMPTY_COPY = {
  daily: "No daily report yet. Generate one to see yesterday's carryover, overdue work, and today's queue.",
  weekly: "No weekly report yet. Generate one to review the last seven days.",
  monthly: "No monthly report yet. Generate one to review the previous calendar month.",
  brief: "No brief yet. Generate one for a short, factual snapshot you can read in under a minute.",
};

/**
 * The modal header already shows the report title and summary, so drop the
 * duplicated H1 and stat line before rendering the body.
 */
function displayContent(content) {
  return String(content || "")
    .replace(/^# .*\n+/, "")
    .replace(/^\*\*.*\*\*\n+/, "")
    .trimStart();
}

export default function ReportsModal({ onClose, initialKind = "daily", toasts, onGenerated, readOnly = false }) {
  const [kind, setKind] = useState(TABS.some((tab) => tab.key === initialKind) ? initialKind : "daily");
  const [reports, setReports] = useState([]);
  const [latest, setLatest] = useState({});
  const [settings, setSettings] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [view, setView] = useState("report");

  const load = useCallback(async () => {
    const data = await api("/api/reports?limit=60");
    setReports(data.reports || []);
    setLatest(data.latest || {});
    setSettings(data.settings || null);
    return data;
  }, []);

  useEffect(() => {
    let active = true;
    api("/api/reports?limit=60")
      .then((data) => {
        if (!active) return;
        setReports(data.reports || []);
        setLatest(data.latest || {});
        setSettings(data.settings || null);
      })
      .catch((error) => toasts.error(error.message || "Could not load reports."))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => reports.filter((report) => report.kind === kind), [reports, kind]);
  const selected = visible.find((report) => report.id === selectedId) || visible[0] || latest[kind] || null;

  const generate = async () => {
    if (readOnly) return;
    setGenerating(true);
    try {
      const result = await api("/api/reports", { method: "POST", body: { kind } });
      setSelectedId(result.report?.id || null);
      await load();
      toasts.success(`${result.report?.title || "Report"} generated.`);
      onGenerated?.();
    } catch (error) {
      toasts.error(error.message || "Could not generate the report.");
    } finally {
      setGenerating(false);
    }
  };

  const active = TABS.find((tab) => tab.key === kind) || TABS[0];
  const ActiveIcon = active.icon;

  return (
    <Modal
      title="Reports"
      subtitle="Scheduled summaries of this workspace — facts come from the board, never invented."
      icon={<BarChart3 size={16} style={{ color: "var(--accent)" }} />}
      size="wide reports-modal"
      onClose={onClose}
      footer={
        <>
          <span className="hint">
            {readOnly
              ? "Read-only: observers can browse every saved edition."
              : `Automation follows the workspace schedules (${settings?.timezone || "UTC"}); you can always generate on demand.`}
          </span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
          {!readOnly && view === "report" ? (
            <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating || loading}>
              {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {generating ? "Generating…" : `Generate ${kind}`}
            </button>
          ) : null}
        </>
      }
    >
      <div className="modal-body">
        <div className="nav-tabs" role="tablist" aria-label="Report kind">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={view === "report" && kind === tab.key}
                className={`nav-tab ${view === "report" && kind === tab.key ? "active" : ""}`}
                onClick={() => {
                  setKind(tab.key);
                  setView("report");
                  setSelectedId(null);
                }}
                type="button"
              >
                <Icon size={13} /> {tab.label}
              </button>
            );
          })}
          <button
            role="tab"
            aria-selected={view === "schedule"}
            className={`nav-tab ${view === "schedule" ? "active" : ""}`}
            onClick={() => setView("schedule")}
            type="button"
          >
            <Clock size={13} /> Schedules
          </button>
        </div>

        {view === "report" ? (
        <div className="reports-grid">
          <section className="reports-main">
            {loading ? (
              <div className="splash-inner" style={{ minHeight: 220 }}>
                <Loader2 size={20} className="spin" /> Loading reports…
              </div>
            ) : selected ? (
              <>
                <div className="reports-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="reports-title">
                      <ActiveIcon size={14} style={{ color: "var(--accent)" }} />
                      <span>{selected.title}</span>
                    </div>
                    <p className="hint" style={{ margin: 0 }}>
                      {selected.summary}
                    </p>
                  </div>
                  <div className="reports-head-meta">
                    <span className={`badge ${selected.trigger === "scheduled" ? "badge-green" : ""}`}>
                      {selected.trigger === "scheduled" ? "scheduled" : "manual"}
                    </span>
                    <span className="hint" title={formatDateTime(selected.createdAt)}>
                      {formatRelative(selected.createdAt)}
                    </span>
                  </div>
                </div>
                <div className="reports-doc">
                  <Markdown content={displayContent(selected.content)} />
                </div>
              </>
            ) : (
              <div className="output-empty" style={{ minHeight: 220 }}>
                <ActiveIcon size={22} style={{ opacity: 0.4 }} />
                <span>{EMPTY_COPY[kind]}</span>
                <span className="hint" style={{ maxWidth: 340 }}>
                  Reports are saved here, so the dashboard always shows the latest edition.
                </span>
              </div>
            )}
          </section>

          <aside className="reports-side">
            <div className="reports-side-head">
              <History size={13} className="muted" />
              <span className="field-label" style={{ margin: 0 }}>
                Earlier {active.label.toLowerCase()} editions
              </span>
              <button className="icon-btn" onClick={load} title="Refresh" aria-label="Refresh reports" type="button">
                <RefreshCw size={12} />
              </button>
            </div>
            {visible.length === 0 ? (
              <p className="hint">Nothing generated yet.</p>
            ) : (
              <div className="list">
                {visible.map((report) => (
                  <button
                    key={report.id}
                    type="button"
                    className={`reports-entry ${selected?.id === report.id ? "active" : ""}`}
                    onClick={() => setSelectedId(report.id)}
                  >
                    <div className="title">{truncate(report.title, 44)}</div>
                    <div className="meta">
                      {formatRelative(report.createdAt)} · {report.summary}
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="reports-note">
              <CheckCircle2 size={12} style={{ color: "var(--green)" }} />
              <span>Card lists and numbers come straight from the board.</span>
            </div>
          </aside>
        </div>
        ) : null}

        {view === "schedule" ? (
          <section className="reports-schedule">
            <div className="reports-side-head">
              <Clock size={13} className="muted" />
              <span className="field-label" style={{ margin: 0 }}>
                Schedules
              </span>
              <span className="hint" style={{ marginLeft: "auto" }}>
                {settings?.timezone || "UTC"}
              </span>
            </div>
            <SchedulesEditor
              toasts={toasts}
              readOnly={readOnly}
              onChanged={async () => {
                await load();
                onGenerated?.();
              }}
            />
          </section>
        ) : null}

        <p className="hint" style={{ margin: 0 }}>
          Reports stay inside this workspace and appear on the board dashboard as soon as they are generated.
        </p>
      </div>
    </Modal>
  );
}
