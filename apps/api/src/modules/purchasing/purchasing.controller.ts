import { BadRequestException, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { PurchasingService } from "./purchasing.service.js";

/** Purchasing — internal (Qparts) action: turn a confirmed order into vendor purchase orders. */
@Controller("orders/:id/purchase-orders")
@UseGuards(AuthGuard, RolesGuard)
export class PurchasingController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.purchasing.createForOrder(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }

  @Get()
  @PlatformOnly()
  list(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.purchasing.listForOrder(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }
}
