import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  createVendorBranchSchema,
  createVendorSchema,
  linkVendorSchema,
  updateVendorSchema,
  vendorStatusSchema,
  VendorsService,
} from "./vendors.service.js";

/** Vendors linked to the active workspace. Vendors are global; creating/linking is platform-only. */
@Controller("vendors")
@UseGuards(AuthGuard, RolesGuard)
export class VendorsController {
  constructor(private readonly svc: VendorsService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }
  /** Read-only ctx that allows no active workspace (platform staff → global list). */
  private ctxOpen(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.ctxOpen(req));
  }

  @Get("available")
  @PlatformOnly()
  available(@Req() req: Request, @Query("tenantId") tenantId?: string) {
    return this.svc.available(this.ctxOpen(req), tenantId);
  }

  /** One vendor's own page: identity + branches + accounts + workspaces + quotations + won orders.
   *  Declared AFTER the literal "available" route so that path is not swallowed by :id. */
  @Get(":id")
  detail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.detail(this.ctxOpen(req), id);
  }

  // Directory identity writes are platform-only; a workspace onboards via POST /counterparty/submissions.
  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(this.ctxOpen(req), createVendorSchema.parse(body));
  }

  @Patch(":id")
  @PlatformOnly()
  update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(this.ctxOpen(req), id, updateVendorSchema.parse(body));
  }

  @Post(":id/status")
  @Roles("company_admin")
  setStatus(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setStatus(this.ctxOpen(req), id, vendorStatusSchema.parse(body));
  }

  @Post(":id/link")
  @PlatformOnly()
  link(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.link(this.ctxOpen(req), id, linkVendorSchema.parse(body));
  }

  @Get(":id/branches")
  branches(@Req() req: Request, @Param("id") id: string) {
    return this.svc.listBranches(this.ctx(req), id);
  }

  @Post("branches")
  @Roles("company_admin")
  createBranch(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createBranch(this.ctx(req), createVendorBranchSchema.parse(body));
  }
}
