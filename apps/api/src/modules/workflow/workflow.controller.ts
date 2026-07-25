import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { assistSchema, createFlowSchema, saveGraphSchema, WorkflowService } from "./workflow.service.js";

/**
 * /admin/workflows — authoring surface for the workflow engine (QNEW-64).
 *
 * PlatformOnly at the door; super_admin enforced per-write in the service (same split as
 * /admin/platform: platform staff may LOOK, only a super admin may CHANGE).
 *
 * Every route is scoped to the caller's active workspace AND environment, so a flow is built and
 * tested in Sandbox and activated separately in Live (ADR-0012).
 */
@Controller("admin/workflows")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  private ctx(req: Request) {
    const c = getContext(req);
    return {
      tenantId: c.tenantId,
      userId: c.userId,
      isInternal: c.isInternal,
      environment: c.environment,
      impersonatorId: c.impersonatorId,
      platformRole: c.platformRole,
    };
  }

  /** The governed vocabulary the canvas and the AI may reference — statuses + roles. */
  @Get("catalog")
  catalog(@Req() req: Request) {
    return this.svc.catalog(this.ctx(req));
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.ctx(req));
  }

  /** Full graph for the canvas. */
  /** Not under :id — this is about the USER, not one flow. Declared BEFORE @Get(":id"), which
   *  would otherwise match "my-work" as a flow id. */
  @Get("my-work")
  myWork(@Req() req: Request) {
    return this.svc.myWork(this.ctx(req));
  }

  @Get(":id")
  get(@Req() req: Request, @Param("id") id: string) {
    return this.svc.get(this.ctx(req), id);
  }

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(this.ctx(req), createFlowSchema.parse(body));
  }

  /** Replace a draft's whole graph. The canvas sends this on save; the AI produces the same shape. */
  @Put(":id/graph")
  saveGraph(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.saveGraph(this.ctx(req), id, saveGraphSchema.parse(body));
  }

  /** Draft a graph from a description. Returns a PROPOSAL — the canvas renders it, the human saves. */
  @Post("/records/:entity/:id/claim")
  claim(@Req() req: Request, @Param("entity") entity: string, @Param("id") id: string, @Body() body: { userId?: string }) {
    return this.svc.claim(this.ctx(req), entity, id, body?.userId);
  }

  @Post(":id/assist")
  assist(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.assist(this.ctx(req), id, assistSchema.parse(body));
  }

  @Post(":id/activate")
  activate(@Req() req: Request, @Param("id") id: string) {
    return this.svc.activate(this.ctx(req), id);
  }

  @Post(":id/retire")
  retire(@Req() req: Request, @Param("id") id: string) {
    return this.svc.retire(this.ctx(req), id);
  }

  /** The supported way to change an active flow: clone it to a new draft. */
  @Post(":id/new-version")
  newVersion(@Req() req: Request, @Param("id") id: string) {
    return this.svc.newVersion(this.ctx(req), id);
  }

  @Delete(":id")
  remove(@Req() req: Request, @Param("id") id: string) {
    return this.svc.remove(this.ctx(req), id);
  }
}
