import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { assertRfqNotConfirmed } from "../../common/rfq-guards.js";

export const createInsurerSchema = z.object({
  name: z.string().min(1).max(120),
  suggestedDiscountPct: z.number().min(0).max(100).default(0),
  fileFormat: z.enum(["separate", "combined"]).default("separate"),
  contactInfo: z.string().max(200).optional(),
});
export const setPayerSchema = z.object({
  payerType: z.enum(["cash_client", "credit_client", "insurance"]),
  insuranceCompanyId: z.string().uuid().optional(),
});

@Injectable()
export class InsuranceService {
  constructor(private readonly dbService: DbService) {}

  async createCompany(ctx: RlsContext, dto: z.infer<typeof createInsurerSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const [c] = await tx
        .insert(schema.insuranceCompanies)
        .values({
          tenantId: ctx.tenantId!,
          name: dto.name,
          suggestedDiscountPct: dto.suggestedDiscountPct.toFixed(2),
          fileFormat: dto.fileFormat,
          contactInfo: dto.contactInfo,
        })
        .returning({ id: schema.insuranceCompanies.id });
      return { id: c.id };
    });
  }

  async listCompanies(ctx: RlsContext) {
    // scope to the active workspace even under internal context (insurers are tenant-owned).
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`select id, name, suggested_discount_pct, file_format
                     from insurance_companies where is_active = true and tenant_id = ${ctx.tenantId}::uuid order by name`),
    );
    return { count: rows.length, companies: rows };
  }

  /** Internal sets the payer type (QNEW-43). insurance requires a (valid, same-tenant) insurer. */
  async setPayer(ctx: RlsContext, rfqId: string, dto: z.infer<typeof setPayerSchema>) {
    if (dto.payerType === "insurance" && !dto.insuranceCompanyId) {
      throw new BadRequestException("insurance payer requires insuranceCompanyId");
    }
    // only an insurance payer carries an insurer; cash/credit must never store a stray insurer id.
    const insurerId = dto.payerType === "insurance" ? dto.insuranceCompanyId! : null;
    return this.dbService.withContext(ctx, async (tx) => {
      if (insurerId) {
        const ins = (await tx.execute(sql`
          select 1 from insurance_companies where id = ${insurerId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`))[0];
        if (!ins) throw new BadRequestException("insurance company not found in this workspace");
      }
      await assertRfqNotConfirmed(tx, rfqId);
      const r = (
        (await tx.execute(sql`
          update rfqs set payer_type = ${dto.payerType}, insurance_company_id = ${insurerId}
          where id = ${rfqId}::uuid returning id`)) as Array<{ id: string }>
      )[0];
      if (!r) throw new NotFoundException("RFQ not found in this workspace");
      return { rfqId, payerType: dto.payerType };
    });
  }

  /**
   * Move the RFQ to a target insurance status (QNEW-45) with a real state machine: only insurance-
   * payer RFQs, never a confirmed one, and only along allowed edges (send only from a pre-approval
   * state; approve only from 'sent_insurance_approval') — no double-approve, no out-of-order jumps.
   */
  private async transition(ctx: RlsContext, rfqId: string, code: "sent_insurance_approval" | "insurance_approved") {
    return this.dbService.withContext(ctx, async (tx) => {
      const st = (
        (await tx.execute(sql`select id from item_statuses where code = ${code} limit 1`)) as Array<{ id: string }>
      )[0];
      if (!st) throw new BadRequestException(`status '${code}' is not configured`);
      // lock the RFQ row alone (FOR UPDATE can't touch the outer-joined item_statuses), then read its status.
      const rfq = (
        (await tx.execute(sql`
          select id, payer_type, status_id from rfqs where id = ${rfqId}::uuid limit 1 for update`)) as Array<{ id: string; payer_type: string; status_id: string | null }>
      )[0];
      if (!rfq) throw new NotFoundException("RFQ not found in this workspace");
      const statusRow = rfq.status_id
        ? ((await tx.execute(sql`select code from item_statuses where id = ${rfq.status_id}::uuid limit 1`))[0] as { code: string } | undefined)
        : undefined;
      const rfqStatus = { ...rfq, status: statusRow?.code ?? null };
      if (rfqStatus.payer_type !== "insurance") throw new BadRequestException("RFQ is not an insurance-payer request");
      await assertRfqNotConfirmed(tx, rfqId);
      const from = rfqStatus.status ?? "";
      if (code === "sent_insurance_approval" && (from === "sent_insurance_approval" || from === "insurance_approved"))
        throw new BadRequestException(`cannot send for approval from '${from}'`);
      if (code === "insurance_approved" && from !== "sent_insurance_approval")
        throw new BadRequestException(`cannot approve from '${from}' — send for approval first`);
      await tx.execute(sql`update rfqs set status_id = ${st.id} where id = ${rfqId}::uuid`);
      return { rfqId, status: code };
    });
  }

  sendForApproval(ctx: RlsContext, rfqId: string) {
    return this.transition(ctx, rfqId, "sent_insurance_approval");
  }
  markApproved(ctx: RlsContext, rfqId: string) {
    return this.transition(ctx, rfqId, "insurance_approved");
  }
}
