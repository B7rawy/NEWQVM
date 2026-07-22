import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { DbService } from "../../db/db.service.js";

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly dbService: DbService) {}

  /** Current user + the tenant/role resolved for this request. */
  @Get()
  async me(@Req() req: Request) {
    const ctx = getContext(req);
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      (tx) => tx.execute(sql`select id, email, full_name from users where id = ${ctx.userId}::uuid`),
    );
    const user = rows[0] as { id: string; email: string; full_name: string } | undefined;
    return {
      user,
      tenant: { slug: ctx.tenantSlug, id: ctx.tenantId },
      role: ctx.role,
      isInternal: ctx.isInternal,
    };
  }
}
