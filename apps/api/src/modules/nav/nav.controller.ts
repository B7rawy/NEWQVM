import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { resolvePersona } from "../../common/persona.helpers.js";
import { DbService } from "../../db/db.service.js";
import { NavService } from "./nav.service.js";

/** The sidebar this user gets. See NavService for the three questions that decide it. */
@Controller("nav")
@UseGuards(AuthGuard)
export class NavController {
  constructor(
    private readonly svc: NavService,
    private readonly dbService: DbService,
  ) {}

  @Get()
  async nav(@Req() req: Request) {
    const ctx = getContext(req);
    const { persona } = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      (tx) => resolvePersona(tx, ctx.userId, ctx.isInternal),
    );
    return this.svc.resolve({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      isInternal: ctx.isInternal,
      persona,
      role: ctx.role ?? null,
      // no workspace chosen → the platform-wide tree, matching what the shell already did
      unscoped: !ctx.tenantId,
    });
  }
}
