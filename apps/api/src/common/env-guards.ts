import { NotFoundException } from "@nestjs/common";
import type { RlsContext } from "../db/db.service.js";

export type Environment = "live" | "sandbox";

/** The environment the caller is acting in. Absent → 'live', so a forgotten header can never
 *  silently widen access; it can only ever land you in the real environment you already had. */
export function envOf(ctx: Pick<RlsContext, "environment">): Environment {
  return ctx.environment ?? "live";
}

/**
 * Load-for-write guard (ADR-0012). Sandbox and Live are parallel universes: a record belonging to
 * the other one must behave as if it does not exist — NOT as "forbidden", because a 403 would
 * confirm the record's existence and let a sandbox session enumerate real document ids.
 *
 * Use this on EVERY mutation that resolves a parent document by id (confirm an RFQ, quote it,
 * invoice a PO, receive a delivery…). Reads are filtered by the environment predicate; writes are
 * guarded here, so the two directions can never drift apart.
 */
export function assertEnvironment<T extends { environment: Environment }>(
  ctx: Pick<RlsContext, "environment">,
  row: T | undefined | null,
  what: string,
): asserts row is T {
  // identical message for "missing" and "wrong environment" — the difference must not be observable
  if (!row || row.environment !== envOf(ctx)) throw new NotFoundException(`${what} not found in this workspace`);
}
