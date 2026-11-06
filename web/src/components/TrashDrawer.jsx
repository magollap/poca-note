import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2, X } from "lucide-react";
import Modal from "./Modal";
import { COLUMN_LABEL, formatRelative } from "../lib/format";

export default function TrashDrawer({ loadTrash, onRestore, onPurge, onEmpty, onClose, toasts }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let active = true;
    loadTrash()
      .then((cards) => {
        if (active) setItems(cards);
      })
      .catch((error) => toasts.error(error.message || "Could not load the trash."))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const restore = async (item) => {
    setBusy(item.id);
    try {
      await onRestore(item.id);
      setItems((current) => current.filter((card) => card.id !== item.id));
      toasts.success("Card restored. It is back on the board.");
    } catch (error) {
      toasts.error(error.message || "Could not restore that card.");
    } finally {
      setBusy(null);
    }
  };

  const purge = async (item) => {
    setBusy(item.id);
    try {
      await onPurge(item.id);
      setItems((current) => current.filter((card) => card.id !== item.id));
      setConfirmId(null);
      toasts.info("Card permanently deleted.");
    } catch (error) {
      toasts.error(error.message || "Could not delete that card.");
    } finally {
      setBusy(null);
    }
  };

  const empty = async () => {
    setBusy("all");
    try {
      await onEmpty();
      setItems([]);
      setConfirmEmpty(false);
      toasts.info("Trash emptied.");
    } catch (error) {
      toasts.error(error.message || "Could not empty the trash.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Trash"
      subtitle={`${items.length} deleted card${items.length === 1 ? "" : "s"} · restorable until you purge`}
      onClose={onClose}
      drawer
      icon={<Trash2 size={16} className="muted" />}
      footer={
        <>
          <span className="hint">Deleted cards stay restorable here.</span>
          <span className="spacer" />
          {confirmEmpty ? (
            <>
              <span className="hint" style={{ color: "var(--red)" }}>
                Permanently delete all?
              </span>
              <button className="btn btn-sm" onClick={() => setConfirmEmpty(false)}>
                Cancel
              </button>
              <button className="btn btn-danger btn-sm" onClick={empty} disabled={busy === "all"}>
                Empty trash
              </button>
            </>
          ) : (
            <button
              className="btn btn-sm"
              onClick={() => setConfirmEmpty(true)}
              disabled={items.length === 0}
            >
              <Trash2 size={13} /> Empty trash
            </button>
          )}
        </>
      }
    >
      <div className="modal-body">
        {loading ? (
          <div className="splash-inner" style={{ minHeight: 180 }}>
            <Loader2 size={20} className="spin" />
            Loading trash…
          </div>
        ) : items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 12px", color: "var(--faint)" }}>
            <Trash2 size={26} style={{ opacity: 0.45, marginBottom: 8 }} />
            <p>Trash is empty.</p>
            <p className="hint">Deleted cards wait here so mistakes are recoverable.</p>
          </div>
        ) : (
          <div className="list">
            {items.map((item) => (
              <div className="list-row" key={item.id}>
                <div className="grow">
                  <div className="title" style={{ textDecoration: "line-through", color: "var(--muted)" }}>
                    {item.title}
                  </div>
                  <div className="meta">
                    {COLUMN_LABEL[item.column] || item.column} · deleted {formatRelative(item.deletedAt)}
                    {item.checklist.length ? ` · ${item.checklist.length} checklist items` : ""}
                  </div>
                  {confirmId === item.id ? (
                    <div className="meta" style={{ color: "var(--red)", marginTop: 6 }}>
                      Permanently delete?{" "}
                      <button className="btn btn-danger btn-sm" onClick={() => purge(item)} disabled={busy === item.id}>
                        Yes, delete
                      </button>{" "}
                      <button className="btn btn-sm" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => restore(item)}
                  disabled={busy === item.id}
                  title="Restore card"
                >
                  <RotateCcw size={13} /> Restore
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setConfirmId(confirmId === item.id ? null : item.id)}
                  title="Delete permanently"
                  aria-label="Delete permanently"
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
