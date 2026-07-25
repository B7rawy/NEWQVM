import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

const INTERNAL: RlsContext = { tenantId: null, userId: null, isInternal: true };

export const createWorkspaceSchema = z.object({
  name: z.string().min(2),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug must be lowercase letters, numbers and single hyphens"),
});
export const linkCounterpartySchema = z.object({ classification: z.string().optional() });
export const updateWorkspaceSchema = z.object({
  name: z.string().min(2).optional(),
  isActive: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
});

/** Platform-only management of workspaces (tenants). The tenant is the root of the hierarchy. */
@Injectable()
export class WorkspacesAdminService {
  constructor(private readonly dbService: DbService) {}

  /** Every workspace, with quick counts — the super-admin table. */
  async list() {
    const rows = await this.dbService.withContext(INTERNAL, (tx) =>
      tx.execute(sql`
        select t.id, t.slug, t.name, t.is_active, t.created_at,
          (select count(*)::int from tenant_workshops tw join workshop_branches wb on wb.workshop_id = tw.workshop_id
            where tw.tenant_id = t.id and tw.status <> 'archived') as branches,
          (select count(*)::int from tenant_vendors tv where tv.tenant_id = t.id and tv.status = 'active') as vendors,
          (select count(*)::int from tenant_memberships m where m.tenant_id = t.id and m.is_active = true) as users
        from tenants t order by t.created_at desc`),
    );
    return { count: rows.length, workspaces: rows };
  }

  async create(actorUserId: string, dto: z.infer<typeof createWorkspaceSchema>) {
    return this.dbService.withContext({ ...INTERNAL, userId: actorUserId }, async (tx) => {
      const clash = (
        (await tx.execute(sql`select 1 from tenants where slug = ${dto.slug} limit 1`)) as Array<unknown>
      )[0];
      if (clash) throw new ConflictException(`workspace slug '${dto.slug}' is already taken`);
      const [t] = (await tx.execute(sql`
        insert into tenants (name, slug, created_by, updated_by)
        values (${dto.name}, ${dto.slug}, ${actorUserId}::uuid, ${actorUserId}::uuid)
        returning id, slug`)) as Array<{ id: string; slug: string }>;
      return { id: t.id, slug: t.slug };
    });
  }

  async get(id: string) {
    const row = (
      await this.dbService.withContext(INTERNAL, (tx) =>
        tx.execute(sql`select id, slug, name, is_active, settings from tenants where id = ${id}::uuid limit 1`),
      )
    )[0];
    if (!row) throw new NotFoundException("workspace not found");
    return row;
  }

