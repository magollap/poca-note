import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  Play,
  Sparkles,
  Wand2,
  X,
  XCircle,
} from "lucide-react";
import { api } from "../api";

const ACTION_LABEL = {
  create: "Create card",
  update: "Update card",
  complete: "Complete card",
  delete: "Move to trash",
  subtask: "Add subtask",
  subtask_complete: "Complete subtask",
  subtask_update: "Rename subtask",
  subtask_delete: "Delete subtask",
};

const ACTION_TONE = {
  create: "badge-green",
  update: "",
  complete: "badge-green",
  delete: "badge-red",
  subtask: "badge-gold",
  subtask_complete: "badge-green",
  subtask_update: "",
  subtask_delete: "badge-red",
};

const COLUMN_LABEL = { todo: "To Do", doing: "Doing", review: "Under Review", done: "Done" };

function actionTitle(action) {
  if (action.type === "create") return action.title;
  if (action.type === "subtask" && !action.unresolved) return `“${action.text}”`;
  if (action.type.startsWith("subtask_") && !action.unresolved) {
    return `Task ${action.taskNo} ${action.checklistText || action.text || ""}`.trim();
  }
  return action.cardTitle || "Unmatched card";
}

function actionMeta(action) {
  if (action.unresolved) return "No matching card — this action will be skipped.";
  if (action.type === "create") {
    const bits = [COLUMN_LABEL[action.column] || "To Do"];
    if (action.dueDate) bits.push(`due ${action.dueDate}`);
    if (action.priority && action.priority !== "normal") bits.push(`${action.priority} priority`);
    return bits.join(" · ");
  }
  if (action.type === "update") {
    const patch = action.patch || {};
    const bits = [];
    if (patch.title) bits.push(`title → ${patch.title}`);
    if (patch.column) bits.push(`column → ${COLUMN_LABEL[patch.column] || patch.column}`);
    if (patch.dueDate !== undefined) bits.push(`due → ${patch.dueDate || "none"}`);
    if (patch.priority) bits.push(`priority → ${patch.priority}`);
    if (patch.notes) bits.push("notes replaced");
    return bits.join(" · ") || "No changes";
  }
  if (action.type === "complete") {
    return action.cardColumn === "done"
      ? "Already done"
      : `${COLUMN_LABEL[action.cardColumn] || "Open"} → Done`;
  }
  if (action.type === "delete") return `Currently in ${COLUMN_LABEL[action.cardColumn] || "the board"}`;
  if (action.type === "subtask") {
    return action.cardTaskNo ? `on Task ${action.cardTaskNo}` : "on the selected card";
  }
  if (action.type === "subtask_update") return `on “${action.cardTitle}”`;
  return "";
}

