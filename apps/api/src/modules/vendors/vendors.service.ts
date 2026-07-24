import { Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { targetTenant } from "../../common/tenant-target.js";

export const createVendorSchema = z.object({
  legalName: z.string().min(2),
  commercialRegistrationNumber: z.string().optional(),
  taxNumber: z.string().optional(),
  primaryEmail: z.string().email().optional(),
  primaryPhone: z.string().optional(),
  vendorType: z.enum(["agency", "commercial", "external"]).optional(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  classification: z.string().optional(),
  tenantId: z.string().uuid().optional(), // super-admin: target a specific workspace
});
export const updateVendorSchema = z.object({
  legalName: z.string().min(2).optional(),
  commercialRegistrationNumber: z.string().nullable().optional(),
  taxNumber: z.string().nullable().optional(),
  primaryEmail: z.string().email().nullable().optional(),
  primaryPhone: z.string().nullable().optional(),
  vendorType: z.enum(["agency", "commercial", "external"]).optional(),
  paymentTermsDays: z.number().int().nonnegative().nullable().optional(),
});
export const vendorStatusSchema = z.object({
  status: z.enum(["active", "suspended", "archived"]),
  tenantId: z.string().uuid().optional(),
});
export const linkVendorSchema = z.object({ tenantId: z.string().uuid().optional(), classification: z.string().optional() });
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
    // Platform staff with no active workspace → the GLOBAL master-data view (every vendor).
    const global = ctx.isInternal && !ctx.tenantId;
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: global },
      (tx) =>
        global
          ? tx.execute(sql`
              select v.id, v.legal_name, v.vendor_type, v.primary_email, v.primary_phone,
                case when v.is_active then 'active' else 'inactive' end as status,
                null::text as classification,
                (select vu.user_id from vendor_users vu where vu.vendor_id = v.id order by vu.is_vendor_admin desc limit 1) as user_id,
                (select count(*)::int from vendor_branches vb where vb.vendor_id = v.id) as branches,
                (select count(*)::int from tenant_vendors tv where tv.vendor_id = v.id and tv.status <> 'archived') as workspaces
              from vendors v
              order by v.legal_name`)
          : tx.execute(sql`
              select v.id, v.legal_name, v.vendor_type, v.primary_email, v.primary_phone,
                tv.status, tv.classification,
                (select vu.user_id from vendor_users vu where vu.vendor_id = v.id order by vu.is_vendor_admin desc limit 1) as user_id,
                (select count(*)::int from vendor_branches vb where vb.vendor_id = v.id) as branches
              from tenant_vendors tv
              join vendors v on v.id = tv.vendor_id
              where tv.status <> 'archived'
              order by v.legal_name`),
    );
    return { count: rows.length, vendors: rows };
  }

  /** Create a new global vendor AND link it to the active workspace. Needs is_internal (global
   *  write) + the active tenant_id (tenant_vendors isolation) — both satisfied here. */
  /** Resolve the target workspace via the shared helper (platform may target any workspace). */
  private targetTenant(ctx: RlsContext, dtoTenantId?: string) {
    return targetTenant(ctx, dtoTenantId);
  }

  async create(ctx: RlsContext, dto: z.infer<typeof createVendorSchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext(
      { tenantId: target, userId: ctx.userId, isInternal: true },
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
          values (${target}::uuid, ${v.id}::uuid, 'active', ${dto.classification ?? null},
            ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        return { id: v.id };
      },
    );
  }

  /** Edit the global vendor's master data (platform-only). */
  async update(ctx: RlsContext, vendorId: string, dto: z.infer<typeof updateVendorSchema>) {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(dto, k);
    return this.dbService.withContext({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true }, async (tx) => {
      const rows = (await tx.execute(sql`
        update vendors set
          legal_name = coalesce(${dto.legalName ?? null}, legal_name),
          commercial_registration_number = ${has("commercialRegistrationNumber") ? sql`${dto.commercialRegistrationNumber ?? null}` : sql`commercial_registration_number`},
          tax_number = ${has("taxNumber") ? sql`${dto.taxNumber ?? null}` : sql`tax_number`},
          primary_email = ${has("primaryEmail") ? sql`${dto.primaryEmail ?? null}` : sql`primary_email`},
          primary_phone = ${has("primaryPhone") ? sql`${dto.primaryPhone ?? null}` : sql`primary_phone`},
          vendor_type = coalesce(${dto.vendorType ?? null}, vendor_type),
          payment_terms_days = ${has("paymentTermsDays") ? sql`${dto.paymentTermsDays ?? null}` : sql`payment_terms_days`},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${vendorId}::uuid returning id`)) as Array<{ id: string }>;
      if (!rows[0]) throw new NotFoundException("vendor not found");
      return { ok: true };
    });
  }

  /** Suspend / archive / reactivate a vendor's link to a workspace (tenant_vendors.status). */
  async setStatus(ctx: RlsContext, vendorId: string, dto: z.infer<typeof vendorStatusSchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: true }, async (tx) => {
      const rows = (await tx.execute(sql`
        update tenant_vendors set status = ${dto.status}, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where vendor_id = ${vendorId}::uuid and tenant_id = ${target}::uuid returning id`)) as Array<{ id: string }>;
      if (!rows[0]) throw new NotFoundException("vendor is not linked to this workspace");
      return { ok: true };
    });
  }

  /** Global vendors NOT yet linked to the target workspace (for 'link existing'). */
  async available(ctx: RlsContext, tenantId?: string) {
    const target = this.targetTenant(ctx, tenantId);
    const rows = await this.dbService.withContext(
      { tenantId: target, userId: ctx.userId, isInternal: true },
      (tx) =>
        tx.execute(sql`
          select v.id, v.legal_name, v.vendor_type from vendors v
          where v.is_active = true and not exists (
            select 1 from tenant_vendors tv where tv.vendor_id = v.id and tv.tenant_id = ${target}::uuid and tv.status <> 'archived')
          order by v.legal_name`),
    );
    return { vendors: rows };
  }

  /** Link an existing global vendor to the target workspace. */
  async link(ctx: RlsContext, vendorId: string, dto: z.infer<typeof linkVendorSchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: true }, async (tx) => {
      await tx.execute(sql`
        insert into tenant_vendors (tenant_id, vendor_id, status, classification, linked_by, created_by, updated_by)
        values (${target}::uuid, ${vendorId}::uuid, 'active', ${dto.classification ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        on conflict (tenant_id, vendor_id) do update set status = 'active', updated_by = ${ctx.userId}::uuid, updated_at = now()`);
      return { ok: true };
    });
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
