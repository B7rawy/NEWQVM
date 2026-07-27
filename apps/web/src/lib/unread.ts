import { useEffect, useState } from "react";
import { api, auth } from "./api";

/**
 * HOW MANY IN-APP NOTIFICATIONS ARE WAITING ON ME, RIGHT NOW.
 *
 * This used to return a hardcoded 3 under a comment admitting the number corresponded to nothing. It
 * now counts real rows. In-app notifications are written by this application and read back by it, so
 * they need no provider and the count can be true — WhatsApp and email are still not connected, and
 * the Communications page still says so, but this badge is about the channel that does deliver.
 *
 * ZERO IS A RESULT, NOT A FAILURE. Every path below that cannot produce a real number produces 0,
 * and `unreadLabel` renders nothing at 0. A badge that keeps a stale number after the inbox is
 * cleared, or invents one when the request fails, is the same lie the demo constant was.
 */

/**
 * Screens that CHANGE the count have to be able to say so. Polling alone would leave the badge
 * showing 4 for up to a minute after the inbox was emptied one click away in the same window — the
 * most visible way for this number to become untrustworthy all over again.
 */
const listeners = new Set<() => void>();

/** Call after marking anything read; every mounted badge re-counts against the server. */
export function refreshUnread(): void {
  for (const l of listeners) l();
}

export function useUnreadMessages(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let alive = true;

    async function tick() {
      // Notifications are scoped to a workspace, so with no session or no workspace resolved there
      // is nothing to count — and asking anyway would 400 on a loop for the whole session.
      if (!auth.token() || !auth.workspace()) {
        if (alive) setCount(0);
        return;
      }
      try {
        const r = await api.get<{ unread: number }>("/notifications/unread-count");
        if (alive) setCount(r.unread ?? 0);
      } catch {
        // Show nothing rather than the last number we happened to see: a badge that survives its own
        // failed refresh is asserting something it no longer knows.
        if (alive) setCount(0);
      }
    }

    listeners.add(tick);
    void tick();
    // A minute is short enough that a notification does not sit unseen for a working session, and
    // long enough that an idle tab is not a load generator.
    const timer = window.setInterval(tick, 60_000);
    // Returning to the tab is when the number is both most likely to be stale and most likely to be
    // read.
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive = false;
      listeners.delete(tick);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return count;
}

/** 0 renders nothing; anything past 99 stops growing the pill. */
export function unreadLabel(n: number): string | null {
  if (n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}
