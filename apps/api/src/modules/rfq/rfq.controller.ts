import { BadRequestException, Controller, Get, Req, UseGuards } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { DbService } from "../../db/db.service.js";

/**
 * First tenant-scoped domain endpoint — proves the full chain end-to-end:
 * JWT → subdomain→tenant → RLS SET LOCAL → only this tenant's rows come back.
 */
@Controller("rfqs")
@UseGuards(AuthGuard)
export class RfqController {
  constructor(private readonly dbService: DbService) {}

  @Get()
  async list(@Req() req: Request) {
    const ctx = getContext(req);
    if (!ctx.tenantSlug) throw new BadRequestException("no tenant resolved (subdomain / X-Tenant)");

    // NOTE: no manual tenant_id filter — RLS enforces isolation. This is the point.
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      (tx) =>
        tx.execute(sql`
          select r.id, r.order_number, r.plate_number, s.label_en as status
          from rfqs r
          left join item_statuses s on s.id = r.status_id
          order by r.created_at desc
          limit 50`),
    );
    return { tenant: ctx.tenantSlug, count: rows.length, rfqs: rows };
  }
}
