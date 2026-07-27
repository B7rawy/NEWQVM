import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { Roles } from "../../common/roles.decorator.js";
import { requireTenantCtx } from "../../common/request-context.js";
import { runLogQuerySchema, WorkflowRunLogService } from "./run-log.service.js";

/**
 * /workflow/run-log — what moved in this workspace, and what the engine did about it.
 *
 * WHY THIS IS NOT ON WorkflowController. That controller is @PlatformOnly() at class level, so
 * everything on it is Qparts staff only. That is right for AUTHORING a flow — a workspace does not
 * draw its own rules yet. It is wrong for the run log: the person who has to act when an action
 * fails is the workspace's own manager, and putting this behind PlatformOnly would mean a workspace
 * could only discover that its flow has been silently failing for a week by asking us. An action
 * whose failure is invisible is the exact defect the run log exists to prevent (0056), and hiding
 * the log from the people it is about would reintroduce it one level up.
 *
 * WHY @Roles("company_admin") RATHER THAN OPEN. This log spans every record in the workspace, not
 * the caller's own work, so it is a manager's view — which is precisely how the nav already treats
 * it (`Status Logs` is `adminOnly` in workspaceNav). Platform staff pass the role gate by design
 * (see RolesGuard), so the platform nav entry keeps working without a second route.
 *
 * requireTenantCtx: the log is per workspace. Platform staff browsing with no workspace selected
 * get a 400 rather than a cross-tenant firehose — the screen asks them to pick one.
 */
@Controller("workflow/run-log")
@UseGuards(AuthGuard, RolesGuard)
@Roles("company_admin")
export class WorkflowRunLogController {
  constructor(private readonly svc: WorkflowRunLogService) {}

  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    return this.svc.list(requireTenantCtx(req), runLogQuerySchema.parse(query ?? {}));
  }
}
