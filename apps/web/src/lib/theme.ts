import { useEffect, useState } from "react";
import { getCookie, setSharedCookie } from "./tenant";

export type Theme = "light" | "dark";
const KEY = "qvm_theme";

/**
 * Resolve the theme: the saved choice wins (shared across subdomains via a cookie, so switching
 * workspace keeps it), otherwise the default is LIGHT. We deliberately do NOT follow the OS
 * dark-mode preference — light is the product default.
 */
export function resolveTheme(): Theme {
  const stored = getCookie(KEY) ?? safeLocal();
  return stored === "dark" ? "dark" : "light";
}
function safeLocal(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** Apply the theme to <html> and persist it in localStorage + a cross-subdomain cookie. */
export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  setSharedCookie(KEY, t);
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
