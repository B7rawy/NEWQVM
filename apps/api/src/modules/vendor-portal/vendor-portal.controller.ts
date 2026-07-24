import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { submitQuoteSchema, VendorPortalService } from "./vendor-portal.service.js";

/**
 * Vendor portal (cross-workspace). AuthGuard only — the service derives vendor_id from vendor_users
 * and 403s a non-vendor, so no tenant/role context is required (a vendor has no single workspace).
 */
@Controller("vendor")
@UseGuards(AuthGuard)
export class VendorPortalController {
  constructor(private readonly svc: VendorPortalService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Get("overview")
  overview(@Req() req: Request) {
    return this.svc.overview(this.ctx(req));
  }

  @Get("quotations")
  quotations(@Req() req: Request) {
    return this.svc.quotations(this.ctx(req));
  }

  @Get("quotations/:id")
  quotationDetail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.quotationDetail(this.ctx(req), id);
  }

  @Post("quotations/:id/quote")
  submitQuote(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.submitQuote(this.ctx(req), id, submitQuoteSchema.parse(body));
  }
}
