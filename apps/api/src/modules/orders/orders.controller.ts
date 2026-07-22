import { BadRequestException, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { OrdersService } from "./orders.service.js";

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Confirm an RFQ into an order — customer-side action (workshop roles) or platform staff. */
  @Post("rfqs/:id/confirm")
  @Roles("company_admin", "branch_manager", "service_advisor")
  confirm(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.orders.confirm(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }

  @Get("orders")
  list(@Req() req: Request) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.orders.list({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal });
  }
}
