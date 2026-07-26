import { Body, Controller, Get, Param, Post, Req, UseGuards, BadRequestException } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import {
  openExceptionSchema, resolveExceptionSchema, WorkflowExceptionsService,
} from "./exceptions.service.js";

/** Cancellation and return: raise one, see what is open, decide it. */
@Controller("workflow/exceptions")
@UseGuards(AuthGuard)
export class WorkflowExceptionsController {
  constructor(private readonly svc: WorkflowExceptionsService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment };
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.ctx(req));
  }

  @Post()
  open(@Req() req: Request, @Body() body: unknown) {
    return this.svc.open(this.ctx(req), openExceptionSchema.parse(body));
  }

  @Post(":id/resolve")
  resolve(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.resolve(this.ctx(req), id, resolveExceptionSchema.parse(body));
  }
}
