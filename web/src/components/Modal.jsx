import { useEffect } from "react";
import { X } from "lucide-react";

export default function Modal({
  title,
  subtitle,
  icon,
  children,
  footer,
  onClose,
  size = "",
  drawer = false,
  labelledBy = "modal-title",
}) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className={`modal-backdrop ${drawer ? "drawer" : ""}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={drawer ? "drawer-panel" : `modal ${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          {icon}
          <div style={{ minWidth: 0 }}>
            <h2 id={labelledBy}>{title}</h2>
            {subtitle ? <p className="sub">{subtitle}</p> : null}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close" style={{ marginLeft: "auto" }}>
            <X size={16} />
          </button>
        </div>
        {children}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}
