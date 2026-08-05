import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { resolveCounterparty } from "../../common/counterparty.helpers.js";
import { resolvePersona } from "../../common/persona.helpers.js";
import { DbService } from "../../db/db.service.js";

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly dbService: DbService) {}

  /** Current user + the tenant/role resolved for this request, plus the resolved persona
   *  (which portal the frontend renders): platform | vendor | workshop | service_provider |
   *  internal | workspace.
   *
   *  INTERNAL IS NOT A FOURTH COUNTERPARTY. It is a service provider whose `scope` is 'internal' —
   *  the enum `provider_scope` has had exactly the two values internal|external since the entity was
   *  created, and one internal row (Qparts Logistics) predates this. So the back office gets its own
   *  PORTAL without its own TABLE: no internal_teams, no internal_team_users, no
   *  tenant_internal_teams shadowing three tables that already hold this. The split is here, at the
   *  last possible moment, where a portal is chosen — everything upstream (the guard, the tenant
   *  link, the activation lifecycle, RLS) stays one code path for all providers.
   *
   *  The cost of that choice, stated plainly: `ctx.role` is still "service_provider" for these users,
   *  because the guard does not read scope. Any future endpoint that must be internal-only has to
   *  check the scope itself rather than trust the role. */
  @Get()
  async me(@Req() req: Request) {
    const ctx = getContext(req);
    const info = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        const user = (
          (await tx.execute(sql`select id, email, full_name from users where id = ${ctx.userId}::uuid`)) as Array<{
            id: string;
            email: string;
            full_name: string;
          }>
        )[0];
        const platformRole = (
          (await tx.execute(sql`
            select role from platform_members where user_id = ${ctx.userId}::uuid and is_active = true limit 1`)) as Array<{ role: string }>
        )[0]?.role;
        // ONE canonical counterparty lookup (shared with account/portals — vendor wins over workshop).
        const cp = await resolveCounterparty(tx, ctx.userId);
        const isVendor = cp?.kind === "vendor";
        const isWorkshop = cp?.kind === "workshop";
        const isProvider = cp?.kind === "service_provider";
        // QNEW-71: the counterparty's own entity — activation lifecycle + individual/company type.
        const entity = cp
          ? ((await tx.execute(sql`
              select activation_status, counterparty_type from ${sql.raw(
                cp.kind === "vendor" ? "vendors" : cp.kind === "workshop" ? "workshops" : "service_providers",
              )}
              where id = ${cp.entityId}::uuid limit 1`)) as Array<{ activation_status: string; counterparty_type: string }>)[0]
          : undefined;
        // ONE persona implementation, shared with /nav. The shell /me picks and the tree /nav
        // returns have to agree or the sidebar navigates nowhere.
        const { persona, providerScope } = await resolvePersona(tx, ctx.userId, ctx.isInternal);
        const impersonator = ctx.impersonatorId
          ? ((await tx.execute(sql`select full_name from users where id = ${ctx.impersonatorId}::uuid limit 1`)) as Array<{ full_name: string }>)[0]
          : undefined;
        return { user, platformRole, isVendor, isWorkshop, isProvider, persona, providerScope, entity, impersonatorName: impersonator?.full_name ?? null };
      },
    );

    return {
      user: info.user,
      tenant: { slug: ctx.tenantSlug, id: ctx.tenantId },
      role: ctx.role,
      // Echo back the environment the SERVER actually resolved. resolveEnvironment() fails open to
      // 'live' on an absent/misspelled/proxy-stripped header, so a client that believes it is in
      // Sandbox has no other way to discover it is really writing to Live.
      environment: ctx.environment,
      isInternal: ctx.isInternal,
      platformRole: info.platformRole ?? null,
      isVendor: info.isVendor,
      isWorkshop: info.isWorkshop,
      providerScope: info.providerScope,
      activationStatus: info.entity?.activation_status ?? null,
      counterpartyType: info.entity?.counterparty_type ?? null,
      persona: info.persona,
      impersonating: !!ctx.impersonatorId,
      impersonatorName: info.impersonatorName,
    };
  }
}
