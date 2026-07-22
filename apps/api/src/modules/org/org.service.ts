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

  async listWorkshops(ctx: RlsContext) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`
        select w.id, w.name, w.tax_number, w.is_active,
          (select count(*) from workshop_branches wb where wb.workshop_id = w.id) as branches
        from workshops w order by w.name`),
    );
    return { count: rows.length, workshops: rows };
  }

  async createWorkshop(ctx: RlsContext, dto: z.infer<typeof createWorkshopSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    return this.dbService.withContext(scoped(ctx), async (tx) => {
      const [w] = (await tx.execute(sql`
        insert into workshops (tenant_id, name, tax_number, created_by, updated_by)
        values (${ctx.tenantId}::uuid, ${dto.name}, ${dto.taxNumber ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      return { id: w.id };
    });
  }

  async listBranches(ctx: RlsContext) {
    const rows = await this.dbService.withContext(scoped(ctx), (tx) =>
      tx.execute(sql`
        select wb.id, wb.name, wb.order_category, wb.is_bulk, wb.is_active,
          w.name as workshop, r.label_en as region
        from workshop_branches wb
        join workshops w on w.id = wb.workshop_id
        left join regions r on r.id = wb.region_id
        order by w.name, wb.name`),
    );
    return { count: rows.length, branches: rows };
  }

  async createBranch(ctx: RlsContext, dto: z.infer<typeof createBranchSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    return this.dbService.withContext(scoped(ctx), async (tx) => {
      // workshop must belong to this workspace (RLS-scoped check)
      const w = (
        (await tx.execute(sql`select id from workshops where id = ${dto.workshopId}::uuid limit 1`)) as Array<{ id: string }>
      )[0];
      if (!w) throw new NotFoundException("workshop not found in this workspace");
      const [b] = (await tx.execute(sql`
        insert into workshop_branches
          (tenant_id, workshop_id, name, region_id, city_id, order_category, is_bulk, created_by, updated_by)
        values (${ctx.tenantId}::uuid, ${dto.workshopId}::uuid, ${dto.name}, ${dto.regionId ?? null}::uuid,
                ${dto.cityId ?? null}::uuid, ${dto.orderCategory ?? "regular"}, ${dto.isBulk ?? false},
                ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      return { id: b.id };
    });
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
