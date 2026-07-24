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

      const allowed = actorIsInternal
        ? true
        : !!(
            (await tx.execute(sql`
              select 1 where
                exists (
                  select 1 from tenant_memberships am
                  join tenant_memberships tm on tm.tenant_id = am.tenant_id and tm.is_active
                  where am.user_id = ${actorId}::uuid and am.role = 'company_admin' and am.is_active
                    and tm.user_id = ${targetUserId}::uuid
                )
                or exists (
                  select 1 from tenant_memberships am
                  join tenant_vendors tv on tv.tenant_id = am.tenant_id and tv.status = 'active'
                  join vendor_users vu on vu.vendor_id = tv.vendor_id
                  where am.user_id = ${actorId}::uuid and am.role = 'company_admin' and am.is_active
                    and vu.user_id = ${targetUserId}::uuid
                )`)) as Array<unknown>
          )[0];
      if (!allowed) throw new ForbiddenException("not allowed to view as this user");

      // Platform-level audit trail (spans workspaces).
      await tx.execute(sql`
        insert into platform_audit (actor_user_id, action, entity_type, entity_id, metadata)
        values (${actorId}::uuid, 'impersonate.start', 'user', ${targetUserId}::uuid,
                ${JSON.stringify({ target: target.full_name })}::jsonb)`);
      this.logger.warn(`impersonate.start actor=${actorId} target=${targetUserId} (${target.full_name})`);

      const token = await this.jwt.signAsync({ sub: target.id, imp: actorId });
      return { token, user: { id: target.id, fullName: target.full_name } };
    });
  }
}
