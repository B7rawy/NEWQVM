import { BadRequestException, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { InvoiceService } from "./invoice.service.js";

@Controller("orders/:id/invoice")
@UseGuards(AuthGuard, RolesGuard)
export class InvoiceController {
  constructor(private readonly invoice: InvoiceService) {}

  @Post()
  @PlatformOnly()
  issue(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.invoice.issue(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }

  @Get()
  get(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.invoice.getForOrder(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
  }
}
