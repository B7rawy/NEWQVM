import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { createBranchSchema, createWorkshopSchema, OrgService } from "./org.service.js";

/** Workshops + branches management (tenant-scoped). Platform staff or company_admin. */
@Controller("org")
@UseGuards(AuthGuard, RolesGuard)
export class OrgController {
  constructor(private readonly svc: OrgService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }
  /** Read-only ctx that allows no active workspace (platform staff → global list). */
  private ctxOpen(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Get("workshops")
  listWorkshops(@Req() req: Request) {
    return this.svc.listWorkshops(this.ctxOpen(req));
  }

  // Workshop identity writes are platform-only; a workspace onboards via POST /counterparty/submissions.
  @Post("workshops")
  @PlatformOnly()
  createWorkshop(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createWorkshop(this.ctx(req), createWorkshopSchema.parse(body));
  }

  @Get("branches")
  listBranches(@Req() req: Request) {
    return this.svc.listBranches(this.ctxOpen(req));
  }

  @Post("branches")
  @Roles("company_admin")
  createBranch(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createBranch(this.ctx(req), createBranchSchema.parse(body));
  }

  @Get("regions")
  regions(@Req() req: Request) {
    return this.svc.regions(this.ctxOpen(req));
  }

  @Get("cities")
  cities(@Req() req: Request, @Query("regionId") regionId?: string) {
    return this.svc.cities(this.ctxOpen(req), regionId);
  }
}
