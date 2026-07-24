import { ForbiddenException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";

/**
 * Resolve the signed-in user's counterparty identity (the ONE canonical lookup — previously
 * repeated five ways across me/account/vendor-portal/workshop-portal). Precedence: vendor before
 * workshop, matching /me's persona resolution.
 */
export async function resolveCounterparty(
  tx: Tx,
  userId: string | null,
): Promise<{ kind: "vendor" | "workshop"; entityId: string } | null> {
  const v = (await tx.execute(sql`select vendor_id as id from vendor_users where user_id = ${userId}::uuid limit 1`))[0] as
    | { id: string }
    | undefined;
  if (v) return { kind: "vendor", entityId: v.id };
  const w = (await tx.execute(sql`select workshop_id as id from workshop_users where user_id = ${userId}::uuid limit 1`))[0] as
    | { id: string }
    | undefined;
  if (w) return { kind: "workshop", entityId: w.id };
  return null;
}

/** resolveCounterparty + require a specific kind (403 otherwise). */
export async function requireCounterparty(tx: Tx, userId: string | null, kind: "vendor" | "workshop"): Promise<string> {
  const cp = await resolveCounterparty(tx, userId);
  if (!cp || cp.kind !== kind) throw new ForbiddenException(`not a ${kind} account`);
  return cp.entityId;
}
