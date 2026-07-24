import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

export const createRuleSchema = z.object({
  workshopBranchId: z.string().uuid().optional(),
  partCategoryId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  automationMode: z.enum(["suggest", "auto"]).default("suggest"),
  vendorIds: z.array(z.string().uuid()).min(1),
});
export type CreateRuleDto = z.infer<typeof createRuleSchema>;

@Injectable()
export class VendorAssignmentService {
  constructor(private readonly dbService: DbService) {}

  async createRule(ctx: RlsContext, dto: CreateRuleDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      let rule: { id: string };
      try {
        [rule] = await tx
          .insert(schema.vendorSelectionRules)
          .values({
            tenantId: ctx.tenantId!,
            workshopBranchId: dto.workshopBranchId,
            partCategoryId: dto.partCategoryId,
            cityId: dto.cityId,
            automationMode: dto.automationMode,
          })
          .returning({ id: schema.vendorSelectionRules.id });
      } catch (e) {
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("a vendor selection rule with this scope already exists");
        throw e;
      }
      await tx
        .insert(schema.vendorSelectionRuleVendors)
        .values(dto.vendorIds.map((v) => ({ tenantId: ctx.tenantId!, ruleId: rule.id, vendorId: v })))
        .onConflictDoNothing();
      return { id: rule.id, vendors: dto.vendorIds.length };
    });
  }

  /**
   * Suggest vendors for an RFQ (QNEW-35/38): match rules by the RFQ's branch + its item categories
   * + branch city (rule fields null = wildcard). Returns distinct linked-and-active vendors and
   * whether any matching rule is 'auto' (caller may then auto-send).
   */
  async suggest(ctx: RlsContext, rfqId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(sql`
          select r.id, r.workshop_branch_id, wb.city_id
          from rfqs r join workshop_branches wb on wb.id = r.workshop_branch_id
          where r.id = ${rfqId}::uuid limit 1`)) as Array<{
          id: string;
          workshop_branch_id: string;
          city_id: string | null;
        }>
      )[0];
      if (!rfq) throw new NotFoundException("RFQ not found in this workspace");

      const rows = (await tx.execute(sql`
        select distinct v.id as vendor_id, v.legal_name, r.automation_mode
        from rfq_items i
        join vendor_selection_rules r on r.tenant_id = ${ctx.tenantId}::uuid and r.is_active
          and (r.workshop_branch_id is null or r.workshop_branch_id = ${rfq.workshop_branch_id}::uuid)
          and (r.part_category_id is null or r.part_category_id = i.part_category_id)
          and (r.city_id is null or r.city_id is not distinct from ${rfq.city_id})
        join vendor_selection_rule_vendors rv on rv.rule_id = r.id
        join vendors v on v.id = rv.vendor_id and v.is_active and v.activation_status = 'active'
        join tenant_vendors tv on tv.vendor_id = v.id and tv.tenant_id = ${ctx.tenantId}::uuid and tv.status = 'active'
        where i.rfq_id = ${rfqId}::uuid`)) as Array<{
        vendor_id: string;
        legal_name: string;
        automation_mode: string;
      }>;

      const vendorsMap = new Map(rows.map((r) => [r.vendor_id, r.legal_name]));
      const autoSend = rows.some((r) => r.automation_mode === "auto");
      return {
        rfqId,
        autoSend,
        suggestedVendors: [...vendorsMap].map(([id, name]) => ({ vendorId: id, name })),
      };
    });
  }
}
