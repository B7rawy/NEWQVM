import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import argon2 from "argon2";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

/** Platform-tier roles (ADR-0010). These are NOT workspace roles — they span every workspace. */
export const PLATFORM_ROLES = ["super_admin", "purchasing", "pricing", "finance", "support"] as const;

export const addPlatformStaffSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2).optional(),
  role: z.enum(PLATFORM_ROLES),
  password: z.string().min(8).optional(), // omit → invited account (no password yet)
});
export const updatePlatformStaffSchema = z.object({
  role: z.enum(PLATFORM_ROLES).optional(),
  isActive: z.boolean().optional(),
});

/**
 * Qparts' OWN staff (platform_members) — the platform control tower's people, distinct from a
 * workspace's members. Granting a platform role is the most privileged action in the system, so it
 * is restricted to super_admin (not merely "any platform staff"), you cannot change your own row,
 * and the last active super_admin can never be removed. Every change is audited.
 */
@Injectable()
export class PlatformStaffService {
  constructor(private readonly dbService: DbService) {}

  private requireSuperAdmin(ctx: RlsContext & { platformRole?: string | null }) {
    if (ctx.platformRole !== "super_admin")
      throw new ForbiddenException("only a super admin can manage platform staff");
  }

  /** Everyone on the platform team, with their role + account state. */
  async list(ctx: RlsContext) {
    const rows = await this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, (tx) =>
      tx.execute(sql`
        select pm.id, pm.role, pm.is_active, pm.created_at,
          u.id as user_id, u.full_name, u.email, u.is_active as user_active
        from platform_members pm join users u on u.id = pm.user_id
        order by (pm.role = 'super_admin') desc, u.full_name`),
    );
    return { count: rows.length, staff: rows };
  }

  /** Grant a platform role (re-uses an existing account by email, or creates one). */
  async add(ctx: RlsContext & { platformRole?: string | null }, dto: z.infer<typeof addPlatformStaffSchema>) {
    this.requireSuperAdmin(ctx);
    const email = dto.email.trim().toLowerCase();
    const hash = dto.password ? await argon2.hash(dto.password) : null;
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const existing = (await tx.execute(sql`select id from users where email = ${email} limit 1`))[0] as
        | { id: string }
        | undefined;
      let userId = existing?.id;
      if (!userId) {
        const [u] = (await tx.execute(sql`
          insert into users (email, full_name, password_hash, created_by, updated_by)
          values (${email}, ${dto.fullName ?? email}, ${hash}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        userId = u.id;
      }
      const dup = (await tx.execute(sql`
        select 1 from platform_members where user_id = ${userId}::uuid and is_active limit 1`))[0];
      if (dup) throw new ConflictException("this account is already platform staff");

      await tx.execute(sql`
        insert into platform_members (user_id, role, created_by, updated_by)
        values (${userId}::uuid, ${dto.role}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
      await tx.execute(sql`
        insert into platform_audit (actor_user_id, action, entity_type, entity_id, metadata)
        values (${ctx.userId}::uuid, 'platform_staff.grant', 'user', ${userId}::uuid, ${JSON.stringify({ role: dto.role, email })}::jsonb)`);
      return { userId, invited: !dto.password && !existing };
    });
  }

  /** Change a platform role or deactivate the membership. */
  async update(ctx: RlsContext & { platformRole?: string | null }, memberId: string, dto: z.infer<typeof updatePlatformStaffSchema>) {
    this.requireSuperAdmin(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const m = (await tx.execute(sql`
        select id, user_id, role, is_active from platform_members where id = ${memberId}::uuid limit 1`))[0] as
        | { id: string; user_id: string; role: string; is_active: boolean }
        | undefined;
      if (!m) throw new NotFoundException("platform staff member not found");
      // self-lockout guard: you cannot demote or disable your own platform access here
      if (m.user_id === ctx.userId && (dto.isActive === false || (dto.role && dto.role !== m.role)))
        throw new ForbiddenException("you cannot change your own platform role or status");
      // the platform must always keep one active super admin
      const losingSuper = m.role === "super_admin" && ((dto.role && dto.role !== "super_admin") || dto.isActive === false);
      if (losingSuper) {
        const others = (await tx.execute(sql`
          select count(*)::int as n from platform_members
          where role = 'super_admin' and is_active = true and id <> ${memberId}::uuid`))[0] as { n: number };
        if (others.n === 0) throw new ConflictException("cannot remove the last active super admin");
      }
      if (dto.role === undefined && dto.isActive === undefined) throw new BadRequestException("nothing to update");

      await tx.execute(sql`
        update platform_members set
          role = coalesce(${dto.role ?? null}, role),
          is_active = coalesce(${dto.isActive ?? null}, is_active),
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${memberId}::uuid`);
      await tx.execute(sql`
        insert into platform_audit (actor_user_id, action, entity_type, entity_id, metadata)
        values (${ctx.userId}::uuid, 'platform_staff.update', 'user', ${m.user_id}::uuid, ${JSON.stringify(dto)}::jsonb)`);
      return { ok: true };
    });
  }

  /**
   * Global people directory for the platform system view: every account with its platform role and
   * the workspaces it belongs to — the answer to "who is this person, everywhere?".
   */
  async globalUsers(ctx: RlsContext, q?: string) {
    const needle = q?.trim() ? `%${q.trim().replace(/[%_\\]/g, (c) => "\\" + c)}%` : null;
    const rows = await this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, (tx) =>
      tx.execute(sql`
        select u.id, u.full_name, u.email, u.is_active,
          (select pm.role from platform_members pm where pm.user_id = u.id and pm.is_active limit 1) as platform_role,
          coalesce((select json_agg(json_build_object('workspace', t.name, 'role', m.role) order by t.name)
                    from tenant_memberships m join tenants t on t.id = m.tenant_id
                    where m.user_id = u.id and m.is_active), '[]'::json) as memberships,
          exists (select 1 from vendor_users vu where vu.user_id = u.id) as is_vendor,
          exists (select 1 from workshop_users wu where wu.user_id = u.id) as is_workshop
        from users u
        where ${needle}::text is null or u.full_name ilike ${needle} or u.email ilike ${needle}
        order by u.full_name limit 200`),
    );
    return { count: rows.length, users: rows };
  }
}
