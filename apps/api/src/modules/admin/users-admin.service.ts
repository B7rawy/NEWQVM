import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import argon2 from "argon2";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

/** Company-side membership roles that can be granted through the workspace Users screen. */
export const COMPANY_ROLES = ["company_admin", "branch_manager", "service_advisor"] as const;

export const addUserSchema = z.object({
  email: z.string().email(),
  fullName: z.string().min(2),
  phone: z.string().optional(),
  role: z.enum(COMPANY_ROLES),
  workshopBranchId: z.string().uuid().optional(),
  password: z.string().min(8).optional(), // optional: set now, else pending invite (null hash)
});
export const updateMembershipSchema = z.object({
  role: z.enum(COMPANY_ROLES).optional(),
  workshopBranchId: z.string().uuid().nullable().optional(),
  isActive: z.boolean().optional(),
});

@Injectable()
export class UsersAdminService {
  constructor(private readonly dbService: DbService) {}

  /** Members of the active workspace (tenant_memberships → users), RLS-scoped. */
  async list(ctx: RlsContext, includeInactive = false) {
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false },
      (tx) =>
        tx.execute(sql`
          select u.id, u.email, u.full_name, u.phone, u.is_active, m.role,
            m.id as membership_id, wb.name as branch, m.workshop_branch_id, m.is_active as membership_active
          from tenant_memberships m
          join users u on u.id = m.user_id
          left join workshop_branches wb on wb.id = m.workshop_branch_id
          where (${includeInactive} or m.is_active = true)
          order by (m.role = 'company_admin') desc, u.full_name`),
    );
    return { count: rows.length, users: rows };
  }

  /**
   * Edit a membership (role / branch / active). One implementation, two entrances (workspace-scoped
   * company_admin, or platform super-admin via /admin/workspaces/:id/members). `ctx.tenantId` is the
   * TARGET workspace; ctx.isInternal decides RLS bypass (super-admin) vs scoped (company_admin).
   * Guards the last active company_admin.
   */
  async updateMembership(ctx: RlsContext, membershipId: string, dto: z.infer<typeof updateMembershipSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no target workspace");
    return this.dbService.withContext(ctx, async (tx) => {
      const m = (
        (await tx.execute(sql`
          select id, role, is_active, user_id from tenant_memberships
          where id = ${membershipId}::uuid and tenant_id = ${ctx.tenantId}::uuid limit 1`)) as Array<{
          id: string;
          role: string;
          is_active: boolean;
          user_id: string;
        }>
      )[0];
      if (!m) throw new NotFoundException("membership not found in this workspace");

      // you can't deactivate or demote your OWN membership (prevents self-lockout)
      if (m.user_id === ctx.userId && (dto.isActive === false || (dto.role && dto.role !== m.role))) {
        throw new ForbiddenException("you cannot change your own role or status here");
      }

      // protect the last active company_admin
      const losingAdmin =
        m.role === "company_admin" &&
        ((dto.role && dto.role !== "company_admin") || dto.isActive === false);
      if (losingAdmin) {
        const others = (
          (await tx.execute(sql`
            select count(*)::int as n from tenant_memberships
            where tenant_id = ${ctx.tenantId}::uuid and role = 'company_admin' and is_active = true and id <> ${membershipId}::uuid`)) as Array<{ n: number }>
        )[0].n;
        if (others === 0) throw new ConflictException("cannot remove the workspace's last active company admin");
      }

      const branchFrag =
        "workshopBranchId" in dto
          ? sql`${dto.workshopBranchId ?? null}::uuid`
          : sql`workshop_branch_id`;
      await tx.execute(sql`
        update tenant_memberships set
          role = coalesce(${dto.role ?? null}, role),
          is_active = coalesce(${dto.isActive ?? null}, is_active),
          workshop_branch_id = ${branchFrag},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${membershipId}::uuid and tenant_id = ${ctx.tenantId}::uuid`);
      // accountability: record the control action + the real actor when acting under 'view as'
      await tx.execute(sql`
        insert into platform_audit (tenant_id, actor_user_id, impersonator_id, action, entity_type, entity_id, metadata)
        values (${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${ctx.impersonatorId ?? null}::uuid,
                'membership.update', 'tenant_membership', ${membershipId}::uuid, ${JSON.stringify(dto)}::jsonb)`);
      return { ok: true };
    });
  }

  /** Add a user to the active workspace with a role. Creates the global user if the email is new
   *  (users + tenant_memberships are is_internal / active-tenant writes — both satisfied here). */
  async add(ctx: RlsContext, dto: z.infer<typeof addUserSchema>) {
    if (!ctx.tenantId) throw new BadRequestException("no active workspace");
    const email = dto.email.trim().toLowerCase();
    const hash = dto.password ? await argon2.hash(dto.password) : null;

    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        const existing = (
          (await tx.execute(sql`select id from users where email = ${email} limit 1`)) as Array<{ id: string }>
        )[0];
        let userId = existing?.id;
        if (!userId) {
          const [u] = (await tx.execute(sql`
            insert into users (email, full_name, phone, password_hash, created_by, updated_by)
            values (${email}, ${dto.fullName}, ${dto.phone ?? null}, ${hash}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
            returning id`)) as Array<{ id: string }>;
          userId = u.id;
        }

        const clash = (
          (await tx.execute(sql`
            select 1 from tenant_memberships
            where tenant_id = ${ctx.tenantId}::uuid and user_id = ${userId}::uuid and role = ${dto.role} limit 1`)) as Array<unknown>
        )[0];
        if (clash) throw new ConflictException("user already has this role in the workspace");

        await tx.execute(sql`
          insert into tenant_memberships (tenant_id, user_id, role, workshop_branch_id, created_by, updated_by)
          values (${ctx.tenantId}::uuid, ${userId}::uuid, ${dto.role}, ${dto.workshopBranchId ?? null}::uuid,
            ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        return { userId, invited: !dto.password && !existing };
      },
    );
  }
}
