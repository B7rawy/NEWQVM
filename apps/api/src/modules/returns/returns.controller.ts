import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createReturnSchema, ReturnsService } from "./returns.service.js";

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  /** Workshop requests a return of delivered items. */
  @Post("orders/:id/returns")
  @Roles("company_admin", "branch_manager", "service_advisor")
  create(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.returns.create(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal, environment: ctx.environment, impersonatorId: ctx.impersonatorId },
      id,
      createReturnSchema.parse(body),
    );
  }

  @Get("orders/:id/returns")
  list(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.returns.listForOrder(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal, environment: ctx.environment, impersonatorId: ctx.impersonatorId },
      id,
    );
  }

  /** Finance issues the credit note for a return — internal only. */
  @Post("returns/:returnId/credit-note")
  @PlatformOnly()
  issueCreditNote(@Req() req: Request, @Param("returnId") returnId: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.returns.issueCreditNote(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal, environment: ctx.environment, impersonatorId: ctx.impersonatorId },
      returnId,
    );
  }
}
