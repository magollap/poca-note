import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CalendarDays,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  WifiOff,
  X,
} from "lucide-react";
import Board from "./Board";
import AIActionsMenu from "./AIActionsMenu";
import CardModal from "./CardModal";
import QuickCapture from "./QuickCapture";
import ReportsModal from "./ReportsModal";
import SettingsModal from "./SettingsModal";
import ShortcutsModal from "./ShortcutsModal";
import Sidebar from "./Sidebar";
import StatusCheckinModal from "./StatusCheckinModal";
import Toasts from "./Toasts";
import TopBar from "./TopBar";
import TrashDrawer from "./TrashDrawer";
import { api } from "../api";
import { useBoard } from "../hooks/useBoard";
import { useDashboards } from "../hooks/useDashboards";
import { useToasts } from "../hooks/useToasts";
import { canEdit } from "../lib/roles";
import {
  COLUMNS,
  cardNeedsUpdate,
  formatRelative,
  matchesQuery,
  relativeDayLabel,
  sortCards,
  subtaskNeedsUpdate,
  todayKey,
  truncate,
} from "../lib/format";

const REPORT_TILES = [
  {
    key: "daily",
    label: "Today",
    icon: CalendarDays,
    empty: "Yesterday's carryover, overdue work, and today's queue.",
  },
  {
    key: "weekly",
    label: "This week",
    icon: BarChart3,
    empty: "What was completed and created in the last seven days.",
  },
  {
    key: "monthly",
    label: "Last month",
    icon: FileText,
    empty: "The previous calendar month, delivered and carried forward.",
  },
  {
    key: "brief",
    label: "Brief",
    icon: Sparkles,
    empty: "A short factual snapshot you can read in under a minute.",
  },
];

