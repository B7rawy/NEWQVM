import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { RfqService } from "../rfq/rfq.service.js";

/**
 * Workshop self-service portal (cross-workspace). A workshop is a GLOBAL customer linked to many
 * workspaces; these endpoints scope by workshop OWNERSHIP (via workshop_users) across every linked
 * workspace — so a workshop only ever sees ITS OWN requests, never other customers' (unlike the
 * tenant-wide /rfqs which is for workspace staff).
 */
export const createRequestSchema = z.object({
  tenantId: z.string().uuid(), // which linked workspace should serve this request
  workshopBranchId: z.string().uuid(),
  plateNumber: z.string().max(32).optional(),
  vin: z.string().max(32).optional(),
  model: z.string().max(64).optional(),
  orderType: z.enum(["regular", "bulk"]).default("regular"),
  items: z
    .array(
      z.object({
        partNumber: z.string().max(64).optional(),
        partDescription: z.string().max(256).optional(),
        quantity: z.number().int().positive().default(1),
      }),
    )
    .min(1),
});

@Injectable()
export class WorkshopPortalService {
  constructor(
    private readonly dbService: DbService,
    private readonly rfqService: RfqService,
  ) {}

  private async requireWorkshopUser(tx: Tx, userId: string | null) {
    const r = (await tx.execute(sql`select 1 from workshop_users where user_id = ${userId}::uuid limit 1`))[0];
    if (!r) throw new ForbiddenException("not a workshop account");
  }

  /** KPI counts over the workshop's own requests (across every linked workspace). */
  async overview(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const c = (await tx.execute(sql`
        select
          count(*) as total,
          count(*) filter (where not exists (select 1 from orders o where o.rfq_id = r.id)
            and coalesce(ist.code, '') not in ('cancelled', 'unavailable', 'settled')) as open,
          count(*) filter (where exists (select 1 from orders o where o.rfq_id = r.id)) as ordered
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        left join item_statuses ist on ist.id = r.status_id
        where r.environment = 'live'`))[0] as { total: number; open: number; ordered: number };
      return { total: Number(c.total), open: Number(c.open), ordered: Number(c.ordered) };
    });
  }

  /** The workshop's requests (RFQs) across workspaces. */
  async requests(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, r.created_at,
          ist.code as status, ist.label_en as status_label, t.name as workspace, wb.name as branch,
          (select count(*) from rfq_items ri where ri.rfq_id = r.id) as item_count,
          (select count(*) from rfq_vendors rv where rv.rfq_id = r.id) as vendor_count
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = r.tenant_id
        left join item_statuses ist on ist.id = r.status_id
        where r.environment = 'live'
        order by r.created_at desc`);
      return { count: rows.length, requests: rows };
    });
  }

  /** One request: header + items + invited-vendor progress (names + responded, NO prices). */
  async requestDetail(ctx: RlsContext, rfqId: string) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const head = (await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, r.vin, r.model, r.created_at,
          ist.code as status, ist.label_en as status_label, t.name as workspace, wb.name as branch
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = r.tenant_id
        left join item_statuses ist on ist.id = r.status_id
        where r.id = ${rfqId}::uuid and r.environment = 'live' limit 1`))[0] as { id: string } | undefined;
      if (!head) throw new NotFoundException("request not found");
      const items = await tx.execute(sql`
        select id, part_number, part_description, quantity from rfq_items where rfq_id = ${rfqId}::uuid order by part_number`);
      const vendors = await tx.execute(sql`
        select v.legal_name as vendor, vs.code as status, vs.label_en as status_label,
          (select count(*) from rfq_vendor_items vi where vi.rfq_vendor_id = rv.id) as quoted_items
        from rfq_vendors rv join vendors v on v.id = rv.vendor_id join vendor_statuses vs on vs.id = rv.status_id
        where rv.rfq_id = ${rfqId}::uuid order by v.legal_name`);
      return { ...(head as object), items, vendors };
    });
  }

  /** Data for the New Request form: the workshop's linked workspaces + its branches. */
  async context(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const workspaces = await tx.execute(sql`
        select distinct t.id, t.name from tenant_workshops tw
        join tenants t on t.id = tw.tenant_id
        join workshop_users wu on wu.workshop_id = tw.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where tw.status = 'active' order by t.name`);
      const branches = await tx.execute(sql`
        select wb.id, wb.name, w.name as workshop from workshop_branches wb
        join workshops w on w.id = wb.workshop_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where wb.is_active = true order by wb.name`);
      return { workspaces, branches };
    });
  }

  /** The workshop's branches + the workspaces it works with (read-only account page). */
  async branches(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const branches = await tx.execute(sql`
        select wb.id, wb.name, w.name as workshop, r.label_en as region, wb.order_category
        from workshop_branches wb
        join workshops w on w.id = wb.workshop_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        left join regions r on r.id = wb.region_id
        where wb.is_active = true order by wb.name`);
      const ws = (await tx.execute(sql`
        select distinct t.name from tenant_workshops tw
        join tenants t on t.id = tw.tenant_id
        join workshop_users wu on wu.workshop_id = tw.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where tw.status = 'active' order by t.name`)) as Array<{ name: string }>;
      return { branches, workspaces: ws.map((w) => w.name) };
    });
  }

  /** The workshop's confirmed orders (across linked workspaces). */
  async orders(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select o.id, o.order_number, o.created_at, s.label_en as status, s.code as status_code,
          t.name as workspace, wb.name as branch,
          (select count(*) from order_items oi where oi.order_id = o.id) as items
        from orders o
        join rfqs r on r.id = o.rfq_id
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = o.tenant_id
        left join item_statuses s on s.id = o.status_id
        where o.environment = 'live'
        order by o.created_at desc`);
      return { count: rows.length, orders: rows };
    });
  }

  /** Create a request (RFQ) in a chosen linked workspace, for one of the workshop's own branches. */
  async createRequest(ctx: RlsContext, dto: z.infer<typeof createRequestSchema>) {
    // ownership + link check (internal read)
    await this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const ok = (await tx.execute(sql`
        select 1 from workshop_users wu
        join workshop_branches wb on wb.workshop_id = wu.workshop_id and wb.id = ${dto.workshopBranchId}::uuid
        join tenant_workshops tw on tw.workshop_id = wu.workshop_id and tw.tenant_id = ${dto.tenantId}::uuid and tw.status = 'active'
        where wu.user_id = ${ctx.userId}::uuid limit 1`))[0];
      if (!ok) throw new ForbiddenException("branch not owned by your workshop, or workspace not linked");
    });
    // reuse the workspace RFQ-create (atomic order number + header + items) in the chosen tenant
    return this.rfqService.create(
      { tenantId: dto.tenantId, userId: ctx.userId, isInternal: false, environment: "live" },
      {
        workshopBranchId: dto.workshopBranchId,
        plateNumber: dto.plateNumber,
        vin: dto.vin,
        model: dto.model,
        orderType: dto.orderType,
        deliveryType: "delivery",
        items: dto.items.map((i) => ({ partNumber: i.partNumber, partDescription: i.partDescription, quantity: i.quantity })),
      },
    );
  }
}
