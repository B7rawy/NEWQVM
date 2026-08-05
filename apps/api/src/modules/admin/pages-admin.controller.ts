import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { openCtx } from "../../common/request-context.js";
import { PagesAdminService, setRolesSchema } from "./pages-admin.service.js";

/** The page catalog. Reading it is platform-only too — it is a map of the whole product. */
@Controller("admin/pages")
@UseGuards(AuthGuard, RolesGuard)
@PlatformOnly()
export class PagesAdminController {
  constructor(private readonly svc: PagesAdminService) {}

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(openCtx(req));
  }

  @Post(":key/roles")
  setRoles(@Req() req: Request, @Param("key") key: string, @Body() body: unknown) {
    return this.svc.setRoles(openCtx(req), key, setRolesSchema.parse(body));
  }
}
