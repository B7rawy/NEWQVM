import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { queuePredicate } from "../workflow/routing.js";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { assertEnvironment, envOf } from "../../common/env-guards.js";
import { StatusService } from "../../common/status.service.js";

/** Optional cart body: which winners to confirm, and how many of each (the legacy cart). */
export interface ConfirmDto {
  items?: Array<{ rfqItemId: string; approvedQty?: number }>;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

  /**
   * Confirm an RFQ — or PART of one — into an order.
   *
   * THE CART SEMANTICS, ported from the legacy confirm_cart_items (docs/legacy/workshop-logic.md
   * §4): the caller may name which priced items to confirm and an approved quantity per line that
   * may be LESS than requested. Unnamed items stay exactly where they are ('priced'), and a later
   * batch confirms them into a NEW order — an order is "what was confirmed together", not the
   * request. With no body the whole set of priced winners confirms at once, which keeps every
   * existing caller's behaviour.
   *
   * Batch orders and numbering: the first order takes the RFQ's own order_number (it persists
   * through the lifecycle); later batches suffix it -B2, -B3 … because (tenant_id, order_number)
   * is UNIQUE and silently reusing the number would fail — visibly related, provably distinct.
   *
   * approved_qty is validated 1..requested. Legacy accepted MORE than requested (GREATEST(x,1)
   * with no cap) — that is a data-entry accident waiting to be billed, so here it is refused,
   * not clamped: a silent clamp would "succeed" at a different quantity than the one on screen.
   */
  async confirm(ctx: RlsContext, rfqId: string, dto?: ConfirmDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(
          sql`select id, order_number, environment from rfqs where id = ${rfqId}::uuid limit 1`,
        )) as Array<{ id: string; order_number: string; environment: "live" | "sandbox" }>
      )[0];
      // a Live RFQ may not be confirmed from a Sandbox session, nor the reverse (ADR-0012)
      assertEnvironment(ctx, rfq, "RFQ");

      const all = (await tx.execute(sql`
        select i.id, i.part_number, i.alternative_part_number, i.quantity,
               i.winning_vendor_quote_item_id, s.code as status,
               (oi.id is not null) as already_ordered
        from rfq_items i
        left join item_statuses s on s.id = i.status_id
        left join order_items oi on oi.rfq_item_id = i.id
        where i.rfq_id = ${rfqId}::uuid and i.winning_vendor_quote_item_id is not null`)) as Array<{
        id: string;
        part_number: string | null;
        alternative_part_number: string | null;
        quantity: number;
        winning_vendor_quote_item_id: string;
        status: string | null;
        already_ordered: boolean;
      }>;

      const requested = dto?.items?.length
        ? dto.items.map((sel) => {
            const w = all.find((x) => x.id === sel.rfqItemId);
            if (!w) throw new BadRequestException(`item ${sel.rfqItemId} has no winning quote on this RFQ`);
            if (w.already_ordered) throw new BadRequestException(`item ${w.part_number ?? w.id} is already on an order`);
            const qty = sel.approvedQty ?? w.quantity;
            if (qty < 1 || qty > w.quantity)
              throw new BadRequestException(
                `approved quantity for ${w.part_number ?? w.id} must be between 1 and the requested ${w.quantity}`,
              );
            return { ...w, approvedQty: qty };
          })
        : all.filter((w) => !w.already_ordered).map((w) => ({ ...w, approvedQty: w.quantity }));

      const winners = requested;
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
      // first batch keeps the RFQ's number; later batches suffix it (see the doc block above)
      const priorOrders = Number(
        ((await tx.execute(sql`select count(*)::int as n from orders where rfq_id = ${rfqId}::uuid`)) as Array<{ n: number }>)[0].n,
      );
      const orderNumber = priorOrders === 0 ? rfq.order_number : `${rfq.order_number}-B${priorOrders + 1}`;
      const [order] = await tx
        .insert(schema.orders)
        .values({
          tenantId: ctx.tenantId!,
          environment: rfq.environment, // order inherits the RFQ's environment
          rfqId,
          orderNumber,
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
            // the legacy final_part_number rule: the ALTERNATIVE the buyer settled on wins over the
            // originally requested number (COALESCE(alternative, part_number))
            finalPartNumber: w.alternative_part_number ?? w.part_number,
            approvedQty: w.approvedQty,
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
      // with its from/to and the acting user (QNEW-75). On a second batch the header is already
      // at 'confirmed' — transition() treats same-status as a no-op, so this stays unconditional.
      await this.status.transition(tx, ctx, { entity: "rfq", id: rfqId, toCode: "confirmed" });
      await this.status.transitionMany(tx, ctx, {
        entity: "rfq_item",
        ids: winners.map((w) => w.id),
        toCode: "confirmed",
      });
      // advance the WINNING vendors' invitation to 'confirmed' (vendor-portal 'won' KPI + queue state)
      const wonVendorIds = (await tx.execute(sql`
        select distinct vi.rfq_vendor_id as id from rfq_vendor_items vi
        where vi.id in (${sql.join(winners.map((w) => sql`${w.winning_vendor_quote_item_id}::uuid`), sql`, `)})`)) as Array<{ id: string }>;
      await this.status.transitionMany(tx, ctx, {
        entity: "rfq_vendor",
        ids: wonVendorIds.map((v) => v.id),
        toCode: "confirmed",
      });

      return { orderId: order.id, orderNumber, confirmedItems: winners.length };
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
