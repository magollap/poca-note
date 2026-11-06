import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleDot,
  Layers,
  Loader2,
  PlusCircle,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { api } from "../api";

const RANGES = [
  { key: "daily", label: "Daily", window: "Last 14 days" },
  { key: "weekly", label: "Weekly", window: "Last 8 weeks" },
  { key: "monthly", label: "Monthly", window: "Last 6 months" },
];

const COLUMN_LABEL = { todo: "To Do", doing: "Doing", review: "Under Review", done: "Done" };

function niceMax(value) {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const scaled = value / power;
  const step = scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * power;
}

function ThroughputChart({ buckets }) {
  const width = 780;
  const height = 250;
  const pad = { left: 34, right: 12, top: 16, bottom: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...buckets.map((bucket) => Math.max(bucket.created, bucket.completed))));
  const step = innerW / Math.max(1, buckets.length);
  const barW = Math.min(20, step * 0.3);
  const labelEvery = buckets.length > 10 ? 2 : 1;

  const y = (value) => pad.top + innerH - (value / max) * innerH;

  return (
    <svg className="perf-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Created and completed work">
      <defs>
        <linearGradient id="perfCreated" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#7c5cf0" />
        </linearGradient>
        <linearGradient id="perfCompleted" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4ade80" />
          <stop offset="100%" stopColor="#16a34a" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <g key={ratio}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={pad.top + innerH * ratio}
            y2={pad.top + innerH * ratio}
            stroke="var(--border)"
            strokeDasharray={ratio === 1 ? "0" : "3 5"}
            strokeWidth="1"
          />
          <text x={pad.left - 8} y={pad.top + innerH * ratio + 3.5} textAnchor="end" className="perf-axis">
            {Math.round(max * (1 - ratio))}
          </text>
        </g>
      ))}
      {buckets.map((bucket, index) => {
        const center = pad.left + step * index + step / 2;
        return (
          <g key={bucket.key}>
            <rect
              x={center - barW - 2}
              y={y(bucket.created)}
              width={barW}
              height={Math.max(0, pad.top + innerH - y(bucket.created))}
              rx="3"
              fill="url(#perfCreated)"
            />
            <rect
              x={center + 2}
              y={y(bucket.completed)}
              width={barW}
              height={Math.max(0, pad.top + innerH - y(bucket.completed))}
              rx="3"
              fill="url(#perfCompleted)"
            />
            {index % labelEvery === 0 ? (
              <text x={center} y={height - 10} textAnchor="middle" className="perf-axis">
                {bucket.label}
              </text>
            ) : null}
            <title>
              {`${bucket.label} · ${bucket.created} created · ${bucket.completed} completed · ${bucket.backlog} open`}
            </title>
          </g>
        );
      })}
    </svg>
  );
}

function BacklogChart({ buckets }) {
  const width = 780;
  const height = 130;
  const pad = { left: 30, right: 12, top: 12, bottom: 20 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(1, ...buckets.map((bucket) => bucket.backlog)));
  const step = innerW / Math.max(1, buckets.length - 1 || 1);
  const points = buckets.map((bucket, index) => {
    const x = pad.left + step * index;
    const y = pad.top + innerH - (bucket.backlog / max) * innerH;
    return [x, y];
  });
  const line = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `${pad.left + 0},${pad.top + innerH} ${line} ${pad.left + step * (buckets.length - 1)},${pad.top + innerH}`;

  return (
    <svg className="perf-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Open backlog trend">
      <defs>
        <linearGradient id="perfBacklog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(251, 146, 60, 0.55)" />
          <stop offset="100%" stopColor="rgba(251, 146, 60, 0.02)" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#perfBacklog)" />
      <polyline points={line} fill="none" stroke="#fb923c" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map(([x, y], index) =>
        index === buckets.length - 1 ? (
          <circle key={index} cx={x} cy={y} r="3.5" fill="#fb923c" />
        ) : null
      )}
      <text x={pad.left} y={height - 5} className="perf-axis">
        open backlog
      </text>
      <text x={width - pad.right} y={height - 5} textAnchor="end" className="perf-axis">
        {buckets.at(-1)?.backlog ?? 0} now
      </text>
    </svg>
  );
}

