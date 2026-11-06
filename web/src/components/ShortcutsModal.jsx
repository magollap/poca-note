import { Keyboard } from "lucide-react";
import Modal from "./Modal";

const GROUPS = [
  {
    title: "Move around",
    rows: [
      [["j"], "Next card"],
      [["k"], "Previous card"],
      [["h"], "Previous column"],
      [["l"], "Next column"],
      [["Enter"], "Open selected card"],
      [["Esc"], "Close panel / card"],
    ],
  },
  {
    title: "Act",
    rows: [
      [["n"], "Focus quick capture"],
      [["/"], "Focus filter"],
      [["1"], "Move card to To Do"],
      [["2"], "Move card to Doing"],
      [["3"], "Move card to Under Review"],
      [["4"], "Move card to Done"],
      [["c"], "Complete selected card"],
      [["d"], "Move card to trash"],
      [["t"], "Open trash"],
      [["b"], "Daily brief & reports"],
      [["g"], "Generate the brief"],
      [["s"], "Workspace settings"],
      [["u"], "Status check-in"],
      [["?"], "Show shortcuts"],
    ],
  },
  {
    title: "While editing",
    rows: [
      [["⌘", "↵"], "Save card / generate"],
      [["Esc"], "Discard prompt, then close"],
      [["↵"], "Add checklist step"],
    ],
  },
];

export default function ShortcutsModal({ onClose }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="poca-note is designed to be driven from the keyboard."
      onClose={onClose}
      icon={<Keyboard size={16} className="muted" />}
      footer={
        <>
          <span className="hint">Tip: press ? anywhere on the board.</span>
          <span className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            Got it
          </button>
        </>
      }
    >
      <div className="modal-body">
        {GROUPS.map((group) => (
          <div key={group.title}>
            <div className="field-label" style={{ marginBottom: 8 }}>
              {group.title}
            </div>
            <div className="shortcut-grid">
              {group.rows.map(([keys, label]) => (
                <div className="shortcut-row" key={`${group.title}-${label}`}>
                  <span className="keys">
                    {keys.map((key) => (
                      <kbd className="kbd" key={key} style={{ minWidth: 22, height: 21 }}>
                        {key}
                      </kbd>
                    ))}
                  </span>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