export default function AIActionsMenu({ cards = [], editable = true, onApplied, toasts }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState(null);
  const [planRunId, setPlanRunId] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState(null);
  const [showNumbers, setShowNumbers] = useState(true);
  const rootRef = useRef(null);
  const textareaRef = useRef(null);

  const taskCards = useMemo(
    () =>
      cards
        .filter((card) => card.taskNo)
        .slice()
        .sort((a, b) => String(a.taskNo).localeCompare(String(b.taskNo))),
    [cards]
  );

  const samples = useMemo(() => {
    const first = taskCards[0]?.taskNo;
    const subtaskCard = taskCards.find((card) =>
      (card.checklist || []).some((item) => item.taskNo)
    );
    const subtask = (subtaskCard?.checklist || []).find((item) => item.taskNo)?.taskNo;
    return [
      "Create a card “Review pricing” due Friday high priority",
      first ? `Mark Task ${first} as done` : "Mark a card as done",
      first ? `Add subtask “Check margins” to Task ${first}` : "Add a subtask to a card",
      subtask ? `Complete Task ${subtask}` : "Complete a subtask",
    ];
  }, [taskCards]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        const form = rootRef.current?.querySelector("form");
        form?.requestSubmit?.();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open || status) return;
    api("/api/ai/status").then(setStatus).catch(() => {});
  }, [open, status]);

  const insertTaskNo = (taskNo) => {
    const token = `Task ${taskNo}`;
    setPrompt((current) => (current ? `${current.trim()} ${token}` : token));
    textareaRef.current?.focus();
  };

  const planActions = useCallback(async () => {
    if (!editable || planning) return;
    const text = prompt.trim();
    if (text.length < 3) {
      toasts?.error("Describe the change in a few words.");
      return;
    }
    setPlanning(true);
    setResult(null);
    try {
      const data = await api("/api/ai/actions/plan", { method: "POST", body: { prompt: text } });
      setPlan(data.plan);
      setPlanRunId(data.runId);
      setWarnings(data.warnings || []);
      if (!(data.plan?.actions || []).length) {
        toasts?.info("Nothing actionable was found. Name a card or start with “Create a card…”.");
      }
    } catch (error) {
      toasts?.error(error.message || "Could not build a plan.");
    } finally {
      setPlanning(false);
    }
  }, [editable, planning, prompt, toasts]);

  const applyActions = useCallback(async () => {
    if (!editable || applying || (!planRunId && !plan)) return;
    setApplying(true);
    try {
      const data = await api("/api/ai/actions/apply", {
        method: "POST",
        body: planRunId ? { runId: planRunId } : { plan },
      });
      setResult(data);
      setPlan((current) => (current ? { ...current, status: data.status } : current));
      if (data.applied && !data.failed) {
        toasts?.success(`${data.applied} action${data.applied === 1 ? "" : "s"} applied.`);
        onApplied?.();
      } else if (data.applied) {
        toasts?.info(`${data.applied} applied, ${data.failed} could not be applied.`);
        onApplied?.();
      } else {
        toasts?.error(data.results?.[0]?.message || "No action could be applied.");
      }
    } catch (error) {
      toasts?.error(error.message || "Could not apply the plan.");
    } finally {
      setApplying(false);
    }
  }, [applying, editable, onApplied, plan, planRunId, toasts]);

  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const effective = status?.ready ? "ready" : "offline";

  return (
    <div className="ai-actions-menu" ref={rootRef}>
      <button
        type="button"
        className={`btn btn-sm ai-actions-trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Run AI actions by task number"
      >
        <Wand2 size={13} />
        AI Actions
        <span className={`ai-dot ${effective === "offline" ? "offline" : ""}`} />
        <ChevronDown size={12} className={`ai-actions-chevron${open ? " is-open" : ""}`} />
      </button>

      {open ? (
        <div className="ai-actions-panel" role="dialog" aria-label="AI board actions">
          <div className="ai-actions-head">
            <span className="ai-actions-icon">
              <Sparkles size={15} />
            </span>
            <div>
              <h2>AI Actions</h2>
              <p>
                Describe a change by task number. Review the plan before anything moves.
              </p>
            </div>
            <span className={`badge ${effective === "offline" ? "badge-gold" : "badge-green"}`}>
              {effective === "offline" ? "Offline" : "AI ready"}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setOpen(false)}
              aria-label="Close AI actions"
            >
              <X size={14} />
            </button>
          </div>

          <div className="ai-actions-body">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                planActions();
              }}
            >
              <div className="field">
                <label htmlFor="ai-actions-prompt">What should change on the board?</label>
                <textarea
                  id="ai-actions-prompt"
                  ref={textareaRef}
                  className="textarea ai-actions-textarea"
                  rows={4}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="e.g. Mark Task 261000001 as done, add a subtask to 261000002…"
                  maxLength={4000}
                  autoFocus
                />
              </div>
              <div className="ai-actions-samples">
                {samples.map((sample) => (
                  <button
                    key={sample}
                    type="button"
                    className="badge action-sample"
                    onClick={() => setPrompt(sample)}
                  >
                    {sample}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-primary btn-sm ai-actions-plan"
                type="submit"
                disabled={!editable || planning || prompt.trim().length < 3}
              >
                {planning ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />}
                {planning ? "Planning…" : editable ? "Plan actions" : "Read-only"}
              </button>
            </form>

            <div className="ai-task-reference">
              <button
                type="button"
                className="ai-task-reference-toggle"
                onClick={() => setShowNumbers((value) => !value)}
                aria-expanded={showNumbers}
              >
                <span className="field-label">Task numbers on this board</span>
                <span className="spacer" />
                <span className="hint">{taskCards.length} cards</span>
                <ChevronDown size={12} className={showNumbers ? "is-open" : ""} />
              </button>
              {showNumbers ? (
                taskCards.length ? (
                  <div className="ai-task-list">
                    {taskCards.map((card) => (
                      <div className="ai-task-row" key={card.id}>
                        <button
                          type="button"
                          className="ai-task-chip"
                          onClick={() => insertTaskNo(card.taskNo)}
                          title={`Insert Task ${card.taskNo}`}
                        >
                          <b>{card.taskNo}</b>
                          <span>{card.title}</span>
                          <span className={`ai-task-column ${card.column}`}>
                            {COLUMN_LABEL[card.column] || card.column}
                          </span>
                        </button>
                        {Array.isArray(card.checklist) && card.checklist.length ? (
                          <div className="ai-subtask-chips">
                            {card.checklist.map((item) =>
                              item.taskNo ? (
                                <button
                                  key={item.id}
                                  type="button"
                                  className={`ai-subtask-chip${item.done ? " is-done" : ""}`}
                                  onClick={() => insertTaskNo(item.taskNo)}
                                  title={`Insert Task ${item.taskNo}`}
                                >
                                  {item.taskNo} · {item.text}
                                </button>
                              ) : null
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="hint">No task numbers yet. Create a card and it appears here.</p>
                )
              ) : null}
            </div>

            {plan ? (
              <div className="ai-plan">
                <div className="ai-plan-head">
                  <span className={`badge ${plan.source === "offline" ? "badge-gold" : "badge-green"}`}>
                    {plan.source === "offline" ? "Offline plan" : "Model plan"}
                  </span>
                  <span className="hint">
                    {actions.length} action{actions.length === 1 ? "" : "s"}
                  </span>
                  <span className="spacer" />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={applyActions}
                    disabled={!editable || applying || !actions.length || plan.status === "applied"}
                  >
                    {applying ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
                    {applying ? "Applying…" : plan.status === "applied" ? "Applied" : "Apply plan"}
                  </button>
                </div>
                {plan.summary ? <p className="ai-plan-summary">{plan.summary}</p> : null}
                {warnings.length ? (
                  <div className="ai-plan-warning">{warnings.join(" ")}</div>
                ) : null}
                <div className="ai-plan-list">
                  {actions.map((action, index) => (
                    <div className="ai-plan-row" key={action.id || `${action.type}-${index}`}>
                      <span className={`badge ${ACTION_TONE[action.type] || ""}`}>
                        {ACTION_LABEL[action.type] || action.type}
                      </span>
                      <div className="grow">
                        <div className="title">{actionTitle(action)}</div>
                        <div className="meta">{actionMeta(action)}</div>
                      </div>
                    </div>
                  ))}
                </div>
                {result?.results?.length ? (
                  <div className="ai-plan-results">
                    {result.results.map((entry, index) => (
                      <div className="ai-plan-result" key={entry.id || index}>
                        {entry.ok ? (
                          <CheckCircle2 size={12} style={{ color: "var(--green)" }} />
                        ) : (
                          <XCircle size={12} style={{ color: "var(--red)" }} />
                        )}
                        <span>{entry.message}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
