import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { targetTenant } from "../../common/tenant-target.js";
import { envOf } from "../../common/env-guards.js";

/** Scope org reads/writes to the ACTIVE workspace even for platform staff. */
const scoped = (ctx: RlsContext): RlsContext => ({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false });

export const createWorkshopSchema = z
  .object({
    counterpartyType: z.enum(["individual", "company"]).default("company"),
    name: z.string().min(2),
    taxNumber: z.string().optional(),
    primaryPhone: z.string().optional(),
    primaryEmail: z.string().email().optional(),
    tenantId: z.string().uuid().optional(), // platform staff: target a specific workspace
  })
  // QNEW-71: legal form drives the mandatory identifier — same rule as vendors/providers.
  .superRefine((d, ctx) => {
    if (d.counterpartyType === "company" && !d.taxNumber)
      ctx.addIssue({ code: "custom", path: ["taxNumber"], message: "a company requires a tax number" });
    if (d.counterpartyType === "individual" && !d.primaryPhone)
      ctx.addIssue({ code: "custom", path: ["primaryPhone"], message: "an individual requires a mobile number" });
  });
export const createBranchSchema = z.object({
  workshopId: z.string().uuid(),
  name: z.string().min(2),
  regionId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  // matches the pg enum order_category exactly ("insurance" is a payer_type on RFQs, not a branch category)
  orderCategory: z.enum(["regular", "bulk"]).optional(),
  isBulk: z.boolean().optional(),
});

@Injectable()
export class OrgService {
  constructor(private readonly dbService: DbService) {}

  /** Workshops linked to the active workspace; for unscoped platform staff, EVERY workshop (global). */
  async listWorkshops(ctx: RlsContext) {
    const global = ctx.isInternal && !ctx.tenantId;
    const rows = await this.dbService.withContext(
      global ? { tenantId: null, userId: ctx.userId, isInternal: true } : scoped(ctx),
      (tx) =>
        global
          ? tx.execute(sql`
              select w.id, w.name, w.counterparty_type, w.activation_status, w.tax_number, w.primary_phone,
                w.primary_email, w.is_active,
                (select count(*)::int from workshop_branches wb where wb.workshop_id = w.id) as branches,
                (select count(*)::int from tenant_workshops tw where tw.workshop_id = w.id and tw.status <> 'archived') as workspaces,
                exists (select 1 from workshop_users wu where wu.workshop_id = w.id) as has_account,
                (select wu.user_id from workshop_users wu where wu.workshop_id = w.id
                   order by wu.is_workshop_admin desc limit 1) as user_id
              from workshops w
              order by w.name`)
          : tx.execute(sql`
              select w.id, w.name, w.counterparty_type, w.activation_status, w.tax_number, w.primary_phone,
                w.primary_email, w.is_active,
                (select count(*)::int from workshop_branches wb where wb.workshop_id = w.id) as branches,
                1 as workspaces,
                exists (select 1 from workshop_users wu where wu.workshop_id = w.id) as has_account,
                (select wu.user_id from workshop_users wu where wu.workshop_id = w.id
                   order by wu.is_workshop_admin desc limit 1) as user_id
              from tenant_workshops tw
              join workshops w on w.id = tw.workshop_id
              where tw.status <> 'archived'
              order by w.name`),
    );
    return { count: rows.length, workshops: rows };
  }

