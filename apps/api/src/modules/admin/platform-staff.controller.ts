import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  addPlatformStaffSchema,
  PlatformStaffService,
  updatePlatformStaffSchema,
} from "./platform-staff.service.js";

/**
 * /admin/platform — the platform's OWN control surface (staff + the global people directory),
 * as opposed to /admin/users which manages members INSIDE one workspace.
 * Reads are open to platform staff; writes are super_admin-only (enforced in the service).
 */
@Controller("admin/platform")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class PlatformStaffController {
  constructor(private readonly svc: PlatformStaffService) {}

  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: null, userId: c.userId, isInternal: c.isInternal, platformRole: c.platformRole };
  }

  @Get("staff")
  list(@Req() req: Request) {
    return this.svc.list(this.ctx(req));
  }

  @Post("staff")
  add(@Req() req: Request, @Body() body: unknown) {
    return this.svc.add(this.ctx(req), addPlatformStaffSchema.parse(body));
  }

  @Patch("staff/:id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(this.ctx(req), id, updatePlatformStaffSchema.parse(body));
  }

  /** Every account across the platform with its platform role + workspace memberships. */
  @Get("users")
  globalUsers(@Req() req: Request, @Query("q") q?: string) {
    return this.svc.globalUsers(this.ctx(req), q);
  }
}
