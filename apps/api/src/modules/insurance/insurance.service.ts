import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

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
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`select id, name, suggested_discount_pct, file_format
                     from insurance_companies where is_active = true order by name`),
    );
    return { count: rows.length, companies: rows };
  }

  /** Internal sets the payer type (QNEW-43). insurance requires an insurance company. */
  async setPayer(ctx: RlsContext, rfqId: string, dto: z.infer<typeof setPayerSchema>) {
    if (dto.payerType === "insurance" && !dto.insuranceCompanyId) {
      throw new BadRequestException("insurance payer requires insuranceCompanyId");
    }
    return this.dbService.withContext(ctx, async (tx) => {
      const r = (
        (await tx.execute(sql`
          update rfqs set payer_type = ${dto.payerType},
                 insurance_company_id = ${dto.insuranceCompanyId ?? null}
          where id = ${rfqId}::uuid returning id`)) as Array<{ id: string }>
      )[0];
      if (!r) throw new NotFoundException("RFQ not found in this workspace");
      return { rfqId, payerType: dto.payerType };
    });
  }

  /** Move the RFQ to a target insurance status (QNEW-45). */
  private async transition(ctx: RlsContext, rfqId: string, code: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const st = (
        (await tx.execute(
          sql`select id from item_statuses where code = ${code} limit 1`,
        )) as Array<{ id: string }>
      )[0];
      const r = (
        (await tx.execute(
          sql`update rfqs set status_id = ${st.id} where id = ${rfqId}::uuid returning id`,
        )) as Array<{ id: string }>
      )[0];
      if (!r) throw new NotFoundException("RFQ not found in this workspace");
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
