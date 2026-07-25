import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createInsurerSchema, InsuranceService, setPayerSchema } from "./insurance.service.js";

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class InsuranceController {
  constructor(private readonly ins: InsuranceService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Post("insurance/companies")
  @PlatformOnly()
  createCompany(@Req() req: Request, @Body() body: unknown) {
    return this.ins.createCompany(this.ctx(req), createInsurerSchema.parse(body));
  }

  @Get("insurance/companies")
  listCompanies(@Req() req: Request) {
    return this.ins.listCompanies(this.ctx(req));
  }

  /** Payer type is internal-only (QNEW-43). */
  @Post("rfqs/:id/payer")
  @PlatformOnly()
  setPayer(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.ins.setPayer(this.ctx(req), id, setPayerSchema.parse(body));
  }

  @Post("rfqs/:id/insurance/send-for-approval")
  @PlatformOnly()
  send(@Req() req: Request, @Param("id") id: string) {
    return this.ins.sendForApproval(this.ctx(req), id);
  }

  /** Workshop marks the insurer's approval (QNEW-45). */
  @Post("rfqs/:id/insurance/approve")
  @Roles("company_admin", "branch_manager", "service_advisor")
  approve(@Req() req: Request, @Param("id") id: string) {
    return this.ins.markApproved(this.ctx(req), id);
  }
}
