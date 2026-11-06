import {
  AlignLeft,
  Calendar,
  CheckSquare,
  ExternalLink,
  GripVertical,
  Link2,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  checklistProgress,
  cardNeedsUpdate,
  formatDue,
  isOverdue,
  shortHost,
  statusMeta,
  truncate,
} from "../lib/format";

export default function Card({
  card,
  selected,
  onSelect,
  onOpen,
  onDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragging,
  dropMarker,
  readOnly = false,
  updateIntervalDays = 3,
}) {
  const progress = checklistProgress(card.checklist);
  const overdue = isOverdue(card.dueDate, card.column);
  const dueLabel = formatDue(card.dueDate);
  const stale = cardNeedsUpdate(card, updateIntervalDays);
  const status = statusMeta(card.status);

  const dropClass = dropMarker?.cardId === card.id ? (dropMarker.after ? "drop-after" : "drop-before") : "";

  return (
    <article
      className={[
        "card",
        `priority-${card.priority || "normal"}`,
        card.column === "done" ? "done" : "",
        selected ? "selected" : "",
        dragging ? "dragging" : "",
        dropClass,
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={!readOnly}
      tabIndex={0}
      onFocus={onSelect}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen();
        }
      }}
      onDragStart={readOnly ? undefined : (event) => onDragStart(event, card)}
      onDragEnd={readOnly ? undefined : onDragEnd}
      onDragOver={readOnly ? undefined : (event) => onDragOver(event, card)}
      onDrop={readOnly ? undefined : (event) => onDrop(event, card)}
      aria-label={`${card.title} in ${card.column}`}
      aria-selected={selected}
    >
      <div className="card-top">
        {readOnly ? null : (
          <button
            className="card-handle"
            tabIndex={-1}
            aria-hidden="true"
            title="Drag to reorder"
            onClick={(event) => event.preventDefault()}
          >
            <GripVertical size={14} />
          </button>
        )}
        <div className="card-title">{card.title}</div>
      </div>

      {readOnly ? null : (
        <div className="card-actions">
          <button
            className="icon-btn"
            title="Open card (Enter)"
            aria-label="Open card"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
          >
            <Pencil size={12} />
          </button>
          <button
            className="icon-btn"
            title="Move to trash (D)"
            aria-label="Move card to trash"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}

      {card.notes ? <p className="card-note">{truncate(card.notes, 150)}</p> : null}

      <div className="card-meta">
        {card.taskNo ? (
          <span className="chip task-no" title={`Task ${card.taskNo} — reference it in AI Actions`}>
            Task {card.taskNo}
          </span>
        ) : null}

        <span
          className={`chip status-chip ${status.className}`}
          title={`Status: ${status.label}${card.lastUpdateAt ? ` · last update ${new Date(card.lastUpdateAt).toLocaleString()}` : ""}`}
        >
          <span className="status-dot" aria-hidden="true" />
          {status.label}
        </span>

        {stale ? (
          <span className="chip gold" title={`No status update in ${updateIntervalDays} days`}>
            Needs update
          </span>
        ) : null}

        {card.dueDate ? (
          <span className={`chip ${overdue ? "overdue" : ""}`} title={`Due ${card.dueDate}`}>
            <Calendar size={10} /> {dueLabel}
          </span>
        ) : null}

        {card.linkUrl ? (
          <a
            className="chip link"
            href={card.linkUrl}
            target="_blank"
            rel="noreferrer noopener"
            title={card.linkTitle || card.linkUrl}
            onClick={(event) => event.stopPropagation()}
          >
            <Link2 size={10} />
            <span>{card.linkTitle || shortHost(card.linkUrl)}</span>
            <ExternalLink size={9} />
          </a>
        ) : null}

        {progress.total > 0 ? (
          <span className="chip" title={`${progress.done} of ${progress.total} checklist items done`}>
            <CheckSquare size={10} /> {progress.done}/{progress.total}
            <span className="progress">
              <span style={{ width: `${progress.percent}%` }} />
            </span>
          </span>
        ) : null}

        {card.notes ? (
          <span className="chip" title="Has notes">
            <AlignLeft size={10} />
          </span>
        ) : null}

        {card.priority === "high" ? <span className="chip gold">High</span> : null}
      </div>
    </article>
  );
}
