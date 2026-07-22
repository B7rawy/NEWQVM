import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
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
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.ctx(req));
  }

  @Get("available")
  @PlatformOnly()
  available(@Req() req: Request, @Query("tenantId") tenantId?: string) {
    return this.svc.available(this.ctx(req), tenantId);
  }

  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(this.ctx(req), createVendorSchema.parse(body));
  }

  @Patch(":id")
  @PlatformOnly()
  update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(this.ctx(req), id, updateVendorSchema.parse(body));
  }

  @Post(":id/status")
  @PlatformOnly()
  setStatus(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setStatus(this.ctx(req), id, vendorStatusSchema.parse(body));
  }

  @Post(":id/link")
  @PlatformOnly()
  link(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.link(this.ctx(req), id, linkVendorSchema.parse(body));
  }

  @Get(":id/branches")
  branches(@Req() req: Request, @Param("id") id: string) {
    return this.svc.listBranches(this.ctx(req), id);
  }

  @Post("branches")
  @PlatformOnly()
  createBranch(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createBranch(this.ctx(req), createVendorBranchSchema.parse(body));
  }
}
