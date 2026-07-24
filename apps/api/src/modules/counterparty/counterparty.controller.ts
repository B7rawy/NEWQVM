import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  approveSchema,
  CounterpartyService,
  importSchema,
  mergeSchema,
  rejectSchema,
  submitCounterpartySchema,
} from "./counterparty.service.js";

/**
 * Governed counterparty onboarding (QNEW-71). Workspaces SUBMIT proposed vendors/workshops
 * (company_admin); platform staff review the queue and approve / merge / reject. The directory
 * itself is never written by a workspace.
 */
@Controller("counterparty")
@UseGuards(AuthGuard, RolesGuard)
export class CounterpartyController {
  constructor(private readonly svc: CounterpartyService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  /** Workspace: propose a counterparty (auto-links on exact key, else queues for review). */
  @Post("submissions")
  @Roles("company_admin")
  submit(@Req() req: Request, @Body() body: unknown) {
    return this.svc.submit(this.ctx(req), submitCounterpartySchema.parse(body));
  }

  /** Workspace: my own submissions + their status. */
  @Get("submissions")
  @Roles("company_admin")
  listMine(@Req() req: Request) {
    return this.svc.listMine(this.ctx(req));
  }

  /** Workspace: bulk import (client parses the Excel/CSV → rows; server validates + stages a batch). */
  @Post("import")
  @Roles("company_admin")
  importRows(@Req() req: Request, @Body() body: unknown) {
    return this.svc.importRows(this.ctx(req), importSchema.parse(body));
  }

  /** Platform: the review queue (every pending submission across workspaces). */
  @Get("review")
  @PlatformOnly()
  listReview(@Req() req: Request) {
    return this.svc.listReview(this.ctx(req));
  }

  /** Platform: create a new directory identity + link it to the requesting workspace. */
  @Post("submissions/:id/approve")
  @PlatformOnly()
  approve(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.approve(this.ctx(req), id, approveSchema.parse(body));
  }

  /** Platform: link an existing directory identity to the requesting workspace (dedupe). */
  @Post("submissions/:id/merge")
  @PlatformOnly()
  merge(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.merge(this.ctx(req), id, mergeSchema.parse(body));
  }

  /** Platform: reject a submission (directory untouched). */
  @Post("submissions/:id/reject")
  @PlatformOnly()
  reject(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.reject(this.ctx(req), id, rejectSchema.parse(body));
  }
}