export default function BoardPage({ tenant, navigate, onLogout, route = "/board" }) {
  const toasts = useToasts();
  const editable = canEdit(tenant);
  const dashboardsApi = useDashboards(tenant);
  const requestedDashboardId = new URLSearchParams(String(route || "").split("?")[1] || "").get("d");
  const dashboards = dashboardsApi.dashboards;
  const activeDashboard =
    dashboards.find((dashboard) => dashboard.id === requestedDashboardId) || dashboards[0] || null;
  const dashboardId = activeDashboard?.id || null;

  const board = useBoard(tenant, {
    dashboardId,
    onConflict: () => toasts.info("That card changed elsewhere — the latest version is loaded."),
  });
  const { cards, meta, trashCount, statusIntervalDays } = board;

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [modalCardId, setModalCardId] = useState(null);
  const [showTrash, setShowTrash] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [reportsKind, setReportsKind] = useState("daily");
  const [reports, setReports] = useState(null);
  const [reminderDismissed, setReminderDismissed] = useState(() => {
    try {
      return localStorage.getItem(`poca-note:status-reminder:${tenant.slug}:${todayKey()}`) === "1";
    } catch {
      return false;
    }
  });

  const captureRef = useRef(null);
  const searchRef = useRef(null);

  const selectedCard = cards.find((card) => card.id === selectedId) || null;
  const modalCard = cards.find((card) => card.id === modalCardId) || null;

  const counts = useMemo(() => {
    const result = { todo: 0, doing: 0, review: 0, done: 0 };
    for (const card of cards) result[card.column] = (result[card.column] || 0) + 1;
    return result;
  }, [cards]);

  const staleSummary = useMemo(() => {
    let cardCount = 0;
    let subtaskCount = 0;
    for (const card of cards) {
      if (cardNeedsUpdate(card, statusIntervalDays)) cardCount += 1;
      for (const item of card.checklist || []) {
        if (subtaskNeedsUpdate(item, statusIntervalDays)) subtaskCount += 1;
      }
    }
    return { cards: cardCount, subtasks: subtaskCount, total: cardCount + subtaskCount };
  }, [cards, statusIntervalDays]);

  const dismissReminder = () => {
    setReminderDismissed(true);
    try {
      localStorage.setItem(`poca-note:status-reminder:${tenant.slug}:${todayKey()}`, "1");
    } catch {
      // dismissal is a convenience; storage may be unavailable
    }
  };

  const visibleCards = useMemo(
    () => COLUMNS.flatMap((column) => sortCards(cards.filter((card) => matchesQuery(card, query)), column.key)),
    [cards, query]
  );

  useEffect(() => {
    if (selectedId && !cards.some((card) => card.id === selectedId)) setSelectedId(null);
  }, [cards, selectedId]);

  useEffect(() => {
    if (modalCardId && !cards.some((card) => card.id === modalCardId)) setModalCardId(null);
  }, [cards, modalCardId]);

  // Sidebar counts follow the live revision without a full page refresh.
  useEffect(() => {
    if (!board.revision) return;
    dashboardsApi.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.revision]);

  // Keep the URL in step with the board the server actually resolved.
  useEffect(() => {
    if (!dashboards.length) return;
    const known = dashboards.some((dashboard) => dashboard.id === requestedDashboardId);
    if (!known) {
      navigate(`/board?d=${dashboards[0].id}`, { replace: true });
    }
  }, [dashboards, requestedDashboardId, navigate]);

  const loadReports = useCallback(async () => {
    try {
      setReports(await api("/api/reports/latest"));
    } catch {
      // the dashboard strip is secondary to the board itself
    }
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports, board.revision]);

  const openReports = useCallback((kind = "daily") => {
    setReportsKind(kind);
    setShowReports(true);
  }, []);

  const createCard = useCallback(
    async (title, column) => {
      try {
        const card = await board.createCard({ title, column });
        setSelectedId(card.id);
        return card;
      } catch (error) {
        toasts.error(error.message || "Could not create the card.");
        return null;
      }
    },
    [board, toasts]
  );

  const deleteCard = useCallback(
    async (id) => {
      const card = cards.find((item) => item.id === id);
      if (!card) return;
      try {
        const removed = await board.deleteCard(id);
        setSelectedId((current) => (current === id ? null : current));
        setModalCardId((current) => (current === id ? null : current));
        toasts.success(`“${truncate(removed.title, 42)}” moved to trash.`, {
          duration: 8000,
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await board.restoreCard(removed.id);
                toasts.success("Card restored.");
              } catch (error) {
                toasts.error(error.message || "Could not restore that card.");
              }
            },
          },
        });
      } catch (error) {
        toasts.error(error.message || "Could not move the card to trash.");
      }
    },
    [board, cards, toasts]
  );

  const moveCard = useCallback(
    async (id, column, position) => {
      try {
        return await board.moveCard(id, column, position);
      } catch (error) {
        toasts.error(error.message || "Could not move the card.");
        return null;
      }
    },
    [board, toasts]
  );

  const openCard = useCallback((id) => {
    setSelectedId(id);
    setModalCardId(id);
  }, []);

  const moveSelection = useCallback(
    (delta) => {
      if (!visibleCards.length) return;
      const index = visibleCards.findIndex((card) => card.id === selectedId);
      let next;
      if (index < 0) next = delta > 0 ? 0 : visibleCards.length - 1;
      else next = Math.min(visibleCards.length - 1, Math.max(0, index + delta));
      setSelectedId(visibleCards[next].id);
    },
    [visibleCards, selectedId]
  );

  const moveColumn = useCallback(
    (delta) => {
      const current = cards.find((card) => card.id === selectedId);
      if (!current) return;
      const index = COLUMNS.findIndex((column) => column.key === current.column);
      const targetIndex = Math.min(COLUMNS.length - 1, Math.max(0, index + delta));
      if (targetIndex === index) return;
      const target = COLUMNS[targetIndex];
      const inColumn = visibleCards.filter((card) => card.column === target.key);
      if (inColumn.length) setSelectedId(inColumn[0].id);
    },
    [cards, selectedId, visibleCards]
  );

  const moveSelectedTo = useCallback(
    async (column) => {
      if (!editable || !selectedCard) return;
      await moveCard(selectedCard.id, column);
    },
    [editable, selectedCard, moveCard]
  );

  const anyModal = Boolean(modalCardId || showTrash || showSettings || showHelp || showReports || showCheckin);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
      if (typing || anyModal) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!editable && ["n", "d", "Delete", "1", "2", "3", "4", "c", "t"].includes(event.key)) return;

      switch (event.key) {
        case "n":
          event.preventDefault();
          captureRef.current?.focus();
          break;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          break;
        case "j":
        case "ArrowDown":
          event.preventDefault();
          moveSelection(1);
          break;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          moveSelection(-1);
          break;
        case "h":
        case "ArrowLeft":
          event.preventDefault();
          moveColumn(-1);
          break;
        case "l":
        case "ArrowRight":
          event.preventDefault();
          moveColumn(1);
          break;
        case "Enter":
          if (selectedCard) {
            event.preventDefault();
            openCard(selectedCard.id);
          }
          break;
        case "1":
          event.preventDefault();
          moveSelectedTo("todo");
          break;
        case "2":
          event.preventDefault();
          moveSelectedTo("doing");
          break;
        case "3":
          event.preventDefault();
          moveSelectedTo("review");
          break;
        case "4":
        case "c":
          event.preventDefault();
          moveSelectedTo("done");
          break;
        case "d":
        case "Delete":
          if (selectedCard) {
            event.preventDefault();
            deleteCard(selectedCard.id);
          }
          break;
        case "t":
          event.preventDefault();
          setShowTrash(true);
          break;
        case "b":
          event.preventDefault();
          openReports("daily");
          break;
        case "g":
          event.preventDefault();
          openReports("brief");
          break;
        case "s":
          event.preventDefault();
          setShowSettings(true);
          break;
        case "u":
          event.preventDefault();
          setShowCheckin(true);
          break;
        case "?":
          event.preventDefault();
          setShowHelp(true);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    anyModal,
    deleteCard,
    editable,
    moveColumn,
    moveSelectedTo,
    moveSelection,
    openCard,
    openReports,
    selectedCard,
  ]);

  const search = {
    value: query,
    onChange: setQuery,
    inputRef: searchRef,
  };

  return (
    <div className="app-shell">
      <Sidebar
        tenant={tenant}
        route={route}
        navigate={navigate}
        dashboards={dashboards}
        activeDashboardId={dashboardId}
        onSelectDashboard={(id) => navigate(`/board?d=${id}`)}
        onCreateDashboard={dashboardsApi.create}
        onOpenSettings={() => setShowSettings(true)}
        onOpenTrash={editable ? () => setShowTrash(true) : undefined}
        trashCount={trashCount}
        canCreate={editable}
      />

      <div className="app-main">
        <TopBar
          tenant={tenant}
          search={search}
          sync={meta}
          trashCount={trashCount}
          onOpenTrash={editable ? () => setShowTrash(true) : undefined}
          onOpenReports={() => openReports("daily")}
          onOpenHelp={() => setShowHelp(true)}
          onOpenSettings={() => setShowSettings(true)}
        />

        <main className="page">
          {meta.offline ? (
            <div className="offline-banner">
              <WifiOff size={14} />
              <span style={{ flex: 1 }}>
                Working from the local cache. Retry to reconnect before making changes.
              </span>
              <button className="btn btn-sm" onClick={() => board.refresh()}>
                <RefreshCw size={12} /> Retry
              </button>
            </div>
          ) : null}

          <div className="page-head">
            <div className="page-head-copy">
              <h1 className="page-title">
                {activeDashboard?.name || "Board"}
                <span className={`page-kicker dash-tone ${activeDashboard?.accent || "emerald"}`}>
                  dashboard
                </span>
              </h1>
              <p className="page-sub">
                {relativeDayLabel()}
                {query ? ` · ${visibleCards.length} matching` : ""}
              </p>
              <div className="board-pulse" aria-label="Board totals and task number format">
                <span className="pulse-pill pulse-todo">
                  <b>{counts.todo}</b> to do
                </span>
                <span className="pulse-pill pulse-doing">
                  <b>{counts.doing}</b> doing
                </span>
                <span className="pulse-pill pulse-review">
                  <b>{counts.review}</b> under review
                </span>
                <span className="pulse-pill pulse-done">
                  <b>{counts.done}</b> done
                </span>
                <span className="task-no-legend">
                  <span className="mono">YYMM</span> + 5 digits · e.g.{" "}
                  <b className="mono">261000001</b>
                </span>
              </div>
            </div>
            <div className="page-head-actions board-actions">
              <div className="board-ai-actions">
                <AIActionsMenu
                  cards={cards}
                  editable={editable}
                  onApplied={() => board.refresh({ quiet: true })}
                  toasts={toasts}
                />
              </div>
              {editable ? (
                <button className="btn btn-sm" onClick={() => captureRef.current?.focus()}>
                  <Plus size={13} /> New card <span className="kbd">N</span>
                </button>
              ) : (
                <span className="badge badge-gold">Read-only · observer</span>
              )}
            </div>
          </div>

          {editable ? <QuickCapture inputRef={captureRef} onCreate={createCard} /> : null}

          {staleSummary.total > 0 && !reminderDismissed ? (
            <div className="status-reminder">
              <Activity size={15} />
              <span className="status-reminder-copy">
                <b>
                  {staleSummary.cards} card{staleSummary.cards === 1 ? "" : "s"}
                </b>
                {staleSummary.subtasks > 0 ? (
                  <>
                    {" and "}
                    <b>
                      {staleSummary.subtasks} subtask{staleSummary.subtasks === 1 ? "" : "s"}
                    </b>
                  </>
                ) : null}{" "}
                {staleSummary.total === 1 ? "has" : "have"} gone {statusIntervalDays}+ days without a
                status update.
              </span>
              <button className="btn btn-sm" onClick={() => setShowCheckin(true)}>
                <Activity size={12} /> Check in <span className="kbd">U</span>
              </button>
              <button
                className="icon-btn"
                onClick={dismissReminder}
                title="Dismiss until tomorrow"
                aria-label="Dismiss status reminder"
              >
                <X size={13} />
              </button>
            </div>
          ) : null}

        <div className="reports-strip" aria-label="Latest reports">
          {REPORT_TILES.map((tile) => {
            const report = reports?.latest?.[tile.key] || null;
            const Icon = tile.icon;
            return (
              <button
                key={tile.key}
                type="button"
                className="report-tile"
                onClick={() => openReports(tile.key)}
                title={report ? report.title : editable ? `Generate the ${tile.label.toLowerCase()} report` : `No ${tile.label.toLowerCase()} report yet`}
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
                  {report ? "Open report" : editable ? "Generate now" : "Not generated yet"} <ArrowRight size={11} />
                </span>
              </button>
            );
          })}
        </div>

        {meta.loading && cards.length === 0 ? (
          <div className="column-empty" style={{ marginBottom: 14 }}>
            <Loader2 size={15} className="spin" style={{ verticalAlign: -2 }} /> Loading the board…
          </div>
        ) : null}

        <Board
          cards={cards}
          query={query}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpen={openCard}
          onDelete={deleteCard}
          onMove={moveCard}
          onCreate={createCard}
          readOnly={!editable}
          updateIntervalDays={statusIntervalDays}
        />

        <p className="hint" style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <span>{cards.length} cards · shared source of truth</span>
          <span>revision {board.revision}</span>
          <span>
            last sync {meta.lastSync ? new Date(meta.lastSync).toLocaleTimeString() : "pending"}
          </span>
          <span style={{ marginLeft: "auto" }}>
            <span className="kbd">?</span> shortcuts
          </span>
        </p>
      </main>
      </div>

      {modalCard ? (
        <CardModal
          card={modalCard}
          onClose={() => setModalCardId(null)}
          onSave={(id, patch) => board.updateCard(id, patch)}
          onDelete={deleteCard}
          onMove={moveCard}
          onAddChecklist={board.addChecklist}
          onPatchChecklist={board.patchChecklist}
          onDeleteChecklist={board.deleteChecklist}
          onAddUpdate={board.addCardUpdate}
          onAddChecklistUpdate={board.addChecklistUpdate}
          onSetStatus={board.updateCard}
          updateIntervalDays={statusIntervalDays}
          toasts={toasts}
          readOnly={!editable}
        />
      ) : null}

      {showTrash ? (
        <TrashDrawer
          loadTrash={board.loadTrash}
          onRestore={board.restoreCard}
          onPurge={board.purgeCard}
          onEmpty={board.emptyTrash}
          onClose={() => setShowTrash(false)}
          toasts={toasts}
        />
      ) : null}

      {showSettings ? (
        <SettingsModal
          tenant={tenant}
          onClose={() => {
            setShowSettings(false);
            dashboardsApi.reload();
            board.refresh({ quiet: true });
          }}
          onLogout={onLogout}
          toasts={toasts}
        />
      ) : null}

      {showReports ? (
        <ReportsModal
          initialKind={reportsKind}
          onClose={() => setShowReports(false)}
          onGenerated={loadReports}
          toasts={toasts}
          readOnly={!editable}
        />
      ) : null}

      {showHelp ? <ShortcutsModal onClose={() => setShowHelp(false)} /> : null}

      {showCheckin ? (
        <StatusCheckinModal
          cards={cards}
          intervalDays={statusIntervalDays}
          onClose={() => setShowCheckin(false)}
          onSetStatus={board.updateCard}
          onPatchChecklist={board.patchChecklist}
          onAddUpdate={board.addCardUpdate}
          onAddChecklistUpdate={board.addChecklistUpdate}
          toasts={toasts}
          readOnly={!editable}
        />
      ) : null}

      <Toasts toasts={toasts.toasts} onDismiss={toasts.dismiss} />
    </div>
  );
}
