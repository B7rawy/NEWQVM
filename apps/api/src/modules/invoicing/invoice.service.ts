import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { PricingService } from "../pricing/pricing.service.js";
import { assertEnvironment } from "../../common/env-guards.js";
import { StatusService } from "../../common/status.service.js";

const VAT_RATE = 0.15; // KSA VAT

@Injectable()
export class InvoiceService {
  constructor(
    private readonly dbService: DbService,
    private readonly pricing: PricingService,
    private readonly status: StatusService,
  ) {}

  /**
   * Issue the client invoice for an order. One invoice per order (idempotent). Line unit price =
   * the client selling price. NOTE: until the pricing engine (roadmap QNEW-30) sets rfq_items.
   * selling_price, we fall back to the winning quote cost as a documented placeholder.
   */
  async issue(ctx: RlsContext, orderId: string) {
    try {
      return await this.issueInner(ctx, orderId);
    } catch (e) {
      // DB backstop (invoices_order_uq): concurrent double-issue races past check-then-insert.
      if ((e as { code?: string })?.code === "23505")
        throw new BadRequestException("invoice already issued for this order");
      throw e;
    }
  }

  private async issueInner(ctx: RlsContext, orderId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      // bind to the acting workspace explicitly: these are platform-staff routes, and an internal
      // context satisfies the PERMISSIVE tenant policy — without this a staffer on workspace A could
      // attach a document to workspace B's order, leaving a row invisible to both.
      const order = (
        (await tx.execute(
          sql`select id, order_number, environment from orders where id = ${orderId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`,
        )) as Array<{ id: string; order_number: string; environment: "live" | "sandbox" }>
      )[0];
      assertEnvironment(ctx, order, "order");

      const existing = (
        (await tx.execute(
          sql`select id from invoices where order_id = ${orderId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (existing) throw new BadRequestException("invoice already issued for this order");

      // pull cost + classification per line so the pricing engine can derive the selling price
      const raw = (await tx.execute(sql`
        select oi.id as order_item_id, coalesce(oi.approved_qty,1) as qty,
               ri.selling_price, ri.part_number, ri.part_category_id, ri.brand_class_id,
               r.payer_type, r.insurance_company_id,
               coalesce(vi.offered_cost, 0) as cost
        from order_items oi
        join rfq_items ri on ri.id = oi.rfq_item_id
        join orders o on o.id = oi.order_id
        join rfqs r on r.id = o.rfq_id
        left join rfq_vendor_items vi on vi.id = oi.winning_vendor_quote_item_id
        where oi.order_id = ${orderId}::uuid`)) as Array<{
        order_item_id: string;
        qty: number;
        selling_price: string | null;
        part_number: string | null;
        part_category_id: string | null;
        brand_class_id: string | null;
        payer_type: "cash_client" | "credit_client" | "insurance";
        insurance_company_id: string | null;
        cost: string;
      }>;
      if (raw.length === 0) throw new BadRequestException("order has no items to invoice");

      // unit price: explicit selling_price if set, else compute via the pricing engine (QNEW-41)
      const lines: Array<{ order_item_id: string; qty: number; unit_price: string }> = [];
      for (const l of raw) {
        let unit = l.selling_price ? Number(l.selling_price) : null;
        if (unit == null) {
          const computed = await this.pricing.computeIn(tx, ctx.tenantId!, {
            cost: Number(l.cost),
            partNumber: l.part_number,
            partCategoryId: l.part_category_id,
            brandClassId: l.brand_class_id,
            payerScenario: l.payer_type,
            insuranceCompanyId: l.insurance_company_id,
          });
          unit = computed.sellingPrice;
        }
        lines.push({ order_item_id: l.order_item_id, qty: Number(l.qty), unit_price: unit.toFixed(2) });
      }

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
          sql`select public.next_order_number(${ctx.tenantId}::uuid, 'INV-', null, ${order.environment}) as n`,
        )) as Array<{ n: string }>
      )[0].n;

      const [invoice] = await tx
        .insert(schema.invoices)
        .values({
          tenantId: ctx.tenantId!,
          environment: order.environment,
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
          environment: order.environment,
          invoiceId: invoice.id,
          orderItemId: l.order_item_id,
          qty: Number(l.qty),
          unitPrice: m(Number(l.unit_price)),
        })),
      );

      await this.status.transition(tx, ctx, { entity: "order", id: orderId, toCode: "invoice_issued" });

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
