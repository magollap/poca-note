import { useMemo, useState } from "react";
import { Activity, CheckCheck, Loader2, Send } from "lucide-react";
import Modal from "./Modal";
import { StatusPill, UpdateFeed } from "./StatusUpdates";
import {
  STATUSES,
  cardNeedsUpdate,
  formatRelative,
  statusMeta,
  subtaskNeedsUpdate,
} from "../lib/format";

export default function StatusCheckinModal({
  cards,
  intervalDays = 3,
  onClose,
  onSetStatus,
  onPatchChecklist,
  onAddUpdate,
  onAddChecklistUpdate,
  toasts,
  readOnly = false,
}) {
  const [texts, setTexts] = useState({});
  const [posting, setPosting] = useState(null);
  const [statusBusy, setStatusBusy] = useState(null);

  const targets = useMemo(() => {
    const list = [];
    for (const card of cards) {
      if (cardNeedsUpdate(card, intervalDays)) {
        list.push({
          key: `card:${card.id}`,
          type: "card",
          card,
          label: card.title,
          taskNo: card.taskNo,
          status: card.status,
          updates: card.updates || [],
          lastUpdateAt: card.lastUpdateAt || card.createdAt,
        });
      }
      for (const item of card.checklist || []) {
        if (subtaskNeedsUpdate(item, intervalDays)) {
          list.push({
            key: `item:${item.id}`,
            type: "item",
            card,
            item,
            label: item.text,
            taskNo: item.taskNo,
            status: item.status,
            updates: item.updates || [],
            lastUpdateAt: item.lastUpdateAt || item.createdAt,
          });
        }
      }
    }
    return list.sort((a, b) => String(a.lastUpdateAt).localeCompare(String(b.lastUpdateAt)));
  }, [cards, intervalDays]);

  const changeStatus = async (target, status) => {
    if (readOnly || status === target.status) return;
    setStatusBusy(target.key);
    try {
      if (target.type === "card") {
        await onSetStatus(target.card.id, { status });
      } else {
        await onPatchChecklist(target.item.id, { status });
      }
    } catch (error) {
      toasts.error(error.message || "Could not change that status.");
    } finally {
      setStatusBusy(null);
    }
  };

  const post = async (target) => {
    const text = String(texts[target.key] || "").trim();
    if (!text || posting || readOnly) return;
    setPosting(target.key);
    try {
      if (target.type === "card") {
        await onAddUpdate(target.card.id, text);
      } else {
        await onAddChecklistUpdate(target.item.id, text);
      }
      setTexts((current) => ({ ...current, [target.key]: "" }));
    } catch (error) {
      toasts.error(error.message || "Could not post that update.");
    } finally {
      setPosting(null);
    }
  };

  return (
    <Modal
      title="Status check-in"
      subtitle={
        targets.length
          ? `${targets.length} open ${targets.length === 1 ? "item" : "items"} with no update in ${intervalDays} days`
          : "Everything is fresh"
      }
      onClose={onClose}
      size="wide"
      icon={<Activity size={16} className="muted" />}
      footer={
        <>
          <span className="hint">
            Check-ins keep long-running work honest — a short note is enough.
          </span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onClose}>
            <CheckCheck size={13} /> Done
          </button>
        </>
      }
    >
      <div className="modal-body">
        {targets.length === 0 ? (
          <div className="checkin-empty">
            <CheckCheck size={26} />
            <b>All caught up</b>
            <span className="hint">
              Every open card and subtask has a status update from the last {intervalDays} days.
            </span>
          </div>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              These tasks and subtasks have gone quiet. Post a quick note, set the status, or mark
              one blocked — each action resets its check-in clock.
            </p>
            <div className="checkin-list">
              {targets.map((target) => (
                <div className="checkin-row" key={target.key}>
                  <div className="checkin-head">
                    <StatusPill status={target.status} compact />
                    {target.taskNo ? <span className="checkin-task">Task {target.taskNo}</span> : null}
                    <span className="checkin-title">{target.label}</span>
                    {target.type === "item" ? (
                      <span className="hint checkin-parent">on “{target.card.title}”</span>
                    ) : null}
                    <span className="spacer" />
                    <span className="hint">
                      {target.lastUpdateAt ? `last ${formatRelative(target.lastUpdateAt)}` : "no updates"}
                    </span>
                  </div>
                  <div className="checkin-controls">
                    <select
                      className={`select status-select ${statusMeta(target.status).className}`}
                      value={target.status || "not_started"}
                      onChange={(event) => changeStatus(target, event.target.value)}
                      disabled={readOnly || statusBusy === target.key}
                      aria-label={`Status for ${target.label}`}
                    >
                      {STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {statusMeta(status).label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input"
                      value={texts[target.key] || ""}
                      onChange={(event) =>
                        setTexts((current) => ({ ...current, [target.key]: event.target.value }))
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          post(target);
                        }
                      }}
                      placeholder={`Quick update for ${target.type === "item" ? "this subtask" : "this task"}…`}
                      maxLength={4000}
                      aria-label={`Update for ${target.label}`}
                    />
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => post(target)}
                      disabled={!String(texts[target.key] || "").trim() || posting === target.key}
                    >
                      {posting === target.key ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Send size={13} />
                      )}
                      Post
                    </button>
                  </div>
                  {target.updates.length ? <UpdateFeed updates={target.updates} limit={2} /> : null}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
