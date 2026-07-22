import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

/** Scope org reads/writes to the ACTIVE workspace even for platform staff. */
const scoped = (ctx: RlsContext): RlsContext => ({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false });

export const createWorkshopSchema = z.object({ name: z.string().min(2), taxNumber: z.string().optional() });
export const createBranchSchema = z.object({
  workshopId: z.string().uuid(),
  name: z.string().min(2),
  regionId: z.string().uuid().optional(),
  cityId: z.string().uuid().optional(),
  orderCategory: z.enum(["regular", "insurance", "bulk"]).optional(),
  isBulk: z.boolean().optional(),
});

@Injectable()
export class OrgService {
  constructor(private readonly dbService: DbService) {}

  /** Workshops LINKED to the active workspace (via tenant_workshops) — global entities, scoped. */
  async listWorkshops(ctx: RlsContext) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`
        select w.id, w.name, w.tax_number, w.is_active,
          (select count(*) from workshop_branches wb where wb.workshop_id = w.id) as branches
        from tenant_workshops tw
        join workshops w on w.id = tw.workshop_id
        where tw.status <> 'archived'
        order by w.name`),
    );
    return { count: rows.length, workshops: rows };
  }

  /** Create a new GLOBAL workshop and link it to the active workspace (mirrors vendor create). */
  async createWorkshop(ctx: RlsContext, dto: z.infer<typeof createWorkshopSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        const [w] = (await tx.execute(sql`
          insert into workshops (name, tax_number, created_by, updated_by)
          values (${dto.name}, ${dto.taxNumber ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        await tx.execute(sql`
          insert into tenant_workshops (tenant_id, workshop_id, status, linked_by, created_by, updated_by)
          values (${ctx.tenantId}::uuid, ${w.id}::uuid, 'active', ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        return { id: w.id };
      },
    );
  }

  /** Branches of workshops LINKED to the active workspace. */
  async listBranches(ctx: RlsContext) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`
        select wb.id, wb.name, wb.order_category, wb.is_bulk, wb.is_active,
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
