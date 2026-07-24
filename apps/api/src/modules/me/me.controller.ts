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

  /** Current user + the tenant/role resolved for this request, plus the resolved persona
   *  (which portal the frontend renders): platform | vendor | workspace. */
  @Get()
  async me(@Req() req: Request) {
    const ctx = getContext(req);
    const info = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      async (tx) => {
        const user = (
          (await tx.execute(sql`select id, email, full_name from users where id = ${ctx.userId}::uuid`)) as Array<{
            id: string;
            email: string;
            full_name: string;
          }>
        )[0];
        const platformRole = (
          (await tx.execute(sql`
            select role from platform_members where user_id = ${ctx.userId}::uuid and is_active = true limit 1`)) as Array<{ role: string }>
        )[0]?.role;
        const isVendor = !!(
          (await tx.execute(sql`select 1 from vendor_users where user_id = ${ctx.userId}::uuid limit 1`)) as Array<unknown>
        )[0];
        const isWorkshop = !!(
          (await tx.execute(sql`select 1 from workshop_users where user_id = ${ctx.userId}::uuid limit 1`)) as Array<unknown>
        )[0];
        // QNEW-71: the counterparty's own account lifecycle (pending self-registration → active).
        const activationStatus = isVendor
          ? ((await tx.execute(sql`
              select v.activation_status from vendor_users vu join vendors v on v.id = vu.vendor_id
              where vu.user_id = ${ctx.userId}::uuid limit 1`)) as Array<{ activation_status: string }>)[0]?.activation_status
          : isWorkshop
            ? ((await tx.execute(sql`
                select w.activation_status from workshop_users wu join workshops w on w.id = wu.workshop_id
                where wu.user_id = ${ctx.userId}::uuid limit 1`)) as Array<{ activation_status: string }>)[0]?.activation_status
            : undefined;
        const impersonator = ctx.impersonatorId
          ? ((await tx.execute(sql`select full_name from users where id = ${ctx.impersonatorId}::uuid limit 1`)) as Array<{ full_name: string }>)[0]
          : undefined;
        return { user, platformRole, isVendor, isWorkshop, activationStatus, impersonatorName: impersonator?.full_name ?? null };
      },
    );

    const persona = ctx.isInternal
      ? "platform"
      : info.isVendor
        ? "vendor"
        : info.isWorkshop
          ? "workshop"
          : "workspace";
    return {
      user: info.user,
      tenant: { slug: ctx.tenantSlug, id: ctx.tenantId },
      role: ctx.role,
      isInternal: ctx.isInternal,
      platformRole: info.platformRole ?? null,
      isVendor: info.isVendor,
      isWorkshop: info.isWorkshop,
      activationStatus: info.activationStatus ?? null,
      persona,
      impersonating: !!ctx.impersonatorId,
      impersonatorName: info.impersonatorName,
    };
  }
}
