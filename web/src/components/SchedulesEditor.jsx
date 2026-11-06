import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Clock, Loader2, Plus, Trash2 } from "lucide-react";
import { api } from "../api";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const KIND_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/**
 * Multiple report schedules per workspace. Every change is saved immediately
 * through the schedules API so the list is always the source of truth.
 */
export default function SchedulesEditor({ toasts, onChanged, readOnly = false }) {
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const data = await api("/api/reports/schedules");
    setSchedules(data.schedules || []);
    return data.schedules || [];
  }, []);

  useEffect(() => {
    let active = true;
    api("/api/reports/schedules")
      .then((data) => {
        if (active) setSchedules(data.schedules || []);
      })
      .catch((err) => {
        if (active) setError(err.message || "Could not load schedules.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const patch = async (schedule, values) => {
    if (readOnly) return;
    setBusy(true);
    setError("");
    try {
      const data = await api(`/api/reports/schedules/${schedule.id}`, {
        method: "PATCH",
        body: values,
      });
      setSchedules(data.schedules || []);
      onChanged?.();
    } catch (err) {
      setError(err.message || "Could not save that schedule.");
      toasts?.error?.(err.message || "Could not save that schedule.");
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (readOnly) return;
    setBusy(true);
    setError("");
    try {
      const timezone = schedules[0]?.timezone || "UTC";
      await api("/api/reports/schedules", {
        method: "POST",
        body: { kind: "daily", time: "09:00", timezone, label: "" },
      });
      await load();
      onChanged?.();
      toasts?.success?.("Schedule added.");
    } catch (err) {
      setError(err.message || "Could not add a schedule.");
      toasts?.error?.(err.message || "Could not add a schedule.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (schedule) => {
    if (readOnly || schedules.length <= 1) return;
    setBusy(true);
    setError("");
    try {
      const data = await api(`/api/reports/schedules/${schedule.id}`, { method: "DELETE" });
      setSchedules(data.schedules || []);
      onChanged?.();
      toasts?.success?.("Schedule removed.");
    } catch (err) {
      setError(err.message || "Could not remove that schedule.");
      toasts?.error?.(err.message || "Could not remove that schedule.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="schedules-loading">
        <Loader2 size={15} className="spin" /> Loading schedules…
      </div>
    );
  }

  return (
    <div className="schedules">
      <div className="schedules-list">
        {schedules.map((schedule) => (
          <div className="schedule-row" key={schedule.id}>
            <label className="switch" title={schedule.enabled ? "Pause this schedule" : "Enable this schedule"}>
              <input
                type="checkbox"
                checked={schedule.enabled}
                disabled={readOnly}
                onChange={(event) => patch(schedule, { enabled: event.target.checked })}
              />
            </label>

            <select
              className="select schedule-kind"
              value={schedule.kind}
              disabled={readOnly}
              onChange={(event) => patch(schedule, { kind: event.target.value })}
              aria-label="Schedule frequency"
            >
              {Object.entries(KIND_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            {schedule.kind === "weekly" ? (
              <select
                className="select"
                value={schedule.weekday}
                disabled={readOnly}
                onChange={(event) => patch(schedule, { weekday: Number(event.target.value) })}
                aria-label="Weekly schedule day"
              >
                {WEEKDAYS.map((day) => (
                  <option key={day.value} value={day.value}>
                    {day.label}
                  </option>
                ))}
              </select>
            ) : null}

            {schedule.kind === "monthly" ? (
              <select
                className="select"
                value={schedule.dayOfMonth}
                disabled={readOnly}
                onChange={(event) => patch(schedule, { dayOfMonth: Number(event.target.value) })}
                aria-label="Monthly schedule day"
              >
                {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                  <option key={day} value={day}>
                    Day {day}
                  </option>
                ))}
              </select>
            ) : null}

            <div className="schedule-time">
              <Clock size={12} />
              <input
                className="input"
                type="time"
                value={schedule.time}
                disabled={readOnly}
                onChange={(event) => patch(schedule, { time: event.target.value })}
                aria-label={`${KIND_LABEL[schedule.kind]} schedule time`}
              />
            </div>

            <input
              className="input schedule-label"
              value={schedule.label}
              placeholder="Label (optional)"
              maxLength={60}
              disabled={readOnly}
              onChange={(event) =>
                setSchedules((current) =>
                  current.map((row) =>
                    row.id === schedule.id ? { ...row, label: event.target.value } : row
                  )
                )
              }
              onBlur={(event) => {
                patch(schedule, { label: event.target.value });
              }}
              aria-label="Schedule label"
            />

            {readOnly ? null : (
              <button
                type="button"
                className="icon-btn"
                onClick={() => remove(schedule)}
                disabled={schedules.length <= 1 || busy}
                title={schedules.length <= 1 ? "Keep at least one schedule" : "Remove schedule"}
                aria-label="Remove schedule"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="schedules-foot">
        <span className="hint">
          <CalendarDays size={11} style={{ verticalAlign: -1 }} /> Weekly reports cover the previous 7 days;
          monthly reports cover the previous calendar month.
        </span>
        <span className="spacer" />
        {readOnly ? (
          <span className="badge badge-gold">Read-only · observers cannot edit schedules</span>
        ) : (
          <button className="btn btn-sm" type="button" onClick={add} disabled={busy}>
            {busy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} Add schedule
          </button>
        )}
      </div>
      {error ? <span className="hint" style={{ color: "var(--red)" }}>{error}</span> : null}
    </div>
  );
}
