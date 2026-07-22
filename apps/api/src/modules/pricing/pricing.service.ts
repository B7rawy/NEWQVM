import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext, type Tx } from "../../db/db.service.js";

export const setBasisSchema = z.object({
  payerScenario: z.enum(["cash_client", "credit_client", "insurance"]),
  insuranceCompanyId: z.string().uuid().optional(),
  priceBasis: z.enum(["agency_price", "vendor_price", "calculated_margin"]),
  adjustmentType: z.enum(["discount", "markup"]).default("markup"),
  adjustmentPct: z.number().min(0).max(1000).default(0),
});
export type SetBasisDto = z.infer<typeof setBasisSchema>;

export interface PriceInputs {
  cost: number;
  partNumber?: string | null;
  partCategoryId?: string | null;
  brandClassId?: string | null;
  payerScenario?: "cash_client" | "credit_client" | "insurance";
  insuranceCompanyId?: string | null;
}

@Injectable()
export class PricingService {
  constructor(private readonly dbService: DbService) {}

  async setBasis(ctx: RlsContext, dto: SetBasisDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into pricing_basis_settings
          (tenant_id, payer_scenario, insurance_company_id, price_basis, adjustment_type, adjustment_pct)
        values (${ctx.tenantId}::uuid, ${dto.payerScenario}, ${dto.insuranceCompanyId ?? null},
                ${dto.priceBasis}, ${dto.adjustmentType}, ${dto.adjustmentPct})
        on conflict (tenant_id, payer_scenario, insurance_company_id)
        do update set price_basis = excluded.price_basis, adjustment_type = excluded.adjustment_type,
                      adjustment_pct = excluded.adjustment_pct, updated_at = now()`);
      return { ok: true };
    });
  }

  async upsertAgencyPrice(ctx: RlsContext, partNumber: string, price: number, source = "manual") {
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into agency_price_reference (tenant_id, part_number, price, source, price_updated_at)
        values (${ctx.tenantId}::uuid, ${partNumber}, ${price.toFixed(2)}, ${source}, now())
        on conflict (tenant_id, part_number, source)
        do update set price = excluded.price, price_updated_at = now(), updated_at = now()`);
      return { partNumber, price: price.toFixed(2) };
    });
  }

  /** Public compute (own tx). */
  async compute(ctx: RlsContext, inputs: PriceInputs) {
    return this.dbService.withContext(ctx, (tx) => this.computeIn(tx, ctx.tenantId!, inputs));
  }

  /**
   * Core selling-price resolver (QNEW-41), callable within an existing tx (e.g. invoicing).
   *   basis: agency_price → saved agency price; vendor_price → the cost; calculated_margin →
   *   cost × (1 + margin%) from profit_margins (part_category × brand_class × cost_range).
   * Then apply the scenario's discount/markup. Falls back to cost if nothing is configured.
   */
  async computeIn(tx: Tx, tenantId: string, inputs: PriceInputs) {
    const scenario = inputs.payerScenario ?? "cash_client";
    const basis = (
      (await tx.execute(sql`
        select price_basis, adjustment_type, adjustment_pct
        from pricing_basis_settings
        where tenant_id = ${tenantId}::uuid and payer_scenario = ${scenario}
          and insurance_company_id is not distinct from ${inputs.insuranceCompanyId ?? null}
        limit 1`)) as Array<{ price_basis: string; adjustment_type: string; adjustment_pct: string }>
    )[0];

    let base = inputs.cost;
    const priceBasis = basis?.price_basis ?? "calculated_margin";

    if (priceBasis === "agency_price" && inputs.partNumber) {
      const ap = (
        (await tx.execute(sql`
          select price from agency_price_reference
          where tenant_id = ${tenantId}::uuid and part_number = ${inputs.partNumber}
          order by price_updated_at desc limit 1`)) as Array<{ price: string }>
      )[0];
      if (ap) base = Number(ap.price);
    } else if (priceBasis === "calculated_margin") {
      const margin = await this.lookupMargin(tx, tenantId, inputs);
      base = inputs.cost * (1 + margin / 100);
    } // vendor_price → base stays = cost

    const adjPct = Number(basis?.adjustment_pct ?? 0);
    const sign = basis?.adjustment_type === "discount" ? -1 : 1;
    const price = base * (1 + (sign * adjPct) / 100);
    return {
      sellingPrice: Number(price.toFixed(2)),
      basis: priceBasis,
      adjustmentPct: adjPct,
      adjustmentType: basis?.adjustment_type ?? "markup",
    };
  }

  private async lookupMargin(tx: Tx, tenantId: string, inputs: PriceInputs): Promise<number> {
    if (!inputs.partCategoryId || !inputs.brandClassId) return 0;
    const row = (
      (await tx.execute(sql`
        select pm.margin_pct
        from profit_categories pc
        join profit_margins pm on pm.profit_category_id = pc.id and pm.tenant_id = ${tenantId}::uuid
        join cost_ranges cr on cr.id = pm.cost_range_id
        where pc.tenant_id = ${tenantId}::uuid
          and pc.part_category_id = ${inputs.partCategoryId}::uuid
          and pc.brand_class_id = ${inputs.brandClassId}::uuid
          and ${inputs.cost} >= cr.lower_bound
          and (cr.upper_bound is null or ${inputs.cost} < cr.upper_bound)
        limit 1`)) as Array<{ margin_pct: string }>
    )[0];
    return row ? Number(row.margin_pct) : 0;
  }
}
