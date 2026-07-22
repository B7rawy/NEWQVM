import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { CreateRfqDto, createRfqSchema, RfqService } from "./rfq.service.js";

/**
 * RFQ domain — the entry point of the order chain. All tenant-scoped by RLS.
 * Create is limited to workshop roles (+ platform staff); vendors cannot create RFQs.
 */
@Controller("rfqs")
@UseGuards(AuthGuard, RolesGuard)
export class RfqController {
  constructor(private readonly rfq: RfqService) {}

  @Get()
  list(@Req() req: Request) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.rfq.list({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal });
  }

  @Post()
  @Roles("company_admin", "branch_manager", "service_advisor")
  create(@Req() req: Request, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    const dto: CreateRfqDto = createRfqSchema.parse(body);
    return this.rfq.create(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      dto,
    );
  }
}
