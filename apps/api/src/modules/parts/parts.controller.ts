import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { cleanPartNumber, createPartSchema, PartsService } from "./parts.service.js";

const synonymSchema = z.object({ synonym: z.string().min(1).max(120) });

/** Master data (QNEW-28). Reads open to any authed user; writes = platform staff. */
@Controller("parts")
@UseGuards(AuthGuard, RolesGuard)
export class PartsController {
  constructor(private readonly parts: PartsService) {}

  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  /** Stateless utility (QNEW-34) — normalize a part number the one canonical way. */
  @Get("clean")
  clean(@Query("pn") pn: string) {
    if (!pn) throw new BadRequestException("pn is required");
    return { input: pn, cleaned: cleanPartNumber(pn) };
  }

  @Get("detect-category")
  detect(@Req() req: Request, @Query("name") name: string) {
    if (!name) throw new BadRequestException("name is required");
    return this.parts.detectCategory(this.ctx(req), name);
  }

  @Get()
  search(@Req() req: Request, @Query("q") q: string) {
    return this.parts.search(this.ctx(req), q ?? "");
  }

  @Post()
  @PlatformOnly()
  create(@Req() req: Request, @Body() body: unknown) {
    return this.parts.create(this.ctx(req), createPartSchema.parse(body));
  }

  @Post(":id/synonyms")
  @PlatformOnly()
  addSynonym(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.parts.addSynonym(this.ctx(req), id, synonymSchema.parse(body).synonym);
  }
}
