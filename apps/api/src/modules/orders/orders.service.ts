import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { assertRfqNotConfirmed } from "../../common/rfq-guards.js";

@Injectable()
export class OrdersService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Confirm an RFQ into an order. Only items with a winning quote are confirmed. The order REUSES
   * the RFQ's order_number (it persists through the whole lifecycle). order_item ↔ rfq_item is 1:1
   * (DB-enforced), so an RFQ can be confirmed only once.
   */
  async confirm(ctx: RlsContext, rfqId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(
          sql`select id, order_number, environment from rfqs where id = ${rfqId}::uuid limit 1`,
        )) as Array<{ id: string; order_number: string; environment: "live" | "sandbox" }>
      )[0];
      if (!rfq) throw new NotFoundException("RFQ not found in this workspace");

      await assertRfqNotConfirmed(tx, rfqId);

      const winners = (await tx.execute(sql`
        select id, part_number, quantity, winning_vendor_quote_item_id
        from rfq_items
        where rfq_id = ${rfqId}::uuid and winning_vendor_quote_item_id is not null`)) as Array<{
        id: string;
        part_number: string | null;
        quantity: number;
        winning_vendor_quote_item_id: string;
      }>;
      if (winners.length === 0) {
        throw new BadRequestException("no priced items to confirm (select a winning quote first)");
      }

      const confirmedStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'confirmed' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const [order] = await tx
        .insert(schema.orders)
        .values({
          tenantId: ctx.tenantId!,
          environment: rfq.environment, // order inherits the RFQ's environment
          rfqId,
          orderNumber: rfq.order_number, // persists from the RFQ
          statusId: confirmedStatusId,
        })
        .returning({ id: schema.orders.id });

      await tx.insert(schema.orderItems).values(
        winners.map((w) => ({
          tenantId: ctx.tenantId!,
          orderId: order.id,
          rfqItemId: w.id,
          finalPartNumber: w.part_number,
          approvedQty: w.quantity,
          winningVendorQuoteItemId: w.winning_vendor_quote_item_id,
          statusId: confirmedStatusId,
        })),
      );

      await tx.execute(
        sql`update rfqs set status_id = ${confirmedStatusId} where id = ${rfqId}::uuid`,
      );
      await tx.execute(sql`
        update rfq_items set status_id = ${confirmedStatusId}
        where rfq_id = ${rfqId}::uuid and winning_vendor_quote_item_id is not null`);
      // advance the WINNING vendors' invitation to 'confirmed' (vendor-portal 'won' KPI + queue state)
      await tx.execute(sql`
        update rfq_vendors set status_id = (select id from vendor_statuses where code = 'confirmed'), updated_at = now()
        where id in (
          select distinct vi.rfq_vendor_id from rfq_vendor_items vi
          where vi.id in (select winning_vendor_quote_item_id from rfq_items
                          where rfq_id = ${rfqId}::uuid and winning_vendor_quote_item_id is not null))`);

      return { orderId: order.id, orderNumber: rfq.order_number, confirmedItems: winners.length };
    });
  }

  async list(ctx: RlsContext) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select o.id, o.order_number, s.label_en as status,
               (select count(*)::int from order_items oi where oi.order_id = o.id) as items
        from orders o
        left join item_statuses s on s.id = o.status_id
        where o.environment = ${ctx.environment ?? "live"}
        order by o.created_at desc limit 50`),
    );
    return { count: rows.length, orders: rows };
  }
}
