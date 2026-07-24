import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";

/** Reject any mutation on an RFQ that has already been confirmed into an order (shared guard). */
export async function assertRfqNotConfirmed(tx: Tx, rfqId: string, message = "RFQ already confirmed"): Promise<void> {
  const confirmed = (await tx.execute(sql`select id from orders where rfq_id = ${rfqId}::uuid limit 1`))[0];
  if (confirmed) throw new BadRequestException(message);
}
