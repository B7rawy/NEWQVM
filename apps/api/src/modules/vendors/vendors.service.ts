import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

export const createVendorSchema = z.object({
  legalName: z.string().min(2),
  commercialRegistrationNumber: z.string().optional(),
  taxNumber: z.string().optional(),
  primaryEmail: z.string().email().optional(),
  primaryPhone: z.string().optional(),
  vendorType: z.enum(["agency", "commercial", "external"]).optional(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  classification: z.string().optional(),
});
export const createVendorBranchSchema = z.object({
  vendorId: z.string().uuid(),
  name: z.string().min(2),
  regionId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  address: z.string().optional(),
});

@Injectable()
export class VendorsService {
  constructor(private readonly dbService: DbService) {}

  /** Vendors LINKED to the active workspace (via tenant_vendors) — scoped by RLS. */
  async list(ctx: RlsContext) {
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false },
      (tx) =>
        tx.execute(sql`
          select v.id, v.legal_name, v.vendor_type, v.primary_email, v.primary_phone,
            tv.status, tv.classification,
            (select count(*) from vendor_branches vb where vb.vendor_id = v.id) as branches
          from tenant_vendors tv
          join vendors v on v.id = tv.vendor_id
          where tv.status <> 'archived'
          order by v.legal_name`),
    );
    return { count: rows.length, vendors: rows };
  }

  /** Create a new global vendor AND link it to the active workspace. Needs is_internal (global
   *  write) + the active tenant_id (tenant_vendors isolation) — both satisfied here. */
  async create(ctx: RlsContext, dto: z.infer<typeof createVendorSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        const [v] = (await tx.execute(sql`
          insert into vendors (legal_name, commercial_registration_number, tax_number, primary_email,
            primary_phone, vendor_type, payment_terms_days, created_by, updated_by)
          values (${dto.legalName}, ${dto.commercialRegistrationNumber ?? null}, ${dto.taxNumber ?? null},
            ${dto.primaryEmail ?? null}, ${dto.primaryPhone ?? null}, ${dto.vendorType ?? "commercial"},
            ${dto.paymentTermsDays ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        await tx.execute(sql`
          insert into tenant_vendors (tenant_id, vendor_id, status, classification, linked_by, created_by, updated_by)
          values (${ctx.tenantId}::uuid, ${v.id}::uuid, 'active', ${dto.classification ?? null},
            ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        return { id: v.id };
      },
    );
  }

  async listBranches(ctx: RlsContext, vendorId: string) {
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false },
      (tx) =>
        tx.execute(sql`
          select vb.id, vb.name, vb.address, r.label_en as region
          from vendor_branches vb left join regions r on r.id = vb.region_id
          where vb.vendor_id = ${vendorId}::uuid order by vb.name`),
    );
    return { count: rows.length, branches: rows };
  }

  async createBranch(ctx: RlsContext, dto: z.infer<typeof createVendorBranchSchema>) {
    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        // vendor must be linked to this workspace (RLS-scoped check on tenant_vendors)
        const link = (
          (await tx.execute(sql`
            select 1 from tenant_vendors where vendor_id = ${dto.vendorId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`)) as Array<unknown>
        )[0];
        if (!link) throw new NotFoundException("vendor is not linked to this workspace");
        const [b] = (await tx.execute(sql`
          insert into vendor_branches (vendor_id, name, region_id, city_id, address, created_by, updated_by)
          values (${dto.vendorId}::uuid, ${dto.name}, ${dto.regionId ?? null}::uuid, ${dto.cityId ?? null}::uuid,
            ${dto.address ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        return { id: b.id };
      },
    );
  }
}
