import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createRuleSchema, VendorAssignmentService } from "./vendor-assignment.service.js";

/** Auto vendor assignment (QNEW-29) — internal (purchasing) configuration + suggestion. */
@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class VendorAssignmentController {
  constructor(private readonly svc: VendorAssignmentService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Post("vendor-selection-rules")
  @PlatformOnly()
  createRule(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createRule(this.ctx(req), createRuleSchema.parse(body));
  }

  @Get("rfqs/:id/suggested-vendors")
  @PlatformOnly()
  suggest(@Req() req: Request, @Param("id") id: string) {
    return this.svc.suggest(this.ctx(req), id);
  }
}
