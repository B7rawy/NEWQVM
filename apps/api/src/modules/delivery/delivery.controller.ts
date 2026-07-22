import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createDeliverySchema, DeliveryService } from "./delivery.service.js";

@Controller("orders/:id/deliveries")
@UseGuards(AuthGuard, RolesGuard)
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.delivery.create(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
      createDeliverySchema.parse(body),
    );
  }

  @Get()
  list(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.delivery.listForOrder(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }
}
