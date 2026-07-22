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
  isSandbox: z.boolean().optional().default(false),
});
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
        select t.id, t.slug, t.name, t.is_sandbox, t.is_active, t.created_at,
          (select count(*) from tenant_workshops tw join workshop_branches wb on wb.workshop_id = tw.workshop_id
            where tw.tenant_id = t.id and tw.status <> 'archived') as branches,
          (select count(*) from tenant_vendors tv where tv.tenant_id = t.id and tv.status = 'active') as vendors,
          (select count(*) from tenant_memberships m where m.tenant_id = t.id and m.is_active = true) as users
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
        insert into tenants (name, slug, is_sandbox, created_by, updated_by)
        values (${dto.name}, ${dto.slug}, ${dto.isSandbox}, ${actorUserId}::uuid, ${actorUserId}::uuid)
        returning id, slug`)) as Array<{ id: string; slug: string }>;
      return { id: t.id, slug: t.slug };
    });
  }

  async get(id: string) {
    const row = (
      await this.dbService.withContext(INTERNAL, (tx) =>
        tx.execute(sql`select id, slug, name, is_sandbox, is_active, settings from tenants where id = ${id}::uuid limit 1`),
      )
    )[0];
    if (!row) throw new NotFoundException("workspace not found");
    return row;
  }

  /** Everything about ONE workspace (super-admin drill-in): info, members, workshops, vendors. */
  async detail(id: string) {
    return this.dbService.withContext(INTERNAL, async (tx) => {
      const workspace = (
        (await tx.execute(sql`
          select id, slug, name, is_sandbox, is_active, settings, created_at from tenants where id = ${id}::uuid limit 1`)) as Array<Record<string, unknown>>
      )[0];
      if (!workspace) throw new NotFoundException("workspace not found");

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
          (select count(*) from workshop_branches wb where wb.workshop_id = w.id) as branches
        from tenant_workshops tw join workshops w on w.id = tw.workshop_id
        where tw.tenant_id = ${id}::uuid and tw.status <> 'archived' order by w.name`);

      const vendors = await tx.execute(sql`
        select v.id, v.legal_name, v.vendor_type, tv.status, tv.classification,
          (select vu.user_id from vendor_users vu where vu.vendor_id = v.id order by vu.is_vendor_admin desc limit 1) as user_id
        from tenant_vendors tv join vendors v on v.id = tv.vendor_id
        where tv.tenant_id = ${id}::uuid and tv.status <> 'archived' order by v.legal_name`);

      return { workspace, users, workshops, vendors };
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
