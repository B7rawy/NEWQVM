import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";

/**
 * Vendor self-service portal (cross-workspace). A vendor is a GLOBAL identity linked to many
 * workspaces; these endpoints derive the caller's vendor_id from vendor_users and return ONLY that
 * vendor's rows across every workspace it's linked to (run internal, then filtered by vendor_id) —
 * so a vendor never sees another vendor's data (unlike the tenant-wide /rfqs).
 */
export const submitQuoteSchema = z.object({
  items: z
    .array(
      z.object({
        rfqItemId: z.string().uuid(),
        offeredCost: z.number().finite().nonnegative().max(100_000_000),
        slaHours: z.number().int().positive().optional(),
        availableQty: z.number().int().nonnegative().optional(),
        alternativePartNumber: z.string().max(64).optional(),
        notes: z.string().max(256).optional(),
      }),
    )
    .min(1),
});

@Injectable()
export class VendorPortalService {
  constructor(private readonly dbService: DbService) {}

  /** Resolve the signed-in user's vendor identity. 403 if the account is not a vendor. */
  private async requireVendorId(tx: Tx, userId: string | null): Promise<string> {
    const r = (await tx.execute(sql`select vendor_id from vendor_users where user_id = ${userId}::uuid limit 1`))[0] as
      | { vendor_id: string }
      | undefined;
    if (!r) throw new ForbiddenException("not a vendor account");
    return r.vendor_id;
  }

