import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Calendar,
  CheckSquare,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquare,
  Plus,
  Send,
  Trash2,
  X,
} from "lucide-react";
import Modal from "./Modal";
import { StatusPill, UpdateFeed } from "./StatusUpdates";
import { api } from "../api";
import {
  COLUMN_LABEL,
  COLUMNS,
  STATUSES,
  cardNeedsUpdate,
  checklistProgress,
  formatDateTime,
  formatRelative,
  isOverdue,
  shortHost,
  statusMeta,
  subtaskNeedsUpdate,
} from "../lib/format";

function formFrom(card) {
  return {
    title: card.title,
    notes: card.notes || "",
    linkUrl: card.linkUrl || "",
    linkTitle: card.linkTitle || "",
    dueDate: card.dueDate || "",
    priority: card.priority || "normal",
  };
}

export default function CardModal({
  card,
  onClose,
  onSave,
  onDelete,
  onMove,
  onAddChecklist,
  onPatchChecklist,
  onDeleteChecklist,
  onAddUpdate,
  onAddChecklistUpdate,
  onSetStatus,
  updateIntervalDays = 3,
  toasts,
  readOnly = false,
}) {
  const [form, setForm] = useState(() => formFrom(card));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [fetchingTitle, setFetchingTitle] = useState(false);
  const [checklistText, setChecklistText] = useState("");
  const [busyItem, setBusyItem] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [updateText, setUpdateText] = useState("");
  const [postingUpdate, setPostingUpdate] = useState(false);
  const [expandedItem, setExpandedItem] = useState(null);
  const [itemUpdateText, setItemUpdateText] = useState({});
  const [postingItem, setPostingItem] = useState(null);
  const [baseVersion, setBaseVersion] = useState(card.version);
  const titleRef = useRef(null);
  const checklistRef = useRef(null);
  const savingRef = useRef(false);
  savingRef.current = saving;

  useEffect(() => {
    setForm(formFrom(card));
    setDirty(false);
    setConfirmClose(false);
    setExternalChange(false);
    setBaseVersion(card.version);
    setUpdateText("");
    setExpandedItem(null);
    setItemUpdateText({});
    if (readOnly) return undefined;
    const timer = setTimeout(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    }, 30);
    return () => clearTimeout(timer);
    // Only reset when a different card is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  useEffect(() => {
    if (card.version === baseVersion) return;
    if (!dirty) {
      setForm(formFrom(card));
      setBaseVersion(card.version);
      setExternalChange(false);
    } else {
      setExternalChange(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.version]);

  const update = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
    setDirty(true);
  };

  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    onClose();
  };

  const save = async () => {
    if (saving || !form.title.trim()) return;
    setSaving(true);
    try {
      const result = await onSave(card.id, {
        title: form.title.trim(),
        notes: form.notes,
        linkUrl: form.linkUrl.trim(),
        linkTitle: form.linkTitle.trim(),
        dueDate: form.dueDate || null,
        priority: form.priority,
      });
      if (result?.conflict && result.card) {
        setForm(formFrom(result.card));
        setBaseVersion(result.card.version);
        setDirty(false);
        setExternalChange(false);
        toasts.info("Someone else saved first — the latest version is loaded. Review and save again.");
        return;
      }
      onClose();
    } catch (error) {
      toasts.error(error.message || "Could not save the card.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (!savingRef.current && !readOnly) save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, card.id]);

  const fetchTitle = async () => {
    const url = form.linkUrl.trim();
    if (!url) return;
    setFetchingTitle(true);
    try {
      const result = await api(`/api/link-title?url=${encodeURIComponent(url)}`);
      setForm((current) => ({
        ...current,
        linkTitle: result.title || current.linkTitle,
        linkUrl: current.linkUrl,
      }));
      setDirty(true);
      toasts.success(result.title ? `Title found: ${result.title}` : "Page reached, but no title was found.");
    } catch (error) {
      toasts.error(error.message || "Could not fetch that page title.");
    } finally {
      setFetchingTitle(false);
    }
  };

  const addChecklist = async () => {
    const text = checklistText.trim();
    if (!text) return;
    try {
      const updated = await onAddChecklist(card.id, text);
      setChecklistText("");
      if (updated?.version) setBaseVersion(updated.version);
      checklistRef.current?.focus();
    } catch (error) {
      toasts.error(error.message || "Could not add that checklist item.");
    }
  };

  const toggleItem = async (item) => {
    setBusyItem(item.id);
    try {
      const updated = await onPatchChecklist(item.id, { done: !item.done });
      if (updated?.version) setBaseVersion(updated.version);
    } catch (error) {
      toasts.error(error.message || "Could not update that checklist item.");
    } finally {
      setBusyItem(null);
    }
  };

  const removeItem = async (item) => {
    setBusyItem(item.id);
    try {
      const updated = await onDeleteChecklist(item.id);
      if (updated?.version) setBaseVersion(updated.version);
    } catch (error) {
      toasts.error(error.message || "Could not remove that checklist item.");
    } finally {
      setBusyItem(null);
    }
  };

  const patchChecklist = async (item, patch) => {
    setBusyItem(item.id);
    try {
      const updated = await onPatchChecklist(item.id, patch);
      if (updated?.version) setBaseVersion(updated.version);
    } catch (error) {
      toasts.error(error.message || "Could not update that subtask.");
    } finally {
      setBusyItem(null);
    }
  };

  const changeStatus = async (status) => {
    if (readOnly || status === card.status) return;
    setStatusBusy(true);
    try {
      const updated = await onSetStatus(card.id, { status });
      if (updated?.version) setBaseVersion(updated.version);
    } catch (error) {
      toasts.error(error.message || "Could not change the status.");
    } finally {
      setStatusBusy(false);
    }
  };

  const postUpdate = async () => {
    const text = updateText.trim();
    if (!text || postingUpdate || readOnly) return;
    setPostingUpdate(true);
    try {
      const updated = await onAddUpdate(card.id, text);
      setUpdateText("");
      if (updated?.version) setBaseVersion(updated.version);
      toasts.success("Status update posted.");
    } catch (error) {
      toasts.error(error.message || "Could not post that update.");
    } finally {
      setPostingUpdate(false);
    }
  };

  const postItemUpdate = async (item) => {
    const text = String(itemUpdateText[item.id] || "").trim();
    if (!text || postingItem === item.id || readOnly) return;
    setPostingItem(item.id);
    try {
      const updated = await onAddChecklistUpdate(item.id, text);
      setItemUpdateText((current) => ({ ...current, [item.id]: "" }));
      if (updated?.version) setBaseVersion(updated.version);
      toasts.success("Subtask update posted.");
    } catch (error) {
      toasts.error(error.message || "Could not post that subtask update.");
    } finally {
      setPostingItem(null);
    }
  };

  const moveTo = async (column) => {
    if (column === card.column) return;
    try {
      const updated = await onMove(card.id, column);
      if (updated?.version) setBaseVersion(updated.version);
    } catch (error) {
      toasts.error(error.message || "Could not move the card.");
    }
  };

  const progress = useMemo(() => checklistProgress(card.checklist), [card.checklist]);
  const overdue = isOverdue(card.dueDate, card.column);
  const cardStale = cardNeedsUpdate(card, updateIntervalDays);
  const cardUpdates = card.updates || [];

  return (
    <Modal
      title="Card details"
      subtitle={`${COLUMN_LABEL[card.column] || "To Do"}${card.taskNo ? ` · Task ${card.taskNo}` : ""} · v${card.version} · updated ${formatRelative(card.updatedAt)}`}
      onClose={requestClose}
      size="wide"
      icon={
        <span className={`column-dot ${card.column}`} style={{ marginLeft: 2 }} aria-hidden="true" />
      }
      footer={
        readOnly ? (
          <>
            <span className="badge badge-gold">Read-only</span>
            <span className="hint">Observers cannot change cards.</span>
            <span className="spacer" />
            <button className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
        <>
          <button
            className="btn btn-danger btn-sm"
            onClick={async () => {
              await onDelete(card.id);
              onClose();
            }}
          >
            <Trash2 size={13} /> Delete
          </button>
          <span className="spacer" />
          {confirmClose ? (
            <>
              <span className="hint" style={{ color: "var(--yellow)" }}>
                Discard unsaved changes?
              </span>
              <button className="btn btn-sm" onClick={() => setConfirmClose(false)}>
                Keep editing
              </button>
              <button className="btn btn-danger btn-sm" onClick={onClose}>
                Discard
              </button>
            </>
          ) : (
            <>
              {dirty ? <span className="badge badge-gold">Unsaved</span> : null}
              <button className="btn btn-sm" onClick={requestClose}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !form.title.trim()}>
                {saving ? <Loader2 size={13} className="spin" /> : null}
                {saving ? "Saving…" : "Save"}
                <span className="kbd" style={{ marginLeft: 2 }}>
                  ⌘↵
                </span>
              </button>
            </>
          )}
        </>
        )
      }
    >
      <div className="modal-body">
        {externalChange ? (
          <div className="editor-note">
            <AlertTriangle size={14} />
            <span style={{ flex: 1 }}>This card changed on another device. Saving keeps your edits but may overwrite theirs.</span>
            <button
              className="btn btn-sm"
              onClick={() => {
                setForm(formFrom(card));
                setBaseVersion(card.version);
                setDirty(false);
                setExternalChange(false);
              }}
            >
              Load latest
            </button>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="card-title">Title</label>
          <input
            id="card-title"
            ref={titleRef}
            className="input"
            value={form.title}
            onChange={(event) => update("title", event.target.value)}
            maxLength={500}
            placeholder="What needs to happen?"
            disabled={readOnly}
          />
        </div>

        <div className="field">
          <label htmlFor="card-notes">Notes</label>
          <textarea
            id="card-notes"
            className="textarea"
            value={form.notes}
            onChange={(event) => update("notes", event.target.value)}
            placeholder="Context, decisions, links to thinking…"
            rows={6}
            maxLength={20_000}
            disabled={readOnly}
          />
        </div>

        <div className="card-editor-grid">
          <div className="field full">
            <label htmlFor="card-link">Link</label>
            <div style={{ display: "flex", gap: 7 }}>
              <input
                id="card-link"
                className="input"
                value={form.linkUrl}
                onChange={(event) => update("linkUrl", event.target.value)}
                placeholder="https://…"
                inputMode="url"
                disabled={readOnly}
              />
              {readOnly ? null : (
                <button
                  className="btn"
                  type="button"
                  onClick={fetchTitle}
                  disabled={!form.linkUrl.trim() || fetchingTitle}
                  title="Fetch the page title"
                >
                  {fetchingTitle ? <Loader2 size={13} className="spin" /> : <Link2 size={13} />}
                  Fetch title
                </button>
              )}
            </div>
            {form.linkUrl ? (
              <div className="link-preview">
                <Link2 size={13} />
                <span className="title" title={form.linkTitle || form.linkUrl}>
                  {form.linkTitle || shortHost(form.linkUrl)}
                </span>
                <a href={form.linkUrl} target="_blank" rel="noreferrer noopener" className="icon-btn" style={{ width: 24, height: 24 }} title="Open link">
                  <ExternalLink size={12} />
                </a>
              </div>
            ) : (
              <span className="hint">Paste a URL and fetch its title so the card is recognizable later.</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="card-due">Due date</label>
            <input
              id="card-due"
              type="date"
              className="input"
              value={form.dueDate}
              onChange={(event) => update("dueDate", event.target.value)}
              disabled={readOnly}
            />
            {overdue ? (
              <span className="hint" style={{ color: "var(--red)" }}>
                This card is overdue.
              </span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="card-priority">Priority</label>
            <select
              id="card-priority"
              className="select"
              value={form.priority}
              onChange={(event) => update("priority", event.target.value)}
              disabled={readOnly}
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="card-status">Status</label>
            <div className="status-control">
              <select
                id="card-status"
                className={`select ${statusMeta(card.status).className}`}
                value={card.status || "not_started"}
                onChange={(event) => changeStatus(event.target.value)}
                disabled={readOnly || statusBusy}
              >
                {STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {statusMeta(status).label}
                  </option>
                ))}
              </select>
              {cardStale ? (
                <span className="badge badge-gold" title={`No status update in ${updateIntervalDays} days`}>
                  Needs update
                </span>
              ) : null}
            </div>
            <span className="hint">
              {cardStale
                ? `Last update ${formatRelative(card.lastUpdateAt)} — add a note below.`
                : `Check in every ${updateIntervalDays} days.`}
            </span>
          </div>

          <div className="field full">
            <label>Column</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {COLUMNS.map((column) => (
                <button
                  key={column.key}
                  type="button"
                  className={`btn btn-sm ${card.column === column.key ? "btn-primary" : ""}`}
                  onClick={() => moveTo(column.key)}
                  disabled={readOnly}
                >
                  <span className={`column-dot ${column.dot}`} style={{ width: 6, height: 6 }} />
                  {column.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field full">
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              Checklist
              {progress.total > 0 ? (
                <span className="badge">
                  {progress.done}/{progress.total}
                </span>
              ) : null}
            </label>
            <div className="checklist">
              {card.checklist.length === 0 ? (
                <span className="hint" style={{ padding: "4px 2px" }}>
                  Break the card into small, checkable steps.
                </span>
              ) : null}
              {card.checklist.map((item) => {
                const itemStale = subtaskNeedsUpdate(item, updateIntervalDays);
                const expanded = expandedItem === item.id;
                const updateCount = item.updates?.length || 0;
                return (
                  <div className={`checklist-item${expanded ? " open" : ""}`} key={item.id}>
                    <div className="checklist-row">
                      <input
                        type="checkbox"
                        checked={item.done}
                        onChange={() => toggleItem(item)}
                        disabled={readOnly || busyItem === item.id}
                        aria-label={`Toggle ${item.text}`}
                      />
                      <span className={`text ${item.done ? "done" : ""}`}>
                        {item.taskNo ? (
                          <span className="task-no" title={`Task ${item.taskNo} — reference it in AI Actions`}>
                            Task {item.taskNo}
                          </span>
                        ) : null}
                        {item.text}
                        {itemStale ? (
                          <span
                            className="subtask-stale"
                            title={`No status update in ${updateIntervalDays} days`}
                          >
                            needs update
                          </span>
                        ) : null}
                      </span>
                      <select
                        className={`select status-select ${statusMeta(item.status).className}`}
                        value={item.status || "not_started"}
                        onChange={(event) => patchChecklist(item, { status: event.target.value })}
                        disabled={readOnly || busyItem === item.id}
                        aria-label={`Status for ${item.text}`}
                        title="Subtask status"
                      >
                        {STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {statusMeta(status).label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-btn update-toggle"
                        onClick={() => setExpandedItem(expanded ? null : item.id)}
                        title="Status updates for this subtask"
                        aria-label={`Status updates for ${item.text}`}
                      >
                        <MessageSquare size={12} />
                        {updateCount ? <span className="update-count">{updateCount}</span> : null}
                      </button>
                      {readOnly ? null : (
                        <button
                          className="icon-btn"
                          style={{ width: 22, height: 22 }}
                          onClick={() => removeItem(item)}
                          disabled={busyItem === item.id}
                          title="Remove step"
                          aria-label={`Remove ${item.text}`}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                    {expanded ? (
                      <div className="subtask-updates">
                        <StatusPill status={item.status} compact />
                        {readOnly ? null : (
                          <div className="update-composer compact">
                            <input
                              className="input"
                              value={itemUpdateText[item.id] || ""}
                              onChange={(event) =>
                                setItemUpdateText((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  postItemUpdate(item);
                                }
                              }}
                              placeholder="Update this subtask…"
                              maxLength={4000}
                              aria-label={`Update ${item.text}`}
                            />
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => postItemUpdate(item)}
                              disabled={!String(itemUpdateText[item.id] || "").trim() || postingItem === item.id}
                              title="Post subtask update"
                            >
                              {postingItem === item.id ? (
                                <Loader2 size={12} className="spin" />
                              ) : (
                                <Send size={12} />
                              )}
                            </button>
                          </div>
                        )}
                        <UpdateFeed
                          updates={item.updates || []}
                          limit={4}
                          empty="No updates for this subtask yet."
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {readOnly ? null : (
                <div className="checklist-add">
                <input
                  ref={checklistRef}
                  className="input"
                  value={checklistText}
                  onChange={(event) => setChecklistText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addChecklist();
                    }
                  }}
                  placeholder="Add a step…"
                  maxLength={500}
                  aria-label="New checklist item"
                />
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={addChecklist}
                  disabled={!checklistText.trim()}
                >
                  <Plus size={13} />
                </button>
              </div>
              )}
            </div>
          </div>
        </div>

        <div className="field update-section">
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={13} /> Status updates
            {cardUpdates.length ? <span className="badge">{cardUpdates.length}</span> : null}
            {cardStale ? (
              <span className="badge badge-gold">Needs update</span>
            ) : card.lastUpdateAt ? (
              <span className="hint" style={{ marginLeft: "auto" }}>
                last {formatRelative(card.lastUpdateAt)}
              </span>
            ) : null}
          </label>
          {readOnly ? null : (
            <div className="update-composer">
              <textarea
                className="textarea"
                rows={2}
                value={updateText}
                onChange={(event) => setUpdateText(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    postUpdate();
                  }
                }}
                placeholder="What changed? Any blockers, decisions, or next step?"
                maxLength={4000}
                disabled={postingUpdate}
                aria-label="New card status update"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={postUpdate}
                disabled={!updateText.trim() || postingUpdate}
              >
                {postingUpdate ? <Loader2 size={13} className="spin" /> : <Send size={13} />}
                {postingUpdate ? "Posting…" : "Post update"}
              </button>
            </div>
          )}
          <UpdateFeed
            updates={cardUpdates}
            limit={12}
            empty="No status updates yet. Post the first one to start the task history."
          />
        </div>

        <div className="hint" style={{ display: "flex", gap: 14, flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
          <span>
            <Calendar size={11} style={{ verticalAlign: -1 }} /> Created {formatDateTime(card.createdAt)}
          </span>
          <span>
            <CheckSquare size={11} style={{ verticalAlign: -1 }} /> Updated {formatDateTime(card.updatedAt)}
          </span>
          <span className="mono" style={{ marginLeft: "auto" }}>
            {card.id.slice(0, 8)}
          </span>
        </div>
      </div>
    </Modal>
  );
}
