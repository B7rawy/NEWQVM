import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { createRequestSchema, WorkshopPortalService } from "./workshop-portal.service.js";

/**
 * Workshop portal (cross-workspace). AuthGuard only — the service scopes by workshop ownership
 * (workshop_users) and 403s a non-workshop; no tenant/role context needed.
 */
@Controller("workshop")
@UseGuards(AuthGuard)
export class WorkshopPortalController {
  constructor(private readonly svc: WorkshopPortalService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Get("overview")
  overview(@Req() req: Request) {
    return this.svc.overview(this.ctx(req));
  }

  @Get("requests")
  requests(@Req() req: Request) {
    return this.svc.requests(this.ctx(req));
  }

  @Get("context")
  context(@Req() req: Request) {
    return this.svc.context(this.ctx(req));
  }

  @Get("requests/:id")
  requestDetail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.requestDetail(this.ctx(req), id);
  }

  @Post("requests")
  createRequest(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createRequest(this.ctx(req), createRequestSchema.parse(body));
  }
}
