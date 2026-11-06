import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "poca-note:theme";
const listeners = new Set();

function preferredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // storage can be unavailable
  }
  return "dark";
}

let current = preferredTheme();

function apply(theme) {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
}

apply(current);

export function setTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  if (next === current) return;
  current = next;
  apply(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage can be unavailable
  }
  for (const listener of listeners) listener(next);
}

export function useTheme() {
  const [theme, setThemeState] = useState(current);

  useEffect(() => {
    const listener = (next) => setThemeState(next);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, []);

  const toggle = useCallback(() => {
    setTheme(current === "dark" ? "light" : "dark");
  }, []);

  return { theme, setTheme, toggle };
}
