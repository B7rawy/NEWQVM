import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "qvm_theme";

/** Resolve the theme that should apply now: explicit choice wins, else the OS preference. */
export function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY) as Theme | null;
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* ignore */
  }
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the theme to <html> and persist the choice. */
export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}

/** Small hook: current theme + a toggler. Syncs the class on mount in case the pre-paint script missed. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : resolveTheme(),
  );
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
