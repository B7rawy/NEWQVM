import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { RlsContext } from "../db/db.service.js";

/**
 * Resolve the workspace a write is FOR (the one shared implementation — was duplicated in
 * VendorsService and CounterpartyService): platform staff may target any workspace via
 * dto.tenantId; everyone else is pinned to their active workspace.
 */
export function targetTenant(ctx: RlsContext, dtoTenantId?: string): string {
  if (dtoTenantId && dtoTenantId !== ctx.tenantId && !ctx.isInternal)
    throw new ForbiddenException("only platform staff can target another workspace");
  const target = ctx.isInternal ? dtoTenantId ?? ctx.tenantId : ctx.tenantId;
  if (!target) throw new BadRequestException("no target workspace resolved (subdomain / X-Tenant)");
  return target;
}
