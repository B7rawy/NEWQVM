import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { addUserSchema, COMPANY_ROLES, UsersAdminService } from "./users-admin.service.js";

/** Workspace users + permissions. Platform staff or company_admin. */
@Controller("admin/users")
@UseGuards(AuthGuard, RolesGuard)
export class UsersAdminController {
  constructor(private readonly svc: UsersAdminService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Get("roles")
  roles() {
    return { roles: COMPANY_ROLES };
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.ctx(req));
  }

  @Post()
  @Roles("company_admin")
  add(@Req() req: Request, @Body() body: unknown) {
    return this.svc.add(this.ctx(req), addUserSchema.parse(body));
  }
}
