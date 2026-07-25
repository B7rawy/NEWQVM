import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { assertEnvironment } from "../../common/env-guards.js";
import { StatusService } from "../../common/status.service.js";

export const createReturnSchema = z.object({
  items: z
    .array(
      z.object({
        orderItemId: z.string().uuid(),
        qty: z.number().int().positive(),
        returnReasonId: z.string().uuid().optional(),
        responsibility: z.enum(["internal", "vendor", "client", "delivery_agent"]).optional(),
      }),
    )
    .min(1),
});
export type CreateReturnDto = z.infer<typeof createReturnSchema>;

@Injectable()
export class ReturnsService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

  /**
   * Workshop returns delivered items. Can't return more than was delivered (net of prior returns).
   * Creates a return + return_items and moves those items to 'return'. The credit note is a
   * separate internal (finance) step: issueCreditNote.
   */
  async create(ctx: RlsContext, orderId: string, dto: CreateReturnDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      // bind to the acting workspace explicitly: these are platform-staff routes, and an internal
      // context satisfies the PERMISSIVE tenant policy — without this a staffer on workspace A could
      // attach a document to workspace B's order, leaving a row invisible to both.
      const order = (
        (await tx.execute(
          sql`select id, environment from orders where id = ${orderId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`,
        )) as Array<{ id: string; environment: "live" | "sandbox" }>
      )[0];
      assertEnvironment(ctx, order, "order");

      // delivered vs already-returned per order_item
      const state = new Map<string, { delivered: number; returned: number }>();
      for (const r of (await tx.execute(sql`
        select oi.id,
          coalesce((select sum(di.qty) from delivery_items di where di.order_item_id = oi.id),0) as delivered,
          coalesce((select sum(rt.qty) from return_items rt where rt.order_item_id = oi.id),0) as returned
        from order_items oi where oi.order_id = ${orderId}::uuid`)) as Array<{
        id: string;
        delivered: number;
        returned: number;
      }>) {
        state.set(r.id, { delivered: Number(r.delivered), returned: Number(r.returned) });
      }

      // aggregate per order_item FIRST — duplicate lines in one payload must not bypass the cap
      const requested = new Map<string, number>();
      for (const it of dto.items) requested.set(it.orderItemId, (requested.get(it.orderItemId) ?? 0) + it.qty);
      for (const [orderItemId, qty] of requested) {
        const s = state.get(orderItemId);
        if (!s) throw new BadRequestException(`item ${orderItemId} is not in this order`);
        if (qty + s.returned > s.delivered) {
          throw new BadRequestException(
            `cannot return ${qty} of item ${orderItemId} (delivered ${s.delivered}, already returned ${s.returned})`,
          );
        }
      }

      const returnStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'return' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const [ret] = await tx
        .insert(schema.returns)
        .values({ tenantId: ctx.tenantId!, environment: order.environment, orderId, statusId: returnStatusId, returnedAt: new Date() })
        .returning({ id: schema.returns.id });

      await tx.insert(schema.returnItems).values(
        dto.items.map((it) => ({
          tenantId: ctx.tenantId!,
          environment: order.environment,
          returnId: ret.id,
          orderItemId: it.orderItemId,
          qty: it.qty,
          returnReasonId: it.returnReasonId,
          responsibility: it.responsibility,
        })),
      );
      await this.status.transitionMany(tx, ctx, {
        entity: "order_item",
        ids: [...new Set(dto.items.map((it) => it.orderItemId))],
        toCode: "return",
      });
      return { returnId: ret.id, orderId, returnedItems: dto.items.length };
    });
  }

  /** Internal (finance): issue a credit note for a return. Idempotent via the return's status. */
  async issueCreditNote(ctx: RlsContext, returnId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const ret = (
        (await tx.execute(sql`
          select r.id, r.order_id, r.environment, s.code as status
          from returns r left join item_statuses s on s.id = r.status_id
          where r.id = ${returnId}::uuid limit 1`)) as Array<{
          id: string;
          order_id: string;
          status: string | null;
          environment: "live" | "sandbox";
        }>
      )[0];
      assertEnvironment(ctx, ret, "return");
      if (ret.status === "credit_note_issued") {
        throw new BadRequestException("credit note already issued for this return");
      }

      const lines = (await tx.execute(sql`
        select rt.order_item_id, rt.qty, rt.return_reason_id,
               coalesce(ii.unit_price, rf.selling_price, vi.offered_cost, 0) as unit_price
        from return_items rt
        join order_items oi on oi.id = rt.order_item_id
        join rfq_items rf on rf.id = oi.rfq_item_id
        left join rfq_vendor_items vi on vi.id = oi.winning_vendor_quote_item_id
        left join invoice_items ii on ii.order_item_id = oi.id
        where rt.return_id = ${returnId}::uuid`)) as Array<{
        order_item_id: string;
        qty: number;
        return_reason_id: string | null;
        unit_price: string;
      }>;
      if (lines.length === 0) throw new BadRequestException("return has no items");

      const total = lines.reduce((s, l) => s + Number(l.unit_price) * Number(l.qty), 0);
      const m = (n: number) => n.toFixed(2);

      const cnStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'credit_note_issued' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;
      const cnNumber = (
        (await tx.execute(
          sql`select public.next_order_number(${ctx.tenantId}::uuid, 'CN-', null, ${ret.environment}) as n`,
        )) as Array<{ n: string }>
      )[0].n;

      const [cn] = await tx
        .insert(schema.creditNotes)
        .values({
          tenantId: ctx.tenantId!,
          environment: ret.environment,
          orderId: ret.order_id,
          creditNoteNumber: cnNumber,
          issuedAt: new Date(),
          total: m(total),
          statusId: cnStatusId,
        })
        .returning({ id: schema.creditNotes.id });

      await tx.insert(schema.creditNoteItems).values(
        lines.map((l) => ({
          tenantId: ctx.tenantId!,
          environment: ret.environment,
          creditNoteId: cn.id,
          orderItemId: l.order_item_id,
          qty: Number(l.qty),
          returnReasonId: l.return_reason_id ?? undefined,
        })),
      );

      await this.status.transition(tx, ctx, { entity: "return", id: returnId, toCode: "credit_note_issued" });
      await this.status.transitionMany(tx, ctx, {
        entity: "order_item",
        ids: [...new Set(lines.map((l) => l.order_item_id))],
        toCode: "credit_note_issued",
      });
      return { creditNoteId: cn.id, creditNoteNumber: cnNumber, total: m(total), items: lines.length };
    });
  }

  async listForOrder(ctx: RlsContext, orderId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select r.id, s.code as status, count(rt.id)::int as items, coalesce(sum(rt.qty),0)::int as total_qty
        from returns r
        left join item_statuses s on s.id = r.status_id
        left join return_items rt on rt.return_id = r.id
        where r.order_id = ${orderId}::uuid
        group by r.id, s.code order by r.created_at`),
    );
    return { orderId, returns: rows };
  }
}
