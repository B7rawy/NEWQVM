import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { openCtx } from "../../common/request-context.js";
import { createProviderSchema, providerStatusSchema, ProvidersService } from "./providers.service.js";

/** Service providers linked to the active workspace. Global directory; create/link is platform-only. */
@Controller("providers")
@UseGuards(AuthGuard, RolesGuard)
export class ProvidersController {
  constructor(private readonly svc: ProvidersService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(openCtx(req));
  }

  // Directory identity writes are platform-only; a workspace onboards via the submission flow.
  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.svc.create(openCtx(req), createProviderSchema.parse(body));
  }

  @Post(":id/status")
  @PlatformOnly()
  setStatus(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setStatus(openCtx(req), id, providerStatusSchema.parse(body));
  }

}
