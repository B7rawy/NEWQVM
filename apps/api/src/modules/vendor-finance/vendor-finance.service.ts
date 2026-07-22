import { BadRequestException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

const FINANCING_INTEREST_PCT = 2.5; // single system-wide fixed rate (QNEW-52)

export const recordPaymentSchema = z.object({
  vendorId: z.string().uuid(),
  amount: z.number().finite().positive(),
  reference: z.string().optional(),
  allocations: z
    .array(z.object({ purchaseOrderId: z.string().uuid(), amount: z.number().finite().positive() }))
    .optional(),
});
export const financingSchema = z.object({
  vendorId: z.string().uuid(),
  requestedAmount: z.number().finite().positive(),
});

@Injectable()
export class VendorFinanceService {
  constructor(private readonly dbService: DbService) {}

  /** Record a vendor payment + optional allocations across purchase orders (partial payments). */
  async recordPayment(ctx: RlsContext, dto: z.infer<typeof recordPaymentSchema>) {
    const allocTotal = (dto.allocations ?? []).reduce((s, a) => s + a.amount, 0);
    if (allocTotal > dto.amount + 0.001) {
      throw new BadRequestException("allocations exceed the payment amount");
    }
    return this.dbService.withContext(ctx, async (tx) => {
      const [p] = await tx
        .insert(schema.vendorPayments)
        .values({
          tenantId: ctx.tenantId!,
          vendorId: dto.vendorId,
          amount: dto.amount.toFixed(2),
          reference: dto.reference,
        })
        .returning({ id: schema.vendorPayments.id });
      if (dto.allocations?.length) {
        await tx.insert(schema.vendorPaymentAllocations).values(
          dto.allocations.map((a) => ({
            tenantId: ctx.tenantId!,
            paymentId: p.id,
            purchaseOrderId: a.purchaseOrderId,
            allocatedAmount: a.amount.toFixed(2),
          })),
        );
      }
      return { paymentId: p.id, amount: dto.amount.toFixed(2), allocated: allocTotal.toFixed(2) };
    });
  }

  /** Vendor statement: invoiced (PO invoice_amount) vs paid vs net due. */
  async statement(ctx: RlsContext, vendorId: string) {
    const row = (
      await this.dbService.withContext(ctx, (tx) =>
        tx.execute(sql`
          select
            coalesce((select sum(invoice_amount) from purchase_orders
                      where tenant_id = ${ctx.tenantId}::uuid and vendor_id = ${vendorId}::uuid), 0) as invoiced,
            coalesce((select sum(amount) from vendor_payments
                      where tenant_id = ${ctx.tenantId}::uuid and vendor_id = ${vendorId}::uuid), 0) as paid`),
      )
    )[0] as { invoiced: string; paid: string };
    const invoiced = Number(row.invoiced);
    const paid = Number(row.paid);
    const netDue = invoiced - paid;
    return {
      vendorId,
      invoiced: invoiced.toFixed(2),
      paid: paid.toFixed(2),
      netDue: netDue.toFixed(2),
      status: netDue <= 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid",
    };
  }

  /** Early-payment financing request against confirmed invoices (QNEW-52). Fixed interest. */
  async requestFinancing(ctx: RlsContext, dto: z.infer<typeof financingSchema>) {
    const interest = Number(((dto.requestedAmount * FINANCING_INTEREST_PCT) / 100).toFixed(2));
    return this.dbService.withContext(ctx, async (tx) => {
      const [r] = await tx
        .insert(schema.vendorFinancingRequests)
        .values({
          tenantId: ctx.tenantId!,
          vendorId: dto.vendorId,
          requestedAmount: dto.requestedAmount.toFixed(2),
          interestRatePct: FINANCING_INTEREST_PCT.toFixed(2),
          interestAmount: interest.toFixed(2),
          status: "pending",
        })
        .returning({ id: schema.vendorFinancingRequests.id });
      return {
        financingRequestId: r.id,
        requestedAmount: dto.requestedAmount.toFixed(2),
        interestRatePct: FINANCING_INTEREST_PCT,
        interestAmount: interest.toFixed(2),
        status: "pending",
      };
    });
  }
}
