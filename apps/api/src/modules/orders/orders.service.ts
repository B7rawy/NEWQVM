import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { queuePredicate } from "../workflow/routing.js";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { assertRfqNotConfirmed } from "../../common/rfq-guards.js";
import { assertEnvironment, envOf } from "../../common/env-guards.js";
import { StatusService } from "../../common/status.service.js";

@Injectable()
export class OrdersService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

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
      // a Live RFQ may not be confirmed from a Sandbox session, nor the reverse (ADR-0012)
      assertEnvironment(ctx, rfq, "RFQ");

      await assertRfqNotConfirmed(tx, rfqId);

      const winners = (await tx.execute(sql`
        select i.id, i.part_number, i.quantity, i.winning_vendor_quote_item_id, s.code as status
        from rfq_items i left join item_statuses s on s.id = i.status_id
        where i.rfq_id = ${rfqId}::uuid and i.winning_vendor_quote_item_id is not null`)) as Array<{
        id: string;
        part_number: string | null;
        quantity: number;
        winning_vendor_quote_item_id: string;
        status: string | null;
      }>;
      if (winners.length === 0) {
        throw new BadRequestException("no priced items to confirm (select a winning quote first)");
      }

      /**
       * PRE-APPROVAL STATE CHECK. Having a winning quote is NOT sufficient to be confirmable: the
       * winner id survives a later status change, so without this a cancelled item still became a
       * real order line (proven 2026-07-25 — the item was at 'cancelled' and confirm returned 201).
       *
       * `priced` is what selectWinner() sets, and the insurance flow moves only the RFQ HEADER, so
       * items legitimately sit at `priced` right up to confirmation. Fail CLOSED and name the offender
       * rather than silently skipping it — skipping would confirm a partial order and look successful.
       * When flows land (QNEW-64), this reads the flow's declared pre-approval status instead.
       */
      const notPriced = winners.filter((w) => w.status !== "priced");
      if (notPriced.length > 0) {
        throw new BadRequestException(
          `cannot confirm: ${notPriced.length} item(s) carry a winning quote but are not at 'priced' ` +
            `(${notPriced.map((w) => `${w.part_number ?? w.id}: ${w.status ?? "no status"}`).join(", ")})`,
        );
      }

      // The order and its lines are inserted with NO status: an order is BORN at 'confirmed', which
      // makes that an entry event, and entry is written by the status gateway below (QNEW-90 item 7).
      // Until now this was the second place a record's first status appeared from nowhere — no
      // status_logs row for it, and an order bound to a flow version only from its second status on.
      const [order] = await tx
        .insert(schema.orders)
        .values({
          tenantId: ctx.tenantId!,
          environment: rfq.environment, // order inherits the RFQ's environment
          rfqId,
          orderNumber: rfq.order_number, // persists from the RFQ
        })
        .returning({ id: schema.orders.id });

      const orderItems = await tx
        .insert(schema.orderItems)
        .values(
          winners.map((w) => ({
            tenantId: ctx.tenantId!,
            environment: rfq.environment, // a line always lives in the same environment as its order
            orderId: order.id,
            rfqItemId: w.id,
            finalPartNumber: w.part_number,
            approvedQty: w.quantity,
            winningVendorQuoteItemId: w.winning_vendor_quote_item_id,
          })),
        )
        .returning({ id: schema.orderItems.id });

      // Lines before the header, for the reason spelled out in RfqService.create(): an arrow out of
      // 'confirmed' may be gated on every line having reached a status, and the header's entry runs
      // that check.
      await this.status.enterMany(tx, ctx, {
        entity: "order_item",
        ids: orderItems.map((oi) => oi.id),
        toCode: "confirmed",
      });
      await this.status.enter(tx, ctx, { entity: "order", id: order.id, toCode: "confirmed" });

      // every status move goes through the single entry point, so each one lands in status_logs
      // with its from/to and the acting user (QNEW-75)
      await this.status.transition(tx, ctx, { entity: "rfq", id: rfqId, toCode: "confirmed" });
      await this.status.transitionMany(tx, ctx, {
        entity: "rfq_item",
        ids: winners.map((w) => w.id),
        toCode: "confirmed",
      });
      // advance the WINNING vendors' invitation to 'confirmed' (vendor-portal 'won' KPI + queue state)
      const wonVendorIds = (await tx.execute(sql`
        select distinct vi.rfq_vendor_id as id from rfq_vendor_items vi
        where vi.id in (select winning_vendor_quote_item_id from rfq_items
                        where rfq_id = ${rfqId}::uuid and winning_vendor_quote_item_id is not null)`)) as Array<{ id: string }>;
      await this.status.transitionMany(tx, ctx, {
        entity: "rfq_vendor",
        ids: wonVendorIds.map((v) => v.id),
        toCode: "confirmed",
      });

      return { orderId: order.id, orderNumber: rfq.order_number, confirmedItems: winners.length };
    });
  }

  async list(ctx: RlsContext, queue?: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select o.id, o.order_number, s.label_en as status,
               (select count(*)::int from order_items oi where oi.order_id = o.id) as items
        from orders o
        left join item_statuses s on s.id = o.status_id
        where o.environment = ${ctx.environment ?? "live"}
          and ${queuePredicate(sql`s.code`, queue)}
        order by o.created_at desc limit 50`),
    );
    return { count: rows.length, orders: rows };
  }
}
