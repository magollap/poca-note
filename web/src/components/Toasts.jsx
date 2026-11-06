import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

export default function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = icons[toast.type] || Info;
        return (
          <div key={toast.id} className={`toast ${toast.type}`}>
            <span className={`icon ${toast.type}`}>
              <Icon size={16} />
            </span>
            <div className="grow">{toast.message}</div>
            {toast.action ? (
              <button
                className="toast-action"
                onClick={() => {
                  toast.action.onClick?.();
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            ) : null}
            <button className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
