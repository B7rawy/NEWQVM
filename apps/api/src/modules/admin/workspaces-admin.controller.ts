import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  WorkspacesAdminService,
} from "./workspaces-admin.service.js";
import { updateMembershipSchema, UsersAdminService } from "./users-admin.service.js";

/** /admin/workspaces — platform-staff management of tenants (the root of the hierarchy). */
@Controller("admin/workspaces")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class WorkspacesAdminController {
  constructor(
    private readonly svc: WorkspacesAdminService,
    private readonly users: UsersAdminService,
  ) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(getContext(req).userId!, createWorkspaceSchema.parse(body));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Get(":id/detail")
  detail(@Param("id") id: string) {
    return this.svc.detail(id);
  }

  @Patch(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(getContext(req).userId!, id, updateWorkspaceSchema.parse(body));
  }

  /** Super-admin: edit a membership INSIDE a specific workspace (cross-workspace entrance). */
  @Patch(":id/members/:membershipId")
  updateMember(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @Body() body: unknown,
  ) {
    const ctx = getContext(req);
    return this.users.updateMembership(
      { tenantId: id, userId: ctx.userId, isInternal: true, impersonatorId: ctx.impersonatorId },
      membershipId,
      updateMembershipSchema.parse(body),
    );
  }
}
