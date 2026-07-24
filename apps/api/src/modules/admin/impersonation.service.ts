import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

const INTERNAL: RlsContext = { tenantId: null, userId: null, isInternal: true };

export const impersonateSchema = z.object({ userId: z.string().uuid() });

/**
 * "View as" (impersonation). An admin gets a token acting AS a target user — no logout needed — and
 * returns with the original token. Authority:
 *   - platform staff (super_admin/staff): impersonate ANY active user.
 *   - company_admin: only users inside a workspace they administer (members + linked vendor users).
 * Every start is written to audit_log with the real actor (the JWT carries `imp` = actor id).
 */
@Injectable()
export class ImpersonationService {
  private readonly logger = new Logger("Impersonation");
  constructor(
    private readonly dbService: DbService,
    private readonly jwt: JwtService,
  ) {}

  async start(actorId: string, actorIsInternal: boolean, targetUserId: string) {
    if (targetUserId === actorId) throw new ForbiddenException("cannot impersonate yourself");

    return this.dbService.withContext({ ...INTERNAL, userId: actorId }, async (tx) => {
      const target = (
        (await tx.execute(sql`
          select id, full_name, is_active from users where id = ${targetUserId}::uuid limit 1`)) as Array<{
          id: string;
          full_name: string;
          is_active: boolean;
        }>
      )[0];
      if (!target || !target.is_active) throw new NotFoundException("target user not found or inactive");

      // SECURITY: a non-internal actor may NEVER impersonate platform staff. Without this, a
      // company_admin could attach a platform account to their workspace (via add-member) and then
      // impersonate it — becoming super_admin (the guard derives isInternal from the token's sub).
      if (!actorIsInternal) {
        const targetIsPlatform = (
          (await tx.execute(sql`
            select 1 from platform_members where user_id = ${targetUserId}::uuid and is_active limit 1`)) as Array<unknown>
        )[0];
        if (targetIsPlatform) throw new ForbiddenException("cannot view as platform staff");
      }

      // A company_admin's authority is bounded by the ONE workspace that justifies the grant. The
      // borrowed token is stamped with it (impTenant) and the guard refuses any other workspace —
      // otherwise impersonating a member of several workspaces would hand the actor a workspace
      // they have no membership in (cross-tenant escalation).
      let impTenant: string | null = null;
      if (!actorIsInternal) {
        const grant = (await tx.execute(sql`
          select am.tenant_id from tenant_memberships am
          where am.user_id = ${actorId}::uuid and am.role = 'company_admin' and am.is_active
            and (
              exists (select 1 from tenant_memberships tm
                      where tm.tenant_id = am.tenant_id and tm.is_active and tm.user_id = ${targetUserId}::uuid)
              or exists (select 1 from tenant_vendors tv
                         join vendor_users vu on vu.vendor_id = tv.vendor_id
                         where tv.tenant_id = am.tenant_id and tv.status = 'active' and vu.user_id = ${targetUserId}::uuid)
              or exists (select 1 from tenant_workshops tw
                         join workshop_users wu on wu.workshop_id = tw.workshop_id
                         where tw.tenant_id = am.tenant_id and tw.status = 'active' and wu.user_id = ${targetUserId}::uuid)
            )
          limit 1`))[0] as { tenant_id: string } | undefined;
        if (!grant) throw new ForbiddenException("not allowed to view as this user");
        impTenant = grant.tenant_id;
      } else {
        // Platform tier: staff may view as counterparties/workspace users, but NEVER as another
        // platform staffer — that would let any staffer inherit super_admin.
        const targetIsPlatform = (await tx.execute(sql`
          select 1 from platform_members where user_id = ${targetUserId}::uuid and is_active limit 1`))[0];
        if (targetIsPlatform) throw new ForbiddenException("platform staff cannot be viewed as");
      }

      // Platform-level audit trail (spans workspaces).
      await tx.execute(sql`
        insert into platform_audit (actor_user_id, action, entity_type, entity_id, metadata)
        values (${actorId}::uuid, 'impersonate.start', 'user', ${targetUserId}::uuid,
                ${JSON.stringify({ target: target.full_name, scopedToTenant: impTenant })}::jsonb)`);
      this.logger.warn(`impersonate.start actor=${actorId} target=${targetUserId} (${target.full_name})`);

      // Short-lived on purpose: "Back to admin" is client-side, so the borrowed token must expire
      // on its own rather than living for the full login TTL.
      const token = await this.jwt.signAsync(
        { sub: target.id, imp: actorId, ...(impTenant ? { impTenant } : {}) },
        { expiresIn: process.env.IMPERSONATION_TTL ?? "30m" },
      );
      return { token, user: { id: target.id, fullName: target.full_name } };
    });
  }
}