  /** KPI counts over the vendor's quotation requests (across every linked workspace). */
  async overview(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const c = (await tx.execute(sql`
        select
          count(*) as total,
          count(*) filter (where vs.code = 'rfq') as open,
          count(*) filter (where vs.code = 'priced') as priced,
          count(*) filter (where vs.code = 'confirmed') as won
        from rfq_vendors rv
        join vendor_statuses vs on vs.id = rv.status_id
        join rfqs r on r.id = rv.rfq_id
        where rv.vendor_id = ${vid}::uuid and r.environment = 'live'`))[0] as { total: number; open: number; priced: number; won: number };
      const total = Number(c.total);
      const responded = Number(c.priced) + Number(c.won);
      return {
        open: Number(c.open),
        priced: Number(c.priced),
        won: Number(c.won),
        total,
        responseRate: total > 0 ? Math.round((responded / total) * 100) : 0,
      };
    });
  }

  /** The vendor's quotation-request queue (across workspaces). */
  async quotations(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select rv.id, r.order_number, r.plate_number, rv.sent_at, r.created_at,
          vs.code as status, vs.label_en as status_label, t.name as workspace,
          (select count(*) from rfq_items ri where ri.rfq_id = r.id) as item_count,
          (select count(*) from rfq_vendor_items vi where vi.rfq_vendor_id = rv.id) as quoted_count
        from rfq_vendors rv
        join rfqs r on r.id = rv.rfq_id
        join vendor_statuses vs on vs.id = rv.status_id
        join tenants t on t.id = rv.tenant_id
        where rv.vendor_id = ${vid}::uuid and r.environment = 'live'
        order by coalesce(rv.sent_at, r.created_at) desc`);
      return { count: rows.length, quotations: rows };
    });
  }

  /** One quotation request: header + line items with THIS vendor's quote (if any). */
  async quotationDetail(ctx: RlsContext, rfqVendorId: string) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const head = (await tx.execute(sql`
        select rv.id, rv.rfq_id, rv.tenant_id, r.order_number, r.plate_number, rv.sent_at,
          vs.code as status, vs.label_en as status_label, t.name as workspace
        from rfq_vendors rv
        join rfqs r on r.id = rv.rfq_id
        join vendor_statuses vs on vs.id = rv.status_id
        join tenants t on t.id = rv.tenant_id
        where rv.id = ${rfqVendorId}::uuid and rv.vendor_id = ${vid}::uuid and r.environment = 'live' limit 1`))[0] as
        | { rfq_id: string; status: string }
        | undefined;
      if (!head) throw new NotFoundException("quotation request not found");
      const items = await tx.execute(sql`
        select ri.id as rfq_item_id, ri.part_number, ri.part_description, ri.quantity,
          vi.offered_cost, vi.sla_hours, vi.available_qty, vi.alternative_part_number, vi.notes
        from rfq_items ri
        left join rfq_vendor_items vi on vi.rfq_item_id = ri.id and vi.rfq_vendor_id = ${rfqVendorId}::uuid
        where ri.rfq_id = ${(head as { rfq_id: string }).rfq_id}::uuid
        order by ri.part_number`);
      return { ...(head as object), items };
    });
  }

  /** Orders this vendor won — derived via order_items → winning rfq_vendor_item → rfq_vendors.vendor_id. */
  async orders(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select o.id, o.order_number, o.created_at, s.label_en as status, s.code as status_code, t.name as workspace,
          count(oi.id) as items,
          coalesce(sum(rvi.offered_cost * oi.approved_qty), 0) as total
        from orders o
        join order_items oi on oi.order_id = o.id
        join rfq_vendor_items rvi on rvi.id = oi.winning_vendor_quote_item_id
        join rfq_vendors rv on rv.id = rvi.rfq_vendor_id
        join tenants t on t.id = o.tenant_id
        left join item_statuses s on s.id = o.status_id
        where rv.vendor_id = ${vid}::uuid and o.environment = 'live'
        group by o.id, o.order_number, o.created_at, s.label_en, s.code, t.name
        order by o.created_at desc`);
      return { count: rows.length, orders: rows };
    });
  }

  /** The vendor's own profile: identity + branches + the workspaces it supplies (read-only). */
  async profile(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const v = (await tx.execute(sql`
        select legal_name, counterparty_type, activation_status, vendor_type, primary_email, primary_phone,
          tax_number, commercial_registration_number
        from vendors where id = ${vid}::uuid limit 1`))[0] as object;
      const branches = await tx.execute(sql`
        select vb.id, vb.name, vb.address, r.label_en as region
        from vendor_branches vb left join regions r on r.id = vb.region_id
        where vb.vendor_id = ${vid}::uuid order by vb.name`);
      const ws = (await tx.execute(sql`
        select t.name from tenant_vendors tv join tenants t on t.id = tv.tenant_id
        where tv.vendor_id = ${vid}::uuid and tv.status <> 'archived' order by t.name`)) as Array<{ name: string }>;
      return { ...v, branches, workspaces: ws.map((w) => w.name) };
    });
  }

  /** Submit / update this vendor's quote for a request (reuses the token-quote write path). */
  async submitQuote(ctx: RlsContext, rfqVendorId: string, dto: z.infer<typeof submitQuoteSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vid = await this.requireVendorId(tx, ctx.userId);
      const rv = (await tx.execute(sql`
        select rv.id, rv.rfq_id, rv.tenant_id, r.environment from rfq_vendors rv
        join rfqs r on r.id = rv.rfq_id
        where rv.id = ${rfqVendorId}::uuid and rv.vendor_id = ${vid}::uuid limit 1`))[0] as
        | { id: string; rfq_id: string; tenant_id: string; environment: string }
        | undefined;
      if (!rv) throw new NotFoundException("quotation request not found");
      if (rv.environment !== "live") throw new BadRequestException("this request is not live");
      const confirmed = (await tx.execute(sql`select 1 from orders where rfq_id = ${rv.rfq_id}::uuid limit 1`))[0];
      if (confirmed) throw new BadRequestException("this RFQ is already confirmed");
      const pricedStatusId = ((await tx.execute(sql`select id from vendor_statuses where code = 'priced' limit 1`))[0] as { id: string }).id;
      const validItemIds = new Set(
        ((await tx.execute(sql`select id from rfq_items where rfq_id = ${rv.rfq_id}::uuid`)) as Array<{ id: string }>).map((r) => r.id),
      );
      const items = dto.items.filter((i) => validItemIds.has(i.rfqItemId));
      if (items.length === 0) throw new BadRequestException("no valid items for this RFQ");
      for (const it of items) {
        await tx.execute(sql`
          insert into rfq_vendor_items (tenant_id, rfq_vendor_id, rfq_item_id, offered_cost, sla_hours, available_qty, alternative_part_number, notes, status_id)
          values (${rv.tenant_id}::uuid, ${rv.id}::uuid, ${it.rfqItemId}::uuid, ${it.offeredCost.toFixed(2)}, ${it.slaHours ?? null}, ${it.availableQty ?? null}, ${it.alternativePartNumber ?? null}, ${it.notes ?? null}, ${pricedStatusId}::uuid)
          on conflict (rfq_vendor_id, rfq_item_id) do update set
            offered_cost = excluded.offered_cost, sla_hours = excluded.sla_hours, available_qty = excluded.available_qty,
            alternative_part_number = excluded.alternative_part_number, notes = excluded.notes, status_id = excluded.status_id, updated_at = now()`);
      }
      await tx.execute(sql`update rfq_vendors set status_id = ${pricedStatusId}::uuid, updated_at = now() where id = ${rv.id}::uuid`);
      return { quoted: items.length, status: "priced" as const };
    });
  }
}
