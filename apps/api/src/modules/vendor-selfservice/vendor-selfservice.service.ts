import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { cleanPartNumber } from "../parts/parts.service.js";

export const upsertStockSchema = z.object({
  vendorId: z.string().uuid(),
  items: z
    .array(
      z.object({
        partNumber: z.string().min(1),
        nameEn: z.string().optional(),
        nameAr: z.string().optional(),
        partType: z.string().optional(),
        quantity: z.number().int().nonnegative().default(0),
        wholesalePrice: z.number().finite().nonnegative().optional(),
        retailPrice: z.number().finite().nonnegative().optional(),
      }),
    )
    .min(1),
});

export const pricingPolicySchema = z.object({
  vendorId: z.string().uuid(),
  scopeType: z.enum(["global", "region", "client_branch"]).default("global"),
  regionId: z.string().uuid().optional(),
  workshopBranchId: z.string().uuid().optional(),
  adjustmentType: z.enum(["discount", "markup"]).default("discount"),
  adjustmentPct: z.number().min(0).max(100).default(0),
});

@Injectable()
export class VendorSelfServiceService {
  constructor(private readonly dbService: DbService) {}

  /** Upload/merge vendor stock (QNEW-49) — merges by cleaned part number, never replaces the catalog. */
  async upsertStock(ctx: RlsContext, dto: z.infer<typeof upsertStockSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      for (const it of dto.items) {
        const cleaned = cleanPartNumber(it.partNumber);
        await tx.execute(sql`
          insert into vendor_stock_items
            (tenant_id, vendor_id, raw_part_number, cleaned_part_number, name_en, name_ar, part_type,
             quantity, wholesale_price, retail_price)
          values (${ctx.tenantId}::uuid, ${dto.vendorId}::uuid, ${it.partNumber}, ${cleaned},
                  ${it.nameEn ?? null}, ${it.nameAr ?? null}, ${it.partType ?? null}, ${it.quantity},
                  ${it.wholesalePrice?.toFixed(2) ?? null}, ${it.retailPrice?.toFixed(2) ?? null})
          on conflict (tenant_id, vendor_id, cleaned_part_number)
          do update set quantity = excluded.quantity, wholesale_price = excluded.wholesale_price,
                        retail_price = excluded.retail_price, name_en = coalesce(excluded.name_en, vendor_stock_items.name_en),
                        updated_at = now()`);
      }
      return { vendorId: dto.vendorId, merged: dto.items.length };
    });
  }

  /** External view masks the real quantity as Available/Not-Available (QNEW-49). */
  async listStock(ctx: RlsContext, vendorId: string, maskQty = false) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select cleaned_part_number, name_en, part_type, retail_price,
               ${maskQty ? sql`(quantity > 0)` : sql`quantity`} as availability
        from vendor_stock_items
        where vendor_id = ${vendorId}::uuid order by cleaned_part_number limit 100`),
    );
    return { vendorId, count: rows.length, items: rows };
  }

  async setPricingPolicy(ctx: RlsContext, dto: z.infer<typeof pricingPolicySchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into vendor_pricing_policies
          (tenant_id, vendor_id, scope_type, region_id, workshop_branch_id, adjustment_type, adjustment_pct)
        values (${ctx.tenantId}::uuid, ${dto.vendorId}::uuid, ${dto.scopeType}, ${dto.regionId ?? null}::uuid,
                ${dto.workshopBranchId ?? null}::uuid, ${dto.adjustmentType}, ${dto.adjustmentPct})
        on conflict (tenant_id, vendor_id, scope_type, region_id, workshop_branch_id)
        do update set adjustment_type = excluded.adjustment_type,
                      adjustment_pct = excluded.adjustment_pct, updated_at = now()`);
      return { ok: true };
    });
  }

  /**
   * Resolve a vendor's adjusted price (QNEW-51) — most-specific policy wins:
   * client_branch > region > global. Applies discount/markup to the base price.
   */
  async resolvePrice(
    ctx: RlsContext,
    vendorId: string,
    basePrice: number,
    opts: { regionId?: string; workshopBranchId?: string } = {},
  ) {
    return this.dbService.withContext(ctx, async (tx) => {
      const policy = (
        (await tx.execute(sql`
          select scope_type, adjustment_type, adjustment_pct
          from vendor_pricing_policies
          where tenant_id = ${ctx.tenantId}::uuid and vendor_id = ${vendorId}::uuid
            and (scope_type = 'global'
                 or (scope_type = 'region' and region_id is not distinct from ${opts.regionId ?? null}::uuid)
                 or (scope_type = 'client_branch' and workshop_branch_id is not distinct from ${opts.workshopBranchId ?? null}::uuid))
          order by case scope_type when 'client_branch' then 1 when 'region' then 2 else 3 end, updated_at desc
          limit 1`)) as Array<{ scope_type: string; adjustment_type: string; adjustment_pct: string }>
      )[0];
      if (!policy) return { basePrice, finalPrice: basePrice, applied: null };
      const sign = policy.adjustment_type === "discount" ? -1 : 1;
      const final = basePrice * (1 + (sign * Number(policy.adjustment_pct)) / 100);
      return {
        basePrice,
        finalPrice: Number(final.toFixed(2)),
        applied: { scope: policy.scope_type, type: policy.adjustment_type, pct: Number(policy.adjustment_pct) },
      };
    });
  }
}
