import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { DbService } from "../db/db.service.js";
import { resolveEnvironment, resolveTenantSlug, type RequestContext } from "./request-context.js";

const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? "qvm.localhost";

/**
 * Authenticates the JWT, resolves the active workspace (subdomain / X-Tenant), and computes
 * access (ADR-0010):
 *   - is_internal  ← the user has a platform_members row (Qparts staff → sees every workspace)
 *   - role         ← their tenant_memberships role for THIS workspace (company/workshop users)
 *   - access       ← platform staff OR a member of this workspace; otherwise 403
 * The resolved RequestContext is attached to req.ctx and fed into DbService.withContext so RLS
 * scopes every query. Bootstrap lookups run as internal (they precede tenant scoping).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly dbService: DbService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) throw new UnauthorizedException("missing bearer token");

    let userId: string;
    let impersonatorId: string | null = null;
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; imp?: string }>(auth.slice(7));
      userId = claims.sub;
      impersonatorId = claims.imp ?? null;
    } catch {
      throw new UnauthorizedException("invalid token");
    }

    const tenantSlug = resolveTenantSlug(req, ROOT_DOMAIN);

    const info = await this.dbService.withContext(
      { tenantId: null, userId, isInternal: true },
      async (tx) => {
        // reject a deactivated user even if their token is still within TTL (review #3)
        const user = (await tx.execute(sql`
          select is_active from users where id = ${userId}::uuid limit 1`))[0] as
          | { is_active?: boolean }
          | undefined;
        if (!user?.is_active) return { inactive: true } as const;

        // an impersonation token (`imp`) must keep re-validating the REAL actor: if the impersonator
        // is later deactivated the borrowed session dies immediately, not at TTL expiry.
        if (impersonatorId) {
          const actor = (await tx.execute(sql`
            select is_active from users where id = ${impersonatorId}::uuid limit 1`))[0] as
            | { is_active?: boolean }
            | undefined;
          if (!actor?.is_active) return { inactive: true } as const;
        }

        const platform = (await tx.execute(sql`
          select role from platform_members where user_id = ${userId}::uuid and is_active = true limit 1`))[0] as
          | { role?: string }
          | undefined;

        let tenant: { tenant_id?: string; role?: string } | undefined;
        let vendorAccess = false;
        let workshopAccess = false;
        if (tenantSlug) {
          tenant = (await tx.execute(sql`
            select t.id as tenant_id, m.role as role
            from tenants t
            left join tenant_memberships m
              on m.tenant_id = t.id and m.user_id = ${userId}::uuid and m.is_active = true
            where t.slug = ${tenantSlug} and t.is_active = true
            limit 1`))[0] as { tenant_id?: string; role?: string } | undefined;
          // vendor users access a workspace via their vendor's tenant_vendors link
          if (tenant?.tenant_id && !tenant.role) {
            vendorAccess = !!(
              (await tx.execute(sql`
                select 1 from vendor_users vu
                join tenant_vendors tv on tv.vendor_id = vu.vendor_id and tv.status = 'active'
                where vu.user_id = ${userId}::uuid and tv.tenant_id = ${tenant.tenant_id}::uuid limit 1`)) as Array<unknown>
            )[0];
          }
          // workshop users access a workspace via their workshop's tenant_workshops link
          if (tenant?.tenant_id && !tenant.role && !vendorAccess) {
            workshopAccess = !!(
              (await tx.execute(sql`
                select 1 from workshop_users wu
                join tenant_workshops tw on tw.workshop_id = wu.workshop_id and tw.status = 'active'
                where wu.user_id = ${userId}::uuid and tw.tenant_id = ${tenant.tenant_id}::uuid limit 1`)) as Array<unknown>
            )[0];
          }
        }
        return { inactive: false as const, platformRole: platform?.role ?? null, tenant, vendorAccess, workshopAccess };
      },
    );

    if ("inactive" in info && info.inactive) throw new UnauthorizedException("user is deactivated");
    const active = info as {
      platformRole: string | null;
      tenant?: { tenant_id?: string; role?: string };
      vendorAccess?: boolean;
      workshopAccess?: boolean;
    };
    const isInternal = active.platformRole != null;
    const ctx: RequestContext = {
      userId,
      tenantSlug,
      tenantId: active.tenant?.tenant_id ?? null,
      role:
        active.tenant?.role ??
        (active.vendorAccess ? "vendor" : active.workshopAccess ? "workshop" : active.platformRole),
      isInternal,
      platformRole: active.platformRole ?? null,
      environment: resolveEnvironment(req),
      impersonatorId,
    };

    // If a workspace was requested, require access (member, vendor/workshop link, or platform staff).
    if (tenantSlug) {
      if (!active.tenant?.tenant_id) throw new ForbiddenException("unknown or inactive workspace");
      if (!isInternal && !active.tenant.role && !active.vendorAccess && !active.workshopAccess) {
        throw new ForbiddenException("no access to this workspace");
      }
    }

    (req as Request & { ctx?: RequestContext }).ctx = ctx;
    return true;
  }
}
