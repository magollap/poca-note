import { Activity } from "lucide-react";
import { formatRelative, statusMeta } from "../lib/format";

export function StatusPill({ status, compact = false }) {
  const meta = statusMeta(status);
  return (
    <span
      className={`status-pill ${meta.className}${compact ? " compact" : ""}`}
      title={`Status: ${meta.label}`}
    >
      <span className="status-dot" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function UpdateFeed({ updates = [], limit = 8, empty = "No status updates yet." }) {
  if (!updates.length) {
    return <span className="hint update-empty">{empty}</span>;
  }
  return (
    <ol className="update-feed">
      {updates.slice(0, limit).map((update) => {
        const label = update.kind === "status" ? statusMeta(update.status).label : "";
        return (
          <li className="update-entry" key={update.id}>
            <span className={`update-marker ${update.kind === "status" ? statusMeta(update.status).className : ""}`}>
              <Activity size={10} />
            </span>
            <div className="update-copy">
              <div className="update-head">
                {update.kind === "status" ? (
                  <StatusPill status={update.status} compact />
                ) : (
                  <span className="badge">Update</span>
                )}
                <span className="update-author">{update.author || "Someone"}</span>
                <span className="update-time" title={label}>
                  {formatRelative(update.createdAt)}
                </span>
              </div>
              {update.body ? <p className="update-body">{update.body}</p> : null}
            </div>
          </li>
        );
      })}
      {updates.length > limit ? (
        <li className="update-more">
          Showing the latest {limit} of {updates.length} updates.
        </li>
      ) : null}
    </ol>
  );
}
