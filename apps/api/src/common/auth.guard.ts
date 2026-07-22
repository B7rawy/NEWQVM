import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { DbService } from "../db/db.service.js";
import { isInternalRole, resolveTenantSlug, type RequestContext } from "./request-context.js";

const ROOT_DOMAIN = process.env.APP_ROOT_DOMAIN ?? "qvm.localhost";

/**
 * Authenticates the JWT, resolves the current tenant (subdomain / X-Tenant), and computes the
 * user's role + is_internal for that tenant. The resolved RequestContext is attached to req.ctx
 * and later fed into DbService.withContext so RLS scopes every query. Tenant + membership lookups
 * run as internal (bootstrap) since they precede tenant scoping.
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
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(auth.slice(7));
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException("invalid token");
    }

    const tenantSlug = resolveTenantSlug(req, ROOT_DOMAIN);

    const ctx: RequestContext = {
      userId,
      tenantSlug,
      tenantId: null,
      role: null,
      isInternal: false,
    };

    if (tenantSlug) {
      // bootstrap lookup as internal (precedes tenant scoping)
      const rows = await this.dbService.withContext(
        { tenantId: null, userId, isInternal: true },
        (tx) =>
          tx.execute(sql`
            select t.id as tenant_id, m.role as role
            from tenants t
            left join tenant_memberships m on m.tenant_id = t.id and m.user_id = ${userId}::uuid
            where t.slug = ${tenantSlug} and t.is_active = true
            limit 1`),
      );
      const row = rows[0] as { tenant_id?: string; role?: string } | undefined;
      if (row?.tenant_id) {
        ctx.tenantId = row.tenant_id;
        ctx.role = row.role ?? null;
        ctx.isInternal = isInternalRole(row.role);
      }
    }

    (req as Request & { ctx?: RequestContext }).ctx = ctx;
    return true;
  }
}
