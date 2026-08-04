import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  COUNTERPARTY_KINDS,
  type CounterpartyKind,
  createWorkspaceSchema,
  linkCounterpartySchema,
  updateWorkspaceSchema,
  WorkspacesAdminService,
} from "./workspaces-admin.service.js";
import { updateMembershipSchema, UsersAdminService } from "./users-admin.service.js";

/** /admin/workspaces — platform-staff management of tenants (the root of the hierarchy). */
/** URL segment → kind. One gate for every route, so widening the set is a one-line change and
 *  cannot be half-applied across the three of them. */
function asKind(kind: string): CounterpartyKind {
  if ((COUNTERPARTY_KINDS as string[]).includes(kind)) return kind as CounterpartyKind;
  throw new BadRequestException(`kind must be ${COUNTERPARTY_KINDS.join(" | ")}`);
}

@Controller("admin/workspaces")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class WorkspacesAdminController {
  constructor(
    private readonly svc: WorkspacesAdminService,
    private readonly users: UsersAdminService,
  ) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(getContext(req).userId!, createWorkspaceSchema.parse(body));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Get(":id/detail")
  detail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.detail(id, getContext(req).environment);
  }

  @Patch(":id")
  update(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.update(getContext(req).userId!, id, updateWorkspaceSchema.parse(body));
  }

  /** Directory identities not yet linked to this workspace (pick-list for "link existing"). */
  @Get(":id/linkable/:kind")
  linkable(@Param("id") id: string, @Param("kind") kind: string, @Query("scope") scope?: string) {
    const k = asKind(kind);
    if (scope !== undefined && scope !== "internal" && scope !== "external")
      throw new BadRequestException("scope must be internal | external");
    return this.svc.linkable(id, k, scope);
  }

  /** Link / unlink an existing counterparty to this workspace (the identity itself is untouched). */
  @Post(":id/link/:kind/:entityId")
  link(@Req() req: Request, @Param("id") id: string, @Param("kind") kind: string, @Param("entityId") entityId: string, @Body() body: unknown) {
    const dto = linkCounterpartySchema.parse(body ?? {});
    return this.svc.linkCounterparty(getContext(req).userId!, id, asKind(kind), entityId, dto.classification);
  }

  @Post(":id/unlink/:kind/:entityId")
  unlink(@Req() req: Request, @Param("id") id: string, @Param("kind") kind: string, @Param("entityId") entityId: string) {
    return this.svc.unlinkCounterparty(getContext(req).userId!, id, asKind(kind), entityId);
  }

  /** Super-admin: edit a membership INSIDE a specific workspace (cross-workspace entrance). */
  @Patch(":id/members/:membershipId")
  updateMember(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("membershipId") membershipId: string,
    @Body() body: unknown,
  ) {
    const ctx = getContext(req);
    return this.users.updateMembership(
      { tenantId: id, userId: ctx.userId, isInternal: true, impersonatorId: ctx.impersonatorId },
      membershipId,
      updateMembershipSchema.parse(body),
    );
  }
}
