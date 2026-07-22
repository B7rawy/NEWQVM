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
