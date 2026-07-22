import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { DbService } from "../../db/db.service.js";

/**
 * Workspace switcher backbone (ADR-0010). Returns every workspace the caller can access,
 * from the three identity layers:
 *   - platform staff  → all active tenants
 *   - workshop users  → tenants where they have a membership
 *   - vendor users    → tenants their vendor is linked to (tenant_vendors)
 * The frontend renders these as a switcher; switching = navigating to the workspace subdomain.
 */
@Controller("workspaces")
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(private readonly dbService: DbService) {}

  @Get()
  async list(@Req() req: Request) {
    const ctx = getContext(req);
    const rows = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true },
      (tx) =>
        tx.execute(sql`
          with accessible as (
            -- platform staff → all active workspaces
            select t.id, t.slug, t.name, t.is_sandbox, 'platform'::text as via,
                   (select p.role::text from platform_members p
                    where p.user_id = ${ctx.userId}::uuid and p.is_active = true limit 1) as role
            from tenants t
            where t.is_active = true
              and exists (select 1 from platform_members p
                          where p.user_id = ${ctx.userId}::uuid and p.is_active = true)
            union
            -- workshop membership
            select t.id, t.slug, t.name, t.is_sandbox, 'membership'::text as via, m.role::text
            from tenant_memberships m
            join tenants t on t.id = m.tenant_id and t.is_active = true
            where m.user_id = ${ctx.userId}::uuid and m.is_active = true
            union
            -- vendor user → linked workspaces
            select t.id, t.slug, t.name, t.is_sandbox, 'vendor'::text as via, 'vendor'::text as role
            from vendor_users vu
            join tenant_vendors tv on tv.vendor_id = vu.vendor_id and tv.status = 'active'
            join tenants t on t.id = tv.tenant_id and t.is_active = true
            where vu.user_id = ${ctx.userId}::uuid
          )
          select distinct id, slug, name, is_sandbox, via, role from accessible order by name`),
    );
    return { count: rows.length, workspaces: rows };
  }
}
