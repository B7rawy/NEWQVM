import { useEffect, useState } from "react";

/**
 * How many inbound messages are waiting on this workspace.
 *
 * THE COUNT IS ZERO TODAY, AND THAT IS NOT A BUG. Nothing is connected: `notification_log` records
 * OUTBOUND send attempts only, there is no inbound message table, and no concept of read/unread
 * anywhere in the schema. A badge showing an invented number on a button that opens an empty portal
 * would be worse than no badge — the first thing anyone does with an unread count is trust it.
 *
 * WIRING IT UP LATER IS A ONE-FUNCTION CHANGE. When inbound messaging lands, replace the body with
 * a poll against the real endpoint. Everything that renders the badge already handles a live number,
 * including hiding itself at zero and capping the display at 99+.
 *
 *   const r = await api.get<{ unread: number }>("/communications/unread");
 *   setCount(r.unread);
 */
/**
 * ⚠️ PLACEHOLDER — A COSMETIC NUMBER, NOT A REAL COUNT.
 *
 * Set so the badge can be seen while the portal is being designed. It corresponds to nothing: there
 * are no inbound messages to be unread. DELETE THIS and return the real count the moment messaging
 * is wired — a fake unread badge that outlives its purpose teaches people to ignore the real one.
 */
const DEMO_UNREAD = 3;

export function useUnreadMessages(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(DEMO_UNREAD);
  }, []);

  return count;
}

/** 0 renders nothing; anything past 99 stops growing the pill. */
export function unreadLabel(n: number): string | null {
  if (n <= 0) return null;
  return n > 99 ? "99+" : String(n);
}
