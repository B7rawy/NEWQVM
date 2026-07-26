import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { actSchema, ApprovalsService, createPolicySchema, requestMoveSchema, submitSchema } from "./approvals.service.js";

@Controller("approvals")
@UseGuards(AuthGuard, RolesGuard)
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  /** What is waiting on me, what I asked for, and what was approved but never acted on. */
  @Get()
  inbox(@Req() req: Request) {
    return this.svc.inbox(this.ctx(req));
  }

  @Post("request-move")
  requestMove(@Req() req: Request, @Body() body: unknown) {
    return this.svc.requestForMove(this.ctx(req), requestMoveSchema.parse(body));
  }


  @Post("policies")
  @PlatformOnly()
  createPolicy(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createPolicy(this.ctx(req), createPolicySchema.parse(body));
  }

  @Post("requests")
  @PlatformOnly()
  submit(@Req() req: Request, @Body() body: unknown) {
    return this.svc.submit(this.ctx(req), submitSchema.parse(body));
  }

  /** The current level's named approver acts. Anyone authenticated may attempt; the service checks. */
  @Post("requests/:id/act")
  act(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.act(this.ctx(req), id, actSchema.parse(body));
  }

  @Get("requests/:id")
  get(@Req() req: Request, @Param("id") id: string) {
    return this.svc.get(this.ctx(req), id);
  }
}
