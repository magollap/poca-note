import { useEffect, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import Card from "./Card";
import { COLUMN_LABEL, COLUMNS, matchesQuery, sortCards } from "../lib/format";

function ColumnComposer({ column, onCreate, onClose }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async () => {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await onCreate(title, column);
      setValue("");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="capture"
      style={{ margin: 0, padding: "4px 4px 4px 10px" }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        placeholder={`New ${COLUMN_LABEL[column] || "To Do"} card…`}
        maxLength={500}
        aria-label="New card title"
      />
      <button className="icon-btn" type="submit" disabled={!value.trim() || busy} title="Add card" aria-label="Add card">
        <Check size={15} />
      </button>
      <button className="icon-btn" type="button" onClick={onClose} title="Cancel" aria-label="Cancel">
        <X size={15} />
      </button>
    </form>
  );
}

export default function Board({
  cards,
  query,
  selectedId,
  onSelect,
  onOpen,
  onDelete,
  onMove,
  onCreate,
  readOnly = false,
  updateIntervalDays = 3,
}) {
  const [draggingId, setDraggingId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [composerColumn, setComposerColumn] = useState(null);
  const dragRef = useRef(null);

  const search = query.trim().toLowerCase();
  const visible = cards.filter((card) => matchesQuery(card, query));
  const totalVisible = visible.length;

  const computePosition = (column, cardId, after) => {
    const list = cards
      .filter((card) => card.column === column && card.id !== dragRef.current)
      .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    let index = cardId ? list.findIndex((card) => card.id === cardId) : list.length;
    if (index < 0) index = list.length;
    if (after) index += 1;
    const previous = list[index - 1]?.position;
    const next = list[index]?.position;
    if (previous == null && next == null) return 1000;
    if (previous == null) return next - 1000;
    if (next == null) return previous + 1000;
    return (previous + next) / 2;
  };

  const beginDrag = (event, card) => {
    dragRef.current = card.id;
    setDraggingId(card.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.id);
    onSelect(card.id);
  };

  const endDrag = () => {
    dragRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  };

  const overCard = (event, card) => {
    if (!dragRef.current || card.id === dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    setDropTarget({ column: card.column, cardId: card.id, after });
  };

  const dropOnCard = (event, card) => {
    event.preventDefault();
    event.stopPropagation();
    if (!dragRef.current || card.id === dragRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const position = computePosition(card.column, card.id, after);
    const id = dragRef.current;
    endDrag();
    onMove(id, card.column, position);
  };

  const dropOnColumn = (event, column) => {
    event.preventDefault();
    if (!dragRef.current) return;
    const position = computePosition(column, null, false);
    const id = dragRef.current;
    endDrag();
    onMove(id, column, position);
  };

  return (
    <div className="board" aria-label="Kanban board">
      {COLUMNS.map((column) => {
        const columnCards = sortCards(visible, column.key);
        const allCount = cards.filter((card) => card.column === column.key).length;
        const isTarget = dropTarget?.column === column.key;
        return (
          <section
            key={column.key}
            className={`column column-${column.key} ${isTarget ? "drop-active" : ""}`}
            onDragOver={(event) => {
              if (!dragRef.current) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (!isTarget) setDropTarget({ column: column.key, cardId: null, after: false });
            }}
            onDrop={(event) => dropOnColumn(event, column.key)}
            aria-label={`${column.label} column`}
          >
            <header className="column-head">
              <span className={`column-dot ${column.dot}`} />
              <span className="column-name">{column.label}</span>
              <span className="column-count">
                {search ? `${columnCards.length}/${allCount}` : allCount}
              </span>
              <span className="spacer" />
              {readOnly ? null : (
                <button
                  className="icon-btn"
                  onClick={() => setComposerColumn(column.key)}
                  title={`Add to ${column.label}`}
                  aria-label={`Add card to ${column.label}`}
                  style={{ width: 26, height: 26 }}
                >
                  <Plus size={15} />
                </button>
              )}
            </header>

            <div className="column-body">
              {columnCards.map((card) => (
                <Card
                  key={card.id}
                  card={card}
                  selected={selectedId === card.id}
                  dragging={draggingId === card.id}
                  dropMarker={dropTarget?.column === column.key ? dropTarget : null}
                  onSelect={() => onSelect(card.id)}
                  onOpen={() => onOpen(card.id)}
                  onDelete={() => onDelete(card.id)}
                  onDragStart={beginDrag}
                  onDragEnd={endDrag}
                  onDragOver={overCard}
                  onDrop={dropOnCard}
                  readOnly={readOnly}
                  updateIntervalDays={updateIntervalDays}
                />
              ))}

              {columnCards.length === 0 && composerColumn !== column.key ? (
                <div className="column-empty">
                  {search
                    ? "No matching cards"
                    : column.key === "done"
                      ? "Completed work lands here"
                      : column.key === "review"
                        ? "Nothing waiting for review"
                        : "Nothing here yet"}
                </div>
              ) : null}

              {composerColumn === column.key && !readOnly ? (
                <ColumnComposer
                  column={column.key}
                  onCreate={onCreate}
                  onClose={() => setComposerColumn(null)}
                />
              ) : null}

              <div className="column-dropzone" aria-hidden="true" />
            </div>

            <footer className="column-foot">
              <span>
                {allCount} card{allCount === 1 ? "" : "s"}
              </span>
              <span>{search ? `${totalVisible} shown` : readOnly ? "read-only" : "drag to reorder"}</span>
            </footer>
          </section>
        );
      })}
    </div>
  );
}
