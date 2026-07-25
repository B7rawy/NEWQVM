import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { ProviderPortalService } from "./provider-portal.service.js";

/**
 * Service-provider portal. AuthGuard ONLY (no RolesGuard): a provider is cross-workspace and has no
 * single tenant, so the service derives the provider from service_provider_users and 403s anyone
 * else — the ownership WHERE clause is the boundary (same contract as the vendor/workshop portals).
 */
@Controller("provider")
@UseGuards(AuthGuard)
export class ProviderPortalController {
  constructor(private readonly svc: ProviderPortalService) {}

  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: null, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Get("overview")
  overview(@Req() req: Request) {
    return this.svc.overview(this.ctx(req));
  }
}
