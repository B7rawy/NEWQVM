import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { impersonateSchema, ImpersonationService } from "./impersonation.service.js";

/**
 * "View as" — an admin acts as another user without logging out. AuthGuard only (NOT @PlatformOnly)
 * on purpose: authority is mixed — platform staff can view-as anyone, a company_admin can view-as
 * users in their own workspace — so it's enforced in ImpersonationService.start(), not by a role guard.
 */
@Controller("admin/impersonate")
@UseGuards(AuthGuard)
export class ImpersonationController {
  constructor(private readonly svc: ImpersonationService) {}

  @Post()
  start(@Req() req: Request, @Body() body: unknown) {
    const ctx = getContext(req);
    // No chaining: you must return to your real identity before viewing as someone else. This keeps
    // the actor unambiguous and prevents an impersonated (lower-privilege) identity from re-scoping.
    if (ctx.impersonatorId) throw new ForbiddenException("stop the current 'view as' before starting another");
    const { userId } = impersonateSchema.parse(body);
    return this.svc.start(ctx.userId!, ctx.isInternal, userId);
  }
}
