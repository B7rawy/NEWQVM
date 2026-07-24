import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

export const activateSchema = z.object({ mobile: z.string().trim().min(6) });

/** Self-service account management for a signed-in counterparty (QNEW-71). */
@Injectable()
export class AccountService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Complete activation: the signed-in counterparty provides its identifier (individual→mobile).
   * Auto-activates when the mobile is free; 409 when it already identifies another individual
   * (they should log into that account instead of creating a duplicate).
   */
  async activate(ctx: RlsContext, dto: z.infer<typeof activateSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const vu = (await tx.execute(sql`select vendor_id as id from vendor_users where user_id = ${ctx.userId}::uuid limit 1`))[0] as
        | { id: string }
        | undefined;
      const wu = vu
        ? undefined
        : ((await tx.execute(sql`select workshop_id as id from workshop_users where user_id = ${ctx.userId}::uuid limit 1`))[0] as
            | { id: string }
            | undefined);
      const kind = vu ? "vendor" : wu ? "workshop" : null;
      const entityId = vu?.id ?? wu?.id;
      if (!kind || !entityId) throw new BadRequestException("no counterparty account to activate");
      const table = kind === "vendor" ? "vendors" : "workshops";
      let rows: Array<{ id: string }>;
      try {
        rows = (await tx.execute(sql`
          update ${sql.raw(table)} set primary_phone = ${dto.mobile}, activation_status = 'active',
            updated_by = ${ctx.userId}::uuid, updated_at = now()
          where id = ${entityId}::uuid and counterparty_type = 'individual' returning id`)) as Array<{ id: string }>;
      } catch (e) {
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("this mobile is already registered to another account");
        throw e;
      }
      if (!rows[0]) throw new BadRequestException("account is not an individual pending activation");
      return { status: "active" as const, kind, entityId };
    });
  }
}
