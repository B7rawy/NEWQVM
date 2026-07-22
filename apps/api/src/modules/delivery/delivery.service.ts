import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

export const createDeliverySchema = z.object({
  items: z
    .array(z.object({ orderItemId: z.string().uuid(), qty: z.number().int().positive() }))
    .min(1),
});
export type CreateDeliveryDto = z.infer<typeof createDeliverySchema>;

@Injectable()
export class DeliveryService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Deliver a set of confirmed items (supports PARTIAL / SPLIT delivery — old flat delivery_notes
   * couldn't). Over-delivery is blocked: (already delivered + requested) must be ≤ approved_qty.
   * An order_item flips to 'delivered' only once its cumulative delivered qty reaches approved_qty.
   */
  async create(ctx: RlsContext, orderId: string, dto: CreateDeliveryDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      const order = (
        (await tx.execute(
          sql`select id from orders where id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (!order) throw new NotFoundException("order not found in this workspace");

      // approved + already-delivered per order_item of this order
      const state = new Map<string, { approved: number; delivered: number }>();
      for (const r of (await tx.execute(sql`
        select oi.id, coalesce(oi.approved_qty,0) as approved,
               coalesce((select sum(di.qty) from delivery_items di where di.order_item_id = oi.id),0) as delivered
        from order_items oi where oi.order_id = ${orderId}::uuid`)) as Array<{
        id: string;
        approved: number;
        delivered: number;
      }>) {
        state.set(r.id, { approved: Number(r.approved), delivered: Number(r.delivered) });
      }

      for (const it of dto.items) {
        const s = state.get(it.orderItemId);
        if (!s) throw new BadRequestException(`item ${it.orderItemId} is not in this order`);
        if (s.delivered + it.qty > s.approved) {
          throw new BadRequestException(
            `over-delivery on item ${it.orderItemId} (approved ${s.approved}, already ${s.delivered}, requested ${it.qty})`,
          );
        }
      }

      const deliveredStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'delivered' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const [delivery] = await tx
        .insert(schema.deliveries)
        .values({ tenantId: ctx.tenantId!, orderId, statusId: deliveredStatusId, deliveredAt: new Date() })
        .returning({ id: schema.deliveries.id });

      await tx.insert(schema.deliveryItems).values(
        dto.items.map((it) => ({
          tenantId: ctx.tenantId!,
          deliveryId: delivery.id,
          orderItemId: it.orderItemId,
          qty: it.qty,
        })),
      );

      // flip fully-delivered items to 'delivered'
      for (const it of dto.items) {
        const s = state.get(it.orderItemId)!;
        if (s.delivered + it.qty >= s.approved) {
          await tx.execute(
            sql`update order_items set status_id = ${deliveredStatusId} where id = ${it.orderItemId}::uuid`,
          );
        }
      }

      return { deliveryId: delivery.id, orderId, deliveredItems: dto.items.length };
    });
  }

  async listForOrder(ctx: RlsContext, orderId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select d.id, d.delivered_at, count(di.id) as items, coalesce(sum(di.qty),0) as total_qty
        from deliveries d
        left join delivery_items di on di.delivery_id = d.id
        where d.order_id = ${orderId}::uuid
        group by d.id, d.delivered_at order by d.created_at`),
    );
    return { orderId, deliveries: rows };
  }
}
