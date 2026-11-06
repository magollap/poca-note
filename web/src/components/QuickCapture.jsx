import { useState } from "react";
import { CornerDownLeft, Plus } from "lucide-react";

export default function QuickCapture({ inputRef, onCreate }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (column) => {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const created = await onCreate(title, column);
      if (created !== null) {
        setValue("");
        inputRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="capture"
      onSubmit={(event) => {
        event.preventDefault();
        submit("todo");
      }}
    >
      <Plus className="capture-icon" size={17} />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit("doing");
          }
        }}
        placeholder="Capture a thought…"
        aria-label="Quick capture a card"
        autoComplete="off"
        maxLength={500}
        disabled={busy}
      />
      <span className="capture-hint">
        <span className="kbd">
          <CornerDownLeft size={10} />
        </span>
        To Do
        <span style={{ opacity: 0.5 }}>·</span>
        <span className="kbd">⌘</span>
        <span className="kbd">
          <CornerDownLeft size={10} />
        </span>
        Doing
      </span>
      <button className="btn btn-primary btn-sm" type="submit" disabled={!value.trim() || busy}>
        Add
      </button>
    </form>
  );
}
