import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { impersonateSchema, ImpersonationService } from "./impersonation.service.js";

/** "View as" — an admin acts as another user without logging out. */
@Controller("admin/impersonate")
@UseGuards(AuthGuard)
export class ImpersonationController {
  constructor(private readonly svc: ImpersonationService) {}

  @Post()
  start(@Req() req: Request, @Body() body: unknown) {
    const ctx = getContext(req);
    // the REAL actor is the impersonator if already impersonating, else the current user — but you
    // can only start an impersonation as your true self, so use the effective actor here.
    const { userId } = impersonateSchema.parse(body);
    return this.svc.start(ctx.userId!, ctx.isInternal, userId);
  }
}
