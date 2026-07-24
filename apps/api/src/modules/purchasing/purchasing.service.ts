import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

@Injectable()
export class PurchasingService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Create purchase orders for a confirmed order. Each confirmed item's winning quote determines
   * its vendor (order_item → rfq_vendor_item → rfq_vendor → vendor); items are grouped by vendor
   * into one purchase_order each, with purchase_items linking the order_item + the winning quote
   * (the cost lives on the quote — no duplication). Idempotent: refuses if POs already exist.
   */
  async createForOrder(ctx: RlsContext, orderId: string) {
    try {
      return await this.createForOrderInner(ctx, orderId);
    } catch (e) {
      // DB backstop (purchase_orders_order_vendor_uq): a concurrent duplicate create races past the
      // check-then-insert — map the unique violation to the same 400 the check produces.
      if ((e as { code?: string })?.code === "23505")
        throw new BadRequestException("purchase orders already created for this order");
      throw e;
    }
  }

  private async createForOrderInner(ctx: RlsContext, orderId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const order = (
        (await tx.execute(
          sql`select id from orders where id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (!order) throw new NotFoundException("order not found in this workspace");

      const existing = (
        (await tx.execute(
          sql`select id from purchase_orders where order_id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (existing) throw new BadRequestException("purchase orders already created for this order");

      const items = (await tx.execute(sql`
        select oi.id as order_item_id, oi.approved_qty,
               oi.winning_vendor_quote_item_id as quote_id, rv.vendor_id, v.legal_name as vendor_name
        from order_items oi
        join rfq_vendor_items vi on vi.id = oi.winning_vendor_quote_item_id
        join rfq_vendors rv on rv.id = vi.rfq_vendor_id
        join vendors v on v.id = rv.vendor_id
        where oi.order_id = ${orderId}::uuid`)) as Array<{
        order_item_id: string;
        approved_qty: number | null;
        quote_id: string;
        vendor_id: string;
        vendor_name: string;
      }>;
      if (items.length === 0) throw new BadRequestException("no confirmed items with a winning quote");

      const confirmedStatusId = (
        (await tx.execute(
          sql`select id from vendor_statuses where code = 'confirmed' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      // group order items by vendor
      const byVendor = new Map<string, typeof items>();
      for (const it of items) {
        (byVendor.get(it.vendor_id) ?? byVendor.set(it.vendor_id, []).get(it.vendor_id)!).push(it);
      }

      const created: Array<{ vendorId: string; itemCount: number }> = [];
      for (const [vendorId, vendorItems] of byVendor) {
        const [po] = await tx
          .insert(schema.purchaseOrders)
          .values({
            tenantId: ctx.tenantId!,
            orderId,
            vendorId,
            statusId: confirmedStatusId,
            vendorNameSnapshot: vendorItems[0].vendor_name, // frozen at creation (QNEW-71 §6.1)
          })
          .returning({ id: schema.purchaseOrders.id });

        await tx.insert(schema.purchaseItems).values(
          vendorItems.map((it) => ({
            tenantId: ctx.tenantId!,
            purchaseOrderId: po.id,
            orderItemId: it.order_item_id,
            vendorQuoteItemId: it.quote_id,
            qty: it.approved_qty ?? undefined,
            statusId: confirmedStatusId,
          })),
        );
        created.push({ vendorId, itemCount: vendorItems.length });
      }
      return { orderId, purchaseOrders: created.length, breakdown: created };
    });
  }

  /** Purchase orders for an order, with vendor + item count + total cost (from the winning quotes). */
  async listForOrder(ctx: RlsContext, orderId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select po.id, coalesce(po.vendor_name_snapshot, v.legal_name) as vendor, vs.label_en as status,
               count(pi.id)::int as items,
               coalesce(sum(vi.offered_cost * coalesce(pi.qty, 1)), 0) as total_cost
        from purchase_orders po
        join vendors v on v.id = po.vendor_id
        left join vendor_statuses vs on vs.id = po.status_id
        left join purchase_items pi on pi.purchase_order_id = po.id
        left join rfq_vendor_items vi on vi.id = pi.vendor_quote_item_id
        where po.order_id = ${orderId}::uuid
        group by po.id, v.legal_name, vs.label_en
        order by v.legal_name`),
    );
    return { orderId, purchaseOrders: rows };
  }

  /**
   * Record the vendor's invoice total on a purchase order (QNEW-50). This is the missing writer the
   * vendor statement + payment-allocation caps depend on (they read purchase_orders.invoice_amount).
   * Set-once: refuses if already recorded (finance corrections go through a future credit flow).
   */
  async recordInvoice(ctx: RlsContext, poId: string, amount: number) {
    if (!(amount > 0)) throw new BadRequestException("invoice amount must be positive");
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        update purchase_orders set invoice_amount = ${amount.toFixed(2)}, updated_at = now()
        where id = ${poId}::uuid and invoice_amount is null
        returning id`)) as Array<{ id: string }>;
      if (!rows[0]) {
        const exists = (await tx.execute(sql`select invoice_amount from purchase_orders where id = ${poId}::uuid limit 1`))[0] as
          | { invoice_amount: string | null }
          | undefined;
        if (!exists) throw new NotFoundException("purchase order not found in this workspace");
        throw new BadRequestException(`invoice already recorded (${exists.invoice_amount})`);
      }
      return { purchaseOrderId: poId, invoiceAmount: amount.toFixed(2) };
    });
  }
}
