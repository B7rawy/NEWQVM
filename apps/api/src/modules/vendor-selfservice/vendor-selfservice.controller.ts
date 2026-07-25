import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  pricingPolicySchema,
  upsertStockSchema,
  VendorSelfServiceService,
} from "./vendor-selfservice.service.js";

/**
 * Vendor self-service (QNEW-49/51). Gated @PlatformOnly for now (internal manages on behalf);
 * full vendor-role self-service opens once vendor-user auth is wired into the guard.
 */
@Controller("vendor-selfservice")
@UseGuards(AuthGuard, RolesGuard)
export class VendorSelfServiceController {
  constructor(private readonly svc: VendorSelfServiceService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Post("stock")
  @PlatformOnly()
  upsertStock(@Req() req: Request, @Body() body: unknown) {
    return this.svc.upsertStock(this.ctx(req), upsertStockSchema.parse(body));
  }

  @Get("stock/:vendorId")
  @PlatformOnly()
  listStock(@Req() req: Request, @Param("vendorId") vendorId: string, @Query("mask") mask?: string) {
    return this.svc.listStock(this.ctx(req), vendorId, mask === "1");
  }

  @Post("pricing-policy")
  @PlatformOnly()
  setPolicy(@Req() req: Request, @Body() body: unknown) {
    return this.svc.setPricingPolicy(this.ctx(req), pricingPolicySchema.parse(body));
  }

  @Get("resolve-price")
  @PlatformOnly()
  resolve(
    @Req() req: Request,
    @Query("vendorId") vendorId: string,
    @Query("base") base: string,
    @Query("regionId") regionId?: string,
    @Query("branchId") branchId?: string,
  ) {
    const b = Number(base);
    if (!vendorId || !Number.isFinite(b)) throw new BadRequestException("vendorId and base required");
    return this.svc.resolvePrice(this.ctx(req), vendorId, b, {
      regionId,
      workshopBranchId: branchId,
    });
  }
}