  /**
   * Everything about ONE workshop, for its own page: identity, branches, portal accounts, workspace
   * links and recent requests. Privacy: a non-platform caller only ever sees ITS OWN workspace link
   * and ITS OWN requests — a shared global counterparty must not leak another tenant's relationship.
   */
  async workshopDetail(ctx: RlsContext, id: string) {
    const env = envOf(ctx);
    const global = ctx.isInternal && !ctx.tenantId;
    return this.dbService.withContext({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      const w = (await tx.execute(sql`
        select id, name, counterparty_type, activation_status, tax_number, commercial_registration_number,
          primary_phone, primary_email, is_active, created_at
        from workshops where id = ${id}::uuid limit 1`))[0] as Record<string, unknown> | undefined;
      if (!w) throw new NotFoundException("workshop not found");

      // a scoped caller must be linked to it, otherwise the workshop is none of their business
      if (!global) {
        const linked = (await tx.execute(sql`
          select 1 from tenant_workshops where workshop_id = ${id}::uuid and tenant_id = ${ctx.tenantId}::uuid
            and status <> 'archived' limit 1`))[0];
        if (!linked) throw new NotFoundException("workshop not found in this workspace");
      }

      const branches = await tx.execute(sql`
        select wb.id, wb.name, wb.order_category, wb.is_active, r.label_en as region, c.label_en as city
        from workshop_branches wb
        left join regions r on r.id = wb.region_id
        left join cities c on c.id = wb.city_id
        where wb.workshop_id = ${id}::uuid order by wb.name`);

      const accounts = await tx.execute(sql`
        select u.id, u.full_name, u.email, u.phone, u.is_active, wu.is_workshop_admin, wu.created_at
        from workshop_users wu join users u on u.id = wu.user_id
        where wu.workshop_id = ${id}::uuid order by wu.is_workshop_admin desc, u.full_name`);

      const workspaces = await tx.execute(sql`
        select t.id, t.name, t.slug, tw.status
        from tenant_workshops tw join tenants t on t.id = tw.tenant_id
        where tw.workshop_id = ${id}::uuid and tw.status <> 'archived'
          ${global ? sql`` : sql`and tw.tenant_id = ${ctx.tenantId}::uuid`}
        order by t.name`);

      const requests = await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, r.created_at, s.label_en as status,
          wb.name as branch, t.name as workspace,
          exists (select 1 from orders o where o.rfq_id = r.id) as ordered
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id and wb.workshop_id = ${id}::uuid
        join tenants t on t.id = r.tenant_id
        left join item_statuses s on s.id = r.status_id
        where r.environment = ${env}::environment_type ${global ? sql`` : sql`and r.tenant_id = ${ctx.tenantId}::uuid`}
        order by r.created_at desc limit 10`);

      return { workshop: w, branches, accounts, workspaces, requests };
    });
  }

  /** Create a new GLOBAL workshop and link it to the active workspace (mirrors vendor create). */
  async createWorkshop(ctx: RlsContext, dto: z.infer<typeof createWorkshopSchema>) {
    const target = targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext(
      { tenantId: target, userId: ctx.userId, isInternal: true },
      async (tx) => {
        let w: { id: string };
        try {
          [w] = (await tx.execute(sql`
          insert into workshops (name, counterparty_type, tax_number, primary_phone, primary_email, created_by, updated_by)
          values (${dto.name}, ${dto.counterpartyType}, ${dto.taxNumber ?? null}, ${dto.primaryPhone ?? null},
            ${dto.primaryEmail ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
      } catch (e) {
        // scoped partial-unique (company→tax, individual→mobile): the identity already exists —
        // the caller should LINK/merge the existing one, not create a duplicate.
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("a counterparty with this identifier already exists — link the existing one instead");
        throw e;
      }
        await tx.execute(sql`
          insert into tenant_workshops (tenant_id, workshop_id, status, linked_by, created_by, updated_by)
          values (${target}::uuid, ${w.id}::uuid, 'active', ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        return { id: w.id };
      },
    );
  }

  /** Branches of workshops LINKED to the active workspace; for unscoped platform staff, EVERY
   *  branch across all (global) workshops — the master-data view mirroring listWorkshops. */
  async listBranches(ctx: RlsContext) {
    const global = ctx.isInternal && !ctx.tenantId;
    const rows = await this.dbService.withContext(
      global ? { tenantId: null, userId: ctx.userId, isInternal: true } : scoped(ctx),
      (tx) =>
        global
          ? tx.execute(sql`
              select wb.id, wb.workshop_id, wb.name, wb.order_category, wb.is_bulk, wb.is_active,
                w.name as workshop, r.label_en as region
              from workshop_branches wb
              join workshops w on w.id = wb.workshop_id
              left join regions r on r.id = wb.region_id
              order by w.name, wb.name`)
          : tx.execute(sql`
              select wb.id, wb.workshop_id, wb.name, wb.order_category, wb.is_bulk, wb.is_active,
                w.name as workshop, r.label_en as region
              from tenant_workshops tw
              join workshops w on w.id = tw.workshop_id and tw.status <> 'archived'
              join workshop_branches wb on wb.workshop_id = w.id
              left join regions r on r.id = wb.region_id
              order by w.name, wb.name`),
    );
    return { count: rows.length, branches: rows };
  }

  async createBranch(ctx: RlsContext, dto: z.infer<typeof createBranchSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        // workshop must be LINKED to this workspace (tenant_workshops is tenant-scoped)
        const link = (
          (await tx.execute(sql`
            select 1 from tenant_workshops where workshop_id = ${dto.workshopId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`)) as Array<unknown>
        )[0];
        if (!link) throw new NotFoundException("workshop is not linked to this workspace");
        const [b] = (await tx.execute(sql`
          insert into workshop_branches
            (workshop_id, name, region_id, city_id, order_category, is_bulk, created_by, updated_by)
          values (${dto.workshopId}::uuid, ${dto.name}, ${dto.regionId ?? null}::uuid,
                  ${dto.cityId ?? null}::uuid, ${dto.orderCategory ?? "regular"}, ${dto.isBulk ?? false},
                  ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        return { id: b.id };
      },
    );
  }

  /** Global reference lookups (read for everyone). */
  async regions(ctx: RlsContext) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`select id, label_en as name, label_ar from regions where is_active = true order by sort_order, label_en`),
    );
    return { regions: rows };
  }
  async cities(ctx: RlsContext, regionId?: string) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`
        select id, label_en as name, region_id from cities
        where is_active = true and (${regionId ?? null}::uuid is null or region_id = ${regionId ?? null}::uuid)
        order by label_en`),
    );
    return { cities: rows };
  }
}
