import { BadRequestException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";

/** Reject any mutation on an RFQ that has already been confirmed into an order (shared guard). */
export async function assertRfqNotConfirmed(tx: Tx, rfqId: string, message = "RFQ already confirmed"): Promise<void> {
  const confirmed = (await tx.execute(sql`select id from orders where rfq_id = ${rfqId}::uuid limit 1`))[0];
  if (confirmed) throw new BadRequestException(message);
}

/**
 * Per-ITEM successor to assertRfqNotConfirmed, for the partial-confirmation era: an RFQ is no
 * longer "confirmed or not" — individual lines are. Changing a winner after ITS line is on an
 * order would desynchronise the order snapshot, but other lines must stay workable.
 */
export async function assertItemNotOrdered(tx: Tx, rfqItemId: string, message = "this item is already on an order"): Promise<void> {
  const row = (await tx.execute(sql`select id from order_items where rfq_item_id = ${rfqItemId}::uuid limit 1`))[0];
  if (row) throw new BadRequestException(message);
}

/** A vendor can keep quoting as long as ANY line is still open (not ordered, not cancelled). */
export async function assertRfqHasOpenItems(tx: Tx, rfqId: string, message = "every line of this RFQ is already ordered or closed"): Promise<void> {
  const row = (await tx.execute(sql`
    select i.id from rfq_items i
    left join order_items oi on oi.rfq_item_id = i.id
    left join item_statuses s on s.id = i.status_id
    where i.rfq_id = ${rfqId}::uuid and oi.id is null
      and coalesce(s.code, '') not in ('cancelled', 'unavailable')
    limit 1`))[0];
  if (!row) throw new BadRequestException(message);
}
