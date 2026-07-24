import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { AccountService, activateSchema } from "./account.service.js";

/** Self-service account actions for a signed-in counterparty (QNEW-71). */
@Controller("account")
@UseGuards(AuthGuard)
export class AccountController {
  constructor(private readonly svc: AccountService) {}

  /** Complete activation of a pending self-registered account. */
  @Post("activate")
  activate(@Req() req: Request, @Body() body: unknown) {
    const c = getContext(req);
    return this.svc.activate({ tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal }, activateSchema.parse(body));
  }
}
