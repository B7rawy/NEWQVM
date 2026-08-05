import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";
import { resolveCounterparty } from "./counterparty.helpers.js";

export type Persona = "platform" | "workspace" | "vendor" | "workshop" | "service_provider" | "internal";

/**
 * WHICH PORTAL THIS USER IS IN. One implementation, because /me and /nav must never disagree: the
 * app renders the tree /nav returns inside the shell /me chose, and a user who is 'workshop' to one
 * and 'vendor' to the other gets a sidebar that navigates nowhere.
 *
 * Order matters and is the pre-existing one — vendor beats workshop beats provider — so that a
 * person who is somehow attached to two counterparties lands somewhere deterministic rather than
 * somewhere that depends on row order.
 *
 * internal is a service provider whose scope is 'internal'; it is a portal, not a fourth entity.
 */
export async function resolvePersona(
  tx: Tx,
  userId: string | null,
  isInternal: boolean,
): Promise<{ persona: Persona; providerScope: string | null }> {
  if (isInternal) return { persona: "platform", providerScope: null };
  const cp = await resolveCounterparty(tx, userId);
  if (!cp) return { persona: "workspace", providerScope: null };
  if (cp.kind === "vendor") return { persona: "vendor", providerScope: null };
  if (cp.kind === "workshop") return { persona: "workshop", providerScope: null };
  const scope =
    ((await tx.execute(sql`
      select scope from service_providers where id = ${cp.entityId}::uuid limit 1`)) as Array<{ scope: string }>)[0]
      ?.scope ?? null;
  return { persona: scope === "internal" ? "internal" : "service_provider", providerScope: scope };
}
