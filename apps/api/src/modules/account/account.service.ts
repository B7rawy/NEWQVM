import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { resolveCounterparty } from "../../common/counterparty.helpers.js";

export const activateSchema = z.object({ mobile: z.string().trim().min(6) });
export const upgradeSchema = z.object({ legalName: z.string().min(2), taxNumber: z.string().trim().min(1) });

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
      const cp = await resolveCounterparty(tx, ctx.userId);
      if (!cp) throw new BadRequestException("no counterparty account to activate");
      const { kind, entityId } = cp;
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

  /**
   * Upgrade an Individual account to a Company (QNEW-71): create a NEW company entity in the same
   * directory, then re-parent EVERY reference to the individual (workspace links, branches, the admin
   * user link, and all transactional rows) onto the company — discovered from the FK catalog so no
   * table is missed. The individual row is archived (kept for historical documents / name snapshots).
   */
  async upgrade(ctx: RlsContext, dto: z.infer<typeof upgradeSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const cp = await resolveCounterparty(tx, ctx.userId);
      if (!cp) throw new BadRequestException("no counterparty account to upgrade");
      const { kind, entityId: oldId } = cp;
      const entityTable = kind === "vendor" ? "vendors" : "workshops";
      const nameCol = kind === "vendor" ? "legal_name" : "name";
      const cur = (await tx.execute(sql`select counterparty_type from ${sql.raw(entityTable)} where id = ${oldId}::uuid limit 1`))[0] as
        | { counterparty_type: string }
        | undefined;
      if (cur?.counterparty_type !== "individual") throw new BadRequestException("account is already a company");

      // Create the company identity (deduped by tax via the scoped partial-unique index).
      let newId: string;
      try {
        const [c] = (await tx.execute(sql`
          insert into ${sql.raw(entityTable)} (${sql.raw(nameCol)}, counterparty_type, activation_status, tax_number, created_by, updated_by)
          values (${dto.legalName}, 'company', 'active', ${dto.taxNumber}, ${ctx.userId}::uuid, ${ctx.userId}::uuid) returning id`)) as Array<{ id: string }>;
        newId = c.id;
      } catch (e) {
        if ((e as { code?: string })?.code === "23505") throw new ConflictException("a company with this tax number already exists");
        throw e;
      }

      // Re-parent every FK reference (single-column FKs → <entity>.id) from the individual to the company.
      const fks = (await tx.execute(sql`
        select cl.relname as table_name, att.attname as column_name
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class rf on rf.oid = c.confrelid
        join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
        where c.contype = 'f' and rf.relname = ${entityTable} and array_length(c.conkey, 1) = 1`)) as Array<{
        table_name: string;
        column_name: string;
      }>;
      for (const fk of fks) {
        if (!/^[a-z_][a-z0-9_]*$/.test(fk.table_name) || !/^[a-z_][a-z0-9_]*$/.test(fk.column_name)) continue;
        await tx.execute(sql`update ${sql.raw(fk.table_name)} set ${sql.raw(fk.column_name)} = ${newId}::uuid where ${sql.raw(fk.column_name)} = ${oldId}::uuid`);
      }

      // Archive the individual identity (retained for historical documents + name snapshots).
      await tx.execute(sql`
        update ${sql.raw(entityTable)} set is_active = false, activation_status = 'suspended',
          updated_by = ${ctx.userId}::uuid, updated_at = now() where id = ${oldId}::uuid`);
      return { kind, companyId: newId, reparentedTables: fks.length };
    });
  }
}