function Breakdown({ title, entries }) {
  const max = Math.max(1, ...entries.map((entry) => entry.value));
  return (
    <div className="perf-breakdown">
      <div className="field-label">{title}</div>
      {entries.map((entry) => (
        <div className="perf-breakdown-row" key={entry.label}>
          <span className={`dash-dot ${entry.accent || "violet"}`} />
          <span className="perf-breakdown-label">{entry.label}</span>
          <span className="perf-breakdown-track">
            <span
              className={`perf-breakdown-fill ${entry.accent || "violet"}`}
              style={{ width: `${Math.round((entry.value / max) * 100)}%` }}
            />
          </span>
          <span className="perf-breakdown-value">{entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function PerformanceCharts({ dashboardId = null }) {
  const [range, setRange] = useState("daily");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (nextRange = range, { quiet = false } = {}) => {
      if (!quiet) setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams({ range: nextRange });
        if (dashboardId) query.set("dashboardId", dashboardId);
        setData(await api(`/api/reports/performance?${query.toString()}`));
      } catch (err) {
        setError(err.message || "Could not load performance data.");
      } finally {
        setLoading(false);
      }
    },
    [range, dashboardId]
  );

  useEffect(() => {
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, dashboardId]);

  const priority = useMemo(() => {
    if (!data) return [];
    return [
      { label: "High", value: data.byPriority.high || 0, accent: "orange" },
      { label: "Normal", value: data.byPriority.normal || 0, accent: "gold" },
      { label: "Low", value: data.byPriority.low || 0, accent: "green" },
    ];
  }, [data]);

  const columns = useMemo(() => {
    if (!data) return [];
    return [
      { label: COLUMN_LABEL.todo, value: data.byColumn.todo || 0, accent: "orange" },
      { label: COLUMN_LABEL.doing, value: data.byColumn.doing || 0, accent: "gold" },
      { label: COLUMN_LABEL.review, value: data.byColumn.review || 0, accent: "violet" },
      { label: COLUMN_LABEL.done, value: data.byColumn.done || 0, accent: "green" },
    ];
  }, [data]);

  const waves = RANGES.find((entry) => entry.key === range);

  return (
    <section className="panel perf-panel">
      <div className="panel-head">
        <Activity size={15} style={{ color: "var(--gold)" }} />
        <h2>Performance</h2>
        <span className="sub">{waves?.window || "Throughput"}</span>
        <span className="spacer" />
        <div className="nav-tabs" role="tablist" aria-label="Performance range">
          {RANGES.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={range === entry.key}
              className={`nav-tab ${range === entry.key ? "active" : ""}`}
              onClick={() => setRange(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => load(range, { quiet: true })}
          title="Refresh performance data"
          aria-label="Refresh performance data"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {loading && !data ? (
        <div className="perf-loading">
          <Loader2 size={18} className="spin" /> Reading board history…
        </div>
      ) : error ? (
        <div className="perf-loading" style={{ color: "var(--red)" }}>
          {error}
        </div>
      ) : data ? (
        <div className="perf-body">
          <div className="perf-stats">
            <div className="perf-stat violet">
              <span className="perf-stat-icon"><PlusCircle size={14} /></span>
              <span className="perf-stat-value">{data.totals.created}</span>
              <span className="perf-stat-label">Created</span>
            </div>
            <div className="perf-stat emerald">
              <span className="perf-stat-icon"><CheckCircle2 size={14} /></span>
              <span className="perf-stat-value">{data.totals.completed}</span>
              <span className="perf-stat-label">Completed</span>
            </div>
            <div className="perf-stat amber">
              <span className="perf-stat-icon"><CircleDot size={14} /></span>
              <span className="perf-stat-value">{data.totals.open}</span>
              <span className="perf-stat-label">Open now</span>
            </div>
            <div className="perf-stat rose">
              <span className="perf-stat-icon"><TrendingUp size={14} /></span>
              <span className="perf-stat-value">{data.totals.completionRate}%</span>
              <span className="perf-stat-label">Done rate</span>
            </div>
          </div>

          <div className="perf-chart-block">
            <div className="perf-legend">
              <span><span className="perf-swatch violet" /> Created</span>
              <span><span className="perf-swatch emerald" /> Completed</span>
              <span className="hint" style={{ marginLeft: "auto" }}>
                net {data.totals.net >= 0 ? "+" : ""}
                {data.totals.net} in this window
              </span>
            </div>
            <ThroughputChart buckets={data.buckets} />
            <BacklogChart buckets={data.buckets} />
          </div>

          <div className="perf-breakdowns">
            <Breakdown title="Open by priority" entries={priority} />
            <Breakdown title="Cards by column" entries={columns} />
            <Breakdown
              title="Boards"
              entries={data.byDashboard.map((board) => ({
                label: board.name,
                value: board.counts.total,
                accent: board.accent,
              }))}
            />
          </div>

          <div className="perf-foot">
            <Layers size={12} />
            <span>
              {data.cardCount} live cards · timezone {data.timezone} · facts read from card timestamps
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
