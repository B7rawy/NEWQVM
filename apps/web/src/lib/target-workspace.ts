import { useCallback, useEffect, useState } from "react";
import { auth } from "./api";

/**
 * The workspace an ADMIN SCREEN is acting on, which is deliberately NOT the app's active workspace.
 *
 * Switching the app into a workspace changes everything — sidebar, persona, subdomain — which is
 * right when you are working INSIDE that workspace, and wrong when you are a super admin configuring
 * several of them in one sitting. So screens like the flow builder pick a TARGET and stay put.
 *
 * Kept in localStorage (not a cookie) on purpose: it is a UI preference for this browser, not part
 * of the session, and it must never influence a normal request. Only screens that opt in read it.
 */
const KEY = "qvm_admin_target_ws";

export function getTargetWorkspace(): string | null {
  try {
    return localStorage.getItem(KEY) || auth.workspace();
  } catch {
    return auth.workspace();
  }
}

/** Target workspace + setter, shared across the admin screens that opt into targeting. */
export function useTargetWorkspace() {
  const [target, setTarget] = useState<string | null>(() => getTargetWorkspace());

  // keep two tabs (or the list page and the canvas) in agreement
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setTarget(e.newValue || auth.workspace());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const choose = useCallback((slug: string | null) => {
    try {
      if (slug) localStorage.setItem(KEY, slug);
      else localStorage.removeItem(KEY);
    } catch {
      /* private mode — the in-memory value still works for this page */
    }
    setTarget(slug);
  }, []);

  return { target, choose };
}
