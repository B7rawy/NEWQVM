import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createVendorBranchSchema, createVendorSchema, VendorsService } from "./vendors.service.js";

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

  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(this.ctx(req), createVendorSchema.parse(body));
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
