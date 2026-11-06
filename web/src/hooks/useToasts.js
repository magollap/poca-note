import { useCallback, useEffect, useRef, useState } from "react";

let counter = 0;

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    ({ type = "info", message, action, duration = 5000 }) => {
      counter += 1;
      const id = `toast-${counter}`;
      setToasts((current) => [...current.slice(-3), { id, type, message, action }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  const success = useCallback((message, options = {}) => push({ ...options, type: "success", message }), [push]);
  const error = useCallback((message, options = {}) => push({ ...options, type: "error", message }), [push]);
  const info = useCallback((message, options = {}) => push({ ...options, type: "info", message }), [push]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  return { toasts, push, dismiss, success, error, info };
}
