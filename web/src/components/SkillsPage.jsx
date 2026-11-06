import { useCallback, useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bot,
  CheckCircle2,
  Clipboard,
  Cpu,
  FileText,
  Loader2,
  ListChecks,
  Sparkles,
  Wand2,
} from "lucide-react";
import Markdown from "./Markdown";
import ReportsModal from "./ReportsModal";
import SettingsModal from "./SettingsModal";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import Toasts from "./Toasts";
import { api } from "../api";
import { formatRelative, truncate } from "../lib/format";
import { canEdit } from "../lib/roles";
import { useDashboards } from "../hooks/useDashboards";
import { useToasts } from "../hooks/useToasts";

const SAMPLE = `We need a calm, practical launch plan for poca-note's new AI board actions. The audience is a 6-person product studio that lives in the task board. Key points: run actions by task number, review every plan before applying it, and keep the tone direct. Deliverable due Friday.`;

const FORMAT_LABEL = {
  brief: "Structured brief",
  summary: "Executive summary",
  email: "Email",
  social: "Social post",
  notes: "Meeting notes",
  plan: "Action plan",
};

const LENGTH_LABEL = { short: "Short", medium: "Medium", long: "Long" };

export default function SkillsPage({ tenant, navigate, onLogout, route = "/skills" }) {
  const toasts = useToasts();
  const editable = canEdit(tenant);
  const dashboardsApi = useDashboards(tenant);
  const requestedDashboardId = new URLSearchParams(String(route || "").split("?")[1] || "").get("d");
  const activeDashboardId =
    dashboardsApi.dashboards.find((dashboard) => dashboard.id === requestedDashboardId)?.id ||
    dashboardsApi.dashboards[0]?.id ||
    null;
  const [status, setStatus] = useState(null);
  const [brief, setBrief] = useState("");
  const [format, setFormat] = useState("brief");
  const [tone, setTone] = useState("practical");
  const [length, setLength] = useState("medium");
  const [run, setRun] = useState(null);
  const [runs, setRuns] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [reportsKind, setReportsKind] = useState("brief");

  const generatingRef = useRef(false);
  generatingRef.current = generating;

  const loadContentRuns = useCallback(async () => {
    try {
      const data = await api("/api/ai/runs?limit=12");
      setRuns(data.runs || []);
    } catch {
      // history is secondary
    }
  }, []);

  useEffect(() => {
    api("/api/ai/status").then(setStatus).catch(() => {});
    loadContentRuns();
  }, [loadContentRuns]);

  const generate = useCallback(async () => {
    if (!editable || generatingRef.current) return;
    const text = brief.trim();
    if (text.length < 10) {
      toasts.error("Add a little more detail to the brief (at least 10 characters).");
      return;
    }
    setGenerating(true);
    try {
      const data = await api("/api/ai/generate", {
        method: "POST",
        body: { brief: text, format, tone, length },
      });
      setRun(data.run);
      setRuns((current) => [data.run, ...current.filter((item) => item.id !== data.run.id)].slice(0, 12));
      if (data.fallback) {
        toasts.info("Generated with the offline preview — everything stays inside this workspace.");
      } else {
        toasts.success("Content generated and saved to this workspace.");
      }
    } catch (error) {
      toasts.error(error.message || "Generation failed.");
    } finally {
      setGenerating(false);
    }
  }, [brief, format, tone, length, editable, toasts]);

  const openReports = useCallback((kind = "brief") => {
    setReportsKind(kind);
    setShowReports(true);
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        generate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generate]);

  const copy = async () => {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.content);
      toasts.success("Output copied.");
    } catch {
      toasts.error("Clipboard access was blocked.");
    }
  };

  const effective = status?.ready ? "ready" : "offline";

  return (
    <div className="app-shell">
      <Sidebar
        tenant={tenant}
        route={route}
        navigate={navigate}
        dashboards={dashboardsApi.dashboards}
        activeDashboardId={activeDashboardId}
        onSelectDashboard={(id) => navigate(`/board?d=${id}`)}
        onCreateDashboard={dashboardsApi.create}
        onOpenSettings={() => setShowSettings(true)}
        canCreate={editable}
      />

      <div className="app-main">
        <TopBar
          tenant={tenant}
          onOpenSettings={() => setShowSettings(true)}
          onOpenReports={() => openReports("daily")}
        >
          <span className="ai-badge" title={effective === "offline" ? "Offline preview mode" : "AI is ready"}>
            <span className={`ai-dot ${effective === "offline" ? "offline" : ""}`} />
            {effective === "offline" ? "Offline preview" : "AI ready"}
          </span>
        </TopBar>

        <main className="page">
          <div className="page-head">
            <div>
              <h1 className="page-title">
                AI Skills
                <span className="page-kicker dash-tone emerald">content studio</span>
              </h1>
              <p className="page-sub">
                Turn a rough brief into formatted, useful content. Runs are saved to this workspace.
              </p>
            </div>
            <div className="page-head-actions">
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => navigate(`/board${activeDashboardId ? `?d=${activeDashboardId}` : ""}`)}
              >
                <ListChecks size={13} /> Board AI actions
              </button>
              <button className="btn btn-sm" type="button" onClick={() => openReports("brief")}>
                <BarChart3 size={13} /> Daily brief
              </button>
              <span className="hint" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Cpu size={13} />
                {effective === "offline" ? "Offline preview" : "AI ready"}
              </span>
              {editable ? null : <span className="badge badge-gold">Read-only · observer</span>}
            </div>
          </div>

          <div className="skills-grid">
            <section className="panel">
              <div className="panel-head">
                <Wand2 size={15} style={{ color: "var(--accent)" }} />
                <h2>Brief</h2>
                <span className="sub">⌘↵ to generate</span>
              </div>
              <div className="panel-body">
                <div className="field">
                  <label htmlFor="brief">What do you need?</label>
                  <textarea
                    id="brief"
                    className="textarea"
                    rows={9}
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    placeholder="Describe the audience, intent, key points, constraints, and deadline…"
                    maxLength={8000}
                  />
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="hint">{brief.trim().length} / 8000</span>
                    <span className="spacer" />
                    <button className="btn btn-sm" type="button" onClick={() => setBrief(SAMPLE)}>
                      <FileText size={13} /> Use sample
                    </button>
                  </div>
                </div>

                <div className="ai-controls">
                  <div className="field">
                    <label htmlFor="format">Format</label>
                    <select id="format" className="select" value={format} onChange={(event) => setFormat(event.target.value)}>
                      {Object.entries(FORMAT_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="tone">Tone</label>
                    <select id="tone" className="select" value={tone} onChange={(event) => setTone(event.target.value)}>
                      <option value="practical">Practical</option>
                      <option value="warm">Warm</option>
                      <option value="direct">Direct</option>
                      <option value="playful">Playful</option>
                      <option value="formal">Formal</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="length">Length</label>
                    <select id="length" className="select" value={length} onChange={(event) => setLength(event.target.value)}>
                      {Object.entries(LENGTH_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  className="btn btn-primary"
                  onClick={generate}
                  disabled={!editable || generating || brief.trim().length < 10}
                >
                  {generating ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                  {generating ? "Generating…" : editable ? "Generate content" : "Read-only"}
                </button>
                <p className="hint">
                  Output is grounded in your brief and saved to this workspace. Works without external
                  credentials too, using the built-in offline preview.
                </p>
              </div>
            </section>

            <section className="panel">
              <div className="panel-head">
                <Bot size={15} style={{ color: "var(--cyan)" }} />
                <h2>Output</h2>
                <span className="sub">{run ? `Saved ${formatRelative(run.createdAt)}` : "Markdown"}</span>
              </div>
              {run ? (
                <>
                  <div className="output">
                    <Markdown content={run.content} />
                  </div>
                  <div className="output-foot">
                    <span className="badge">{FORMAT_LABEL[run.format] || run.format}</span>
                    <span className="badge">{run.tone}</span>
                    {effective === "offline" ? (
                      <span className="badge badge-gold">offline preview</span>
                    ) : (
                      <span className="badge badge-green">AI generated</span>
                    )}
                    <span className="spacer" />
                    <button className="btn btn-sm" onClick={copy}>
                      <Clipboard size={13} /> Copy
                    </button>
                  </div>
                </>
              ) : (
                <div className="output">
                  <div className="output-empty">
                    {generating ? (
                      <>
                        <Loader2 size={22} className="spin" />
                        <span>Drafting your content…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={24} style={{ opacity: 0.4 }} />
                        <span>Your formatted content will appear here.</span>
                        <span className="hint" style={{ maxWidth: 300 }}>
                          Try the sample brief to see the full flow end to end.
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>

          <section className="panel history">
            <div className="panel-head">
              <FileText size={15} className="muted" />
              <h2>Recent runs</h2>
              <span className="sub">{runs.length} saved in this workspace</span>
            </div>
            <div className="panel-body">
              {runs.length === 0 ? (
                <p className="hint">No AI runs yet. Generate one and it will stay here across sessions.</p>
              ) : (
                <div className="list">
                  {runs.map((item) => (
                    <button className="history-run" key={item.id} onClick={() => setRun(item)}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <CheckCircle2 size={12} style={{ color: "var(--faint)" }} />
                        <span style={{ fontWeight: 600, fontSize: 12.5 }}>
                          {truncate(item.brief.split("\n")[0], 90)}
                        </span>
                        <span className="spacer" />
                        <span className="hint">{formatRelative(item.createdAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          <p className="hint" style={{ marginTop: 14 }}>
            {tenant.name} · AI runs are tenant-scoped and persisted in the shared workflow store. Board
            actions now live in the top-right of the task board.
          </p>
        </main>
      </div>

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

      {showReports ? (
        <ReportsModal
          initialKind={reportsKind}
          onClose={() => setShowReports(false)}
          toasts={toasts}
        />
      ) : null}

      <Toasts toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}
