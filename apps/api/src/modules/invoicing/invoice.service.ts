import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

const VAT_RATE = 0.15; // KSA VAT

@Injectable()
export class InvoiceService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Issue the client invoice for an order. One invoice per order (idempotent). Line unit price =
   * the client selling price. NOTE: until the pricing engine (roadmap QNEW-30) sets rfq_items.
   * selling_price, we fall back to the winning quote cost as a documented placeholder.
   */
  async issue(ctx: RlsContext, orderId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const order = (
        (await tx.execute(
          sql`select id, order_number from orders where id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string; order_number: string }>
      )[0];
      if (!order) throw new NotFoundException("order not found in this workspace");

      const existing = (
        (await tx.execute(
          sql`select id from invoices where order_id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (existing) throw new BadRequestException("invoice already issued for this order");

      const lines = (await tx.execute(sql`
        select oi.id as order_item_id, coalesce(oi.approved_qty,1) as qty,
               coalesce(ri.selling_price, vi.offered_cost, 0) as unit_price
        from order_items oi
        join rfq_items ri on ri.id = oi.rfq_item_id
        left join rfq_vendor_items vi on vi.id = oi.winning_vendor_quote_item_id
        where oi.order_id = ${orderId}::uuid`)) as Array<{
        order_item_id: string;
        qty: number;
        unit_price: string;
      }>;
      if (lines.length === 0) throw new BadRequestException("order has no items to invoice");

      const before = lines.reduce((s, l) => s + Number(l.unit_price) * Number(l.qty), 0);
      const vat = before * VAT_RATE;
      const incl = before + vat;
      const m = (n: number) => n.toFixed(2);

      const invoiceStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'invoice_issued' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const invoiceNumber = (
        (await tx.execute(
          sql`select public.next_order_number(${ctx.tenantId}::uuid, 'INV-', null) as n`,
        )) as Array<{ n: string }>
      )[0].n;

      const [invoice] = await tx
        .insert(schema.invoices)
        .values({
          tenantId: ctx.tenantId!,
          orderId,
          invoiceNumber,
          issuedAt: new Date(),
          totalBeforeVat: m(before),
          vatAmount: m(vat),
          totalInclVat: m(incl),
          statusId: invoiceStatusId,
        })
        .returning({ id: schema.invoices.id });

      await tx.insert(schema.invoiceItems).values(
        lines.map((l) => ({
          tenantId: ctx.tenantId!,
          invoiceId: invoice.id,
          orderItemId: l.order_item_id,
          qty: Number(l.qty),
          unitPrice: m(Number(l.unit_price)),
        })),
      );

      await tx.execute(sql`update orders set status_id = ${invoiceStatusId} where id = ${orderId}::uuid`);

      return {
        invoiceId: invoice.id,
        invoiceNumber,
        totalBeforeVat: m(before),
        vat: m(vat),
        totalInclVat: m(incl),
        items: lines.length,
      };
    });
  }

  async getForOrder(ctx: RlsContext, orderId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select id, invoice_number, total_before_vat, vat_amount, total_incl_vat, issued_at
        from invoices where order_id = ${orderId}::uuid`),
    );
    return { orderId, invoices: rows };
  }
}