  /**
   * Everything about ONE workspace (super-admin drill-in). Config (users/workshops/vendors) is the
   * same in both environments; the OPERATIONAL sections (rfqs/orders/invoices) are scoped to the
   * active environment so the Live/Sandbox toggle switches them.
   */
  async detail(id: string, environment: "live" | "sandbox" = "live") {
    // the GUC must agree with the predicates below, or the restrictive environment policy
    // (migration 0041) would silently filter the operational sections to the wrong environment
    return this.dbService.withContext({ ...INTERNAL, environment }, async (tx) => {
      const workspace = (
        (await tx.execute(sql`
          select t.id, t.slug, t.name, t.is_active, t.settings, t.logo_url, t.created_at,
            p.name as plan, p.code as plan_code
          from tenants t left join plans p on p.id = t.plan_id
          where t.id = ${id}::uuid limit 1`)) as Array<Record<string, unknown>>
      )[0];
      if (!workspace) throw new NotFoundException("workspace not found");

      // what this workspace still has waiting on the platform: counterparties it submitted for review
      const submissions = await tx.execute(sql`
        select s.id, s.kind, s.counterparty_type, s.legal_name, s.tax_number, s.mobile, s.status, s.created_at,
          jsonb_array_length(s.match_candidates) as candidates
        from counterparty_submissions s
        where s.tenant_id = ${id}::uuid and s.status = 'pending'
        order by s.created_at desc`);

      const users = await tx.execute(sql`
        select u.id, u.full_name, u.email, u.phone, u.is_active, m.role, m.id as membership_id,
               wb.name as branch, m.workshop_branch_id
        from tenant_memberships m
        join users u on u.id = m.user_id
        left join workshop_branches wb on wb.id = m.workshop_branch_id
        where m.tenant_id = ${id}::uuid and m.is_active = true
        order by (m.role = 'company_admin') desc, u.full_name`);

      const workshops = await tx.execute(sql`
        select w.id, w.name, w.tax_number,
          (select count(*)::int from workshop_branches wb where wb.workshop_id = w.id) as branches
        from tenant_workshops tw join workshops w on w.id = tw.workshop_id
        where tw.tenant_id = ${id}::uuid and tw.status <> 'archived' order by w.name`);

      const vendors = await tx.execute(sql`
        select v.id, v.legal_name, v.vendor_type, tv.status, tv.classification,
          (select vu.user_id from vendor_users vu where vu.vendor_id = v.id order by vu.is_vendor_admin desc limit 1) as user_id
        from tenant_vendors tv join vendors v on v.id = tv.vendor_id
        where tv.tenant_id = ${id}::uuid and tv.status <> 'archived' order by v.legal_name`);

      // ---- operational sections (environment-scoped) ----
      const rfqs = await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, s.label_en as status,
               (select count(*)::int from rfq_items i where i.rfq_id = r.id) as items
        from rfqs r left join item_statuses s on s.id = r.status_id
        where r.tenant_id = ${id}::uuid and r.environment = ${environment}
        order by r.created_at desc limit 25`);

      const orders = await tx.execute(sql`
        select o.id, o.order_number, s.label_en as status,
               (select count(*)::int from order_items oi where oi.order_id = o.id) as items
        from orders o left join item_statuses s on s.id = o.status_id
        where o.tenant_id = ${id}::uuid and o.environment = ${environment}
        order by o.created_at desc limit 25`);

      const invoices = await tx.execute(sql`
        select i.id, i.invoice_number, i.total_incl_vat, i.issued_at, s.label_en as status, o.order_number
        from invoices i
        join orders o on o.id = i.order_id and o.environment = ${environment}
        left join item_statuses s on s.id = i.status_id
        where i.tenant_id = ${id}::uuid
        order by i.created_at desc limit 25`);

      return { workspace, environment, users, workshops, vendors, submissions, rfqs, orders, invoices };
    });
  }

  /** Directory entities NOT yet linked to this workspace — the pick-list for "link existing". */
  async linkable(id: string, kind: "vendor" | "workshop") {
    return this.dbService.withContext(INTERNAL, async (tx) => {
      const rows =
        kind === "vendor"
          ? await tx.execute(sql`
              select v.id, v.legal_name as name, v.counterparty_type, v.tax_number, v.primary_phone
              from vendors v
              where v.is_active and not exists (
                select 1 from tenant_vendors tv where tv.vendor_id = v.id and tv.tenant_id = ${id}::uuid and tv.status <> 'archived')
              order by v.legal_name limit 100`)
          : await tx.execute(sql`
              select w.id, w.name, w.counterparty_type, w.tax_number, w.primary_phone
              from workshops w
              where w.is_active and not exists (
                select 1 from tenant_workshops tw where tw.workshop_id = w.id and tw.tenant_id = ${id}::uuid and tw.status <> 'archived')
              order by w.name limit 100`);
      return { count: rows.length, candidates: rows };
    });
  }

  /** Link an EXISTING directory identity to this workspace (re-activates an archived link). */
  async linkCounterparty(actorUserId: string, id: string, kind: "vendor" | "workshop", entityId: string, classification?: string) {
    return this.dbService.withContext({ ...INTERNAL, userId: actorUserId }, async (tx) => {
      if (kind === "vendor") {
        await tx.execute(sql`
          insert into tenant_vendors (tenant_id, vendor_id, status, classification, linked_by, created_by, updated_by)
          values (${id}::uuid, ${entityId}::uuid, 'active', ${classification ?? null}, ${actorUserId}::uuid, ${actorUserId}::uuid, ${actorUserId}::uuid)
          on conflict (tenant_id, vendor_id) do update set status = 'active', updated_at = now()`);
      } else {
        await tx.execute(sql`
          insert into tenant_workshops (tenant_id, workshop_id, status, linked_by, created_by, updated_by)
          values (${id}::uuid, ${entityId}::uuid, 'active', ${actorUserId}::uuid, ${actorUserId}::uuid, ${actorUserId}::uuid)
          on conflict (tenant_id, workshop_id) do update set status = 'active', updated_at = now()`);
      }
      await tx.execute(sql`
        insert into platform_audit (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        values (${id}::uuid, ${actorUserId}::uuid, 'workspace.link_counterparty', ${kind}, ${entityId}::uuid, '{}'::jsonb)`);
      return { ok: true };
    });
  }

  /** Unlink (archive the relationship) — the global identity itself is never deleted. */
  async unlinkCounterparty(actorUserId: string, id: string, kind: "vendor" | "workshop", entityId: string) {
    return this.dbService.withContext({ ...INTERNAL, userId: actorUserId }, async (tx) => {
      const table = kind === "vendor" ? "tenant_vendors" : "tenant_workshops";
      const col = kind === "vendor" ? "vendor_id" : "workshop_id";
      const rows = (await tx.execute(sql`
        update ${sql.raw(table)} set status = 'archived', updated_by = ${actorUserId}::uuid, updated_at = now()
        where tenant_id = ${id}::uuid and ${sql.raw(col)} = ${entityId}::uuid returning id`)) as Array<{ id: string }>;
      if (!rows[0]) throw new NotFoundException("link not found");
      await tx.execute(sql`
        insert into platform_audit (tenant_id, actor_user_id, action, entity_type, entity_id, metadata)
        values (${id}::uuid, ${actorUserId}::uuid, 'workspace.unlink_counterparty', ${kind}, ${entityId}::uuid, '{}'::jsonb)`);
      return { ok: true };
    });
  }

  async update(actorUserId: string, id: string, dto: z.infer<typeof updateWorkspaceSchema>) {
    if (dto.name === undefined && dto.isActive === undefined && dto.settings === undefined) {
      throw new BadRequestException("nothing to update");
    }
    return this.dbService.withContext({ ...INTERNAL, userId: actorUserId }, async (tx) => {
      const rows = (await tx.execute(sql`
        update tenants set
          name = coalesce(${dto.name ?? null}, name),
          is_active = coalesce(${dto.isActive ?? null}, is_active),
          settings = coalesce(${dto.settings ? JSON.stringify(dto.settings) : null}::jsonb, settings),
          updated_by = ${actorUserId}::uuid, updated_at = now()
        where id = ${id}::uuid
        returning id`)) as Array<{ id: string }>;
      if (!rows[0]) throw new NotFoundException("workspace not found");
      return { id: rows[0].id, ok: true };
    });
  }
}
