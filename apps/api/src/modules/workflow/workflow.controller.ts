import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, WorkspaceRoute } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  actionEntrySchema, assistSchema, createFlowSchema, placementSchema, saveGraphSchema,
  WorkflowService,
} from "./workflow.service.js";
import { WorkflowTemplateService } from "./template.service.js";

/**
 * /admin/workflows — authoring surface for the workflow engine (QNEW-64).
 *
 * PlatformOnly at the door; super_admin enforced per-write in the service (same split as
 * /admin/platform: platform staff may LOOK, only a super admin may CHANGE).
 *
 * TWO ROUTES ARE NOT AUTHORING AND ARE MARKED @WorkspaceRoute: my-work and claim. They are the
 * workspace's own queue, and the class-level door made them unreachable for the exact people
 * custody hands work to. See the decorator's own comment for why the exception is per-route.
 *
 * Every route is scoped to the caller's active workspace AND environment, so a flow is built and
 * tested in Sandbox and activated separately in Live (ADR-0012).
 */
@Controller("admin/workflows")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class WorkflowController {
  constructor(
    private readonly svc: WorkflowService,
    private readonly template: WorkflowTemplateService,
  ) {}

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
  /** The same workflow read as screens rather than as a graph. Purely derived. */
  @Get("page-view")
  pageView(@Req() req: Request) {
    return this.svc.pageView(this.ctx(req));
  }

  /**
   * The queue a workspace actually works from, so it is open to the roles custody assigns to.
   * Platform staff pass the roles check unconditionally (RolesGuard), which is what keeps this
   * screen working for an account manager looking after the workspace as well.
   *
   * A vendor or workshop session is refused here rather than filtered: myWork() would in fact return
   * nothing for them — their roles hold no steps — but "you would see nothing anyway" is a property
   * of today's data, and this controller is the workspace's internal work queue by definition.
   */
  @Get("my-work")
  @WorkspaceRoute("company_admin", "branch_manager", "service_advisor")
  myWork(@Req() req: Request) {
    return this.svc.myWork(this.ctx(req));
  }

  /**
   * THE ACTION LIBRARY (QNEW-90 item 3) — named, reusable action configurations for this workspace.
   *
   * Declared BEFORE @Get(":id") and @Put(":id/graph") for the reason page-view is: a literal segment
   * loses to a parameter that was registered first, and "action-library" would be read as a flow id.
   *
   * It sits on THIS controller, under the same @PlatformOnly() door as the flows, on purpose. An
   * entry is not something a workspace works on; it is a piece of a rule, copied verbatim into
   * transitions that only a super admin may author. Opening it to a workspace manager would hand
   * over the contents of a rule while the rule itself stayed shut. The run log went the other way
   * (0059) because a failed action is something the workspace's own manager has to act on — nobody
   * has to act on a library entry except the person building the flow.
   */
  @Get("action-library")
  library(@Req() req: Request) {
    return this.svc.library(this.ctx(req));
  }

  @Post("action-library")
  createEntry(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createLibraryEntry(this.ctx(req), actionEntrySchema.parse(body));
  }

  /** Editing an entry changes NOTHING about flows that already use it — they run their own copy. */
  @Put("action-library/:entryId")
  updateEntry(@Req() req: Request, @Param("entryId") entryId: string, @Body() body: unknown) {
    return this.svc.updateLibraryEntry(this.ctx(req), entryId, actionEntrySchema.parse(body));
  }

  @Delete("action-library/:entryId")
  removeEntry(@Req() req: Request, @Param("entryId") entryId: string) {
    return this.svc.removeLibraryEntry(this.ctx(req), entryId);
  }

  /**
   * The key this workspace's webhook deliveries are signed with, and how to verify one.
   *
   * WITHOUT A ROUTE THE SIGNATURE IS THEATRE. Every delivery carries an HMAC and nothing else in the
   * system can read the column that produced it, so a receiver would have no way to check one and
   * would end up trusting the URL — which is the exact thing the signature exists to stop being
   * enough. The service refuses anyone below super_admin: this is a credential, not a setting.
   *
   * Declared BEFORE @Get(":id") for the reason action-library is: a literal segment loses to a
   * parameter registered first, and "webhook-secret" would be read as a flow id.
   */
  @Get("webhook-secret")
  webhookSecret(@Req() req: Request) {
    return this.svc.webhookSecret(this.ctx(req));
  }

  /**
   * Make sure this workspace has its standard flows. IDEMPOTENT, and it never touches a workspace
   * that already has one — see the header of template.service.ts.
   *
   * It exists as a route even though the same code runs at boot and at workspace creation, because
   * "did this workspace get one?" is a question somebody will ask about a workspace that was
   * created while the API was down or restored from a backup, and the honest answer to it is a
   * button rather than a redeploy.
   *
   * Declared BEFORE @Get(":id") / @Post(":id/...") for the reason action-library is: a literal
   * segment loses to a parameter registered first.
   */
  @Post("provision")
  provision(@Req() req: Request) {
    const c = this.ctx(req);
    if (c.platformRole !== "super_admin")
      throw new ForbiddenException("only a super admin can provision a workspace's workflow");
    if (!c.tenantId)
      throw new BadRequestException("pick a workspace first — a flow belongs to one workspace");
    return this.template.ensure(c.tenantId, c.environment ?? "live");
  }

  /**
   * Put this workspace's flow back to the standard one, as a NEW VERSION.
   *
   * Not a DELETE and not a PUT on an existing flow: the active flow is frozen by the database, and
   * records already moving stay bound to the version they entered under. The response says how many
   * those are so the screen can repeat it rather than imply otherwise.
   */
  @Post("reset")
  reset(@Req() req: Request, @Body() body: { statusDomain?: "item" | "vendor" }) {
    return this.template.reset(this.ctx(req), body?.statusDomain === "vendor" ? "vendor" : "item");
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

  /**
   * Picking work up off the pool. Same door as my-work for the same reason — a queue you can see
   * and cannot take from is a list, not a queue. The service still refuses to hand a record to
   * somebody who does not hold the step's role, so opening the route widens who may CLAIM, never
   * who may end up holding.
   */
  @Post("/records/:entity/:id/claim")
  @WorkspaceRoute("company_admin", "branch_manager", "service_advisor")
  claim(@Req() req: Request, @Param("entity") entity: string, @Param("id") id: string, @Body() body: { userId?: string }) {
    return this.svc.claim(this.ctx(req), entity, id, body?.userId);
  }

  /** Draft a graph from a description. Returns a PROPOSAL — the canvas renders it, the human saves. */
  @Post(":id/assist")
  assist(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.assist(this.ctx(req), id, assistSchema.parse(body));
  }

  /** Tunable on an ACTIVE flow by design — routing is a view, not a rule. See 0048. */
  @Put(":id/placement")
  placement(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setPlacement(this.ctx(req), id, placementSchema.parse(body));
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
