import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { PurchasingService } from "./purchasing.service.js";

const recordInvoiceSchema = z.object({ amount: z.number().finite().positive() });

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

/** PO-level actions (internal): record the vendor invoice total (feeds statement + allocation caps). */
@Controller("purchase-orders")
@UseGuards(AuthGuard, RolesGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchasing: PurchasingService) {}

  @Post(":poId/invoice")
  @PlatformOnly()
  recordInvoice(@Req() req: Request, @Param("poId") poId: string, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    const dto = recordInvoiceSchema.parse(body);
    return this.purchasing.recordInvoice(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      poId,
      dto.amount,
    );
  }
}
