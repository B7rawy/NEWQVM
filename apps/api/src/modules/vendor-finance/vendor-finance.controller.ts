import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { financingSchema, recordPaymentSchema, VendorFinanceService } from "./vendor-finance.service.js";

/** Vendor financials + financing (QNEW-50/52) — internal (finance). */
@Controller("vendor-finance")
@UseGuards(AuthGuard, RolesGuard)
export class VendorFinanceController {
  constructor(private readonly svc: VendorFinanceService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Post("payments")
  @PlatformOnly()
  pay(@Req() req: Request, @Body() body: unknown) {
    return this.svc.recordPayment(this.ctx(req), recordPaymentSchema.parse(body));
  }

  @Get("statement/:vendorId")
  @PlatformOnly()
  statement(@Req() req: Request, @Param("vendorId") vendorId: string) {
    return this.svc.statement(this.ctx(req), vendorId);
  }

  @Post("financing")
  @PlatformOnly()
  financing(@Req() req: Request, @Body() body: unknown) {
    return this.svc.requestFinancing(this.ctx(req), financingSchema.parse(body));
  }
}
