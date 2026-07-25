import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { resolveCounterparty } from "../../common/counterparty.helpers.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { envOf } from "../../common/env-guards.js";

export const activateSchema = z.object({ mobile: z.string().trim().min(6) });
export const upgradeSchema = z.object({ legalName: z.string().min(2), taxNumber: z.string().trim().min(1) });

/** Self-service account management for a signed-in counterparty (QNEW-71). */
@Injectable()
export class AccountService {
  constructor(
    private readonly dbService: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Complete activation: the signed-in counterparty provides its identifier (individual→mobile).
   * Auto-activates when the mobile is free; 409 when it already identifies another individual
   * (they should log into that account instead of creating a duplicate).
   */
  async activate(ctx: RlsContext, dto: z.infer<typeof activateSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      const cp = await resolveCounterparty(tx, ctx.userId);
      if (!cp) throw new BadRequestException("no counterparty account to activate");
      const { kind, entityId } = cp;
      const table = kind === "vendor" ? "vendors" : "workshops";
      const nameCol = kind === "vendor" ? "legal_name" : "name";

      // QNEW-71 §3.5: detect an identifier COLLISION up-front (a SELECT, not a failing UPDATE — a
      // 23505 would abort the whole tx). If the mobile already identifies ANOTHER individual, this
      // doesn't reject: it becomes a review-queue submission (tenant_id NULL → internal reviewers
      // only) so an admin can MERGE the pending account into the existing identity, or reject it.
      const clash = (await tx.execute(sql`
        select id, ${sql.raw(nameCol)} as name from ${sql.raw(table)}
        where counterparty_type = 'individual' and primary_phone = ${dto.mobile} and id <> ${entityId}::uuid limit 1`))[0] as
        | { id: string; name: string }
        | undefined;
      if (clash) {
        const me = (await tx.execute(sql`
          select ${sql.raw(nameCol)} as name, primary_email from ${sql.raw(table)} where id = ${entityId}::uuid limit 1`))[0] as
          | { name: string; primary_email: string | null }
          | undefined;
        const already = (await tx.execute(sql`
          select id from counterparty_submissions
          where tenant_id is null and status = 'pending' and payload->>'pendingEntityId' = ${entityId} limit 1`))[0];
        if (!already) {
          const candidates = [{ id: clash.id, name: clash.name, cpType: "individual", score: 90, reasons: ["mobile"] }];
          await tx.execute(sql`
            insert into counterparty_submissions
              (tenant_id, kind, counterparty_type, legal_name, mobile, email, source, status,
               match_candidates, payload, submitted_by, created_by, updated_by)
            values (null, ${kind}, 'individual', ${me?.name ?? "(unknown)"}, ${dto.mobile}, ${me?.primary_email ?? null},
               'manual', 'pending', ${JSON.stringify(candidates)}::jsonb,
               ${JSON.stringify({ pendingEntityId: entityId, reason: "activation_collision" })}::jsonb,
               ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
        }
        return { status: "pending_review" as const, kind, entityId };
      }

      const rows = (await tx.execute(sql`
        update ${sql.raw(table)} set primary_phone = ${dto.mobile}, activation_status = 'active',
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${entityId}::uuid and counterparty_type = 'individual' returning id`)) as Array<{ id: string }>;
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
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
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
      // Upgrading is an IDENTITY change, so it must reach BOTH environments: several of these tables
      // (rfq_vendors, purchase_orders, vendor_payments…) carry `environment` and are hidden by the
      // restrictive policy (ADR-0012), which would otherwise leave the other environment's rows
      // pointing at the individual we are about to archive — a silent, permanent half-migration.
      // We flip the GUC inside the SAME transaction, so the whole re-parent stays atomic.
      for (const env of ["live", "sandbox"] as const) {
        await tx.execute(sql`select set_config('app.environment', ${env}, true)`);
        for (const fk of fks) {
          if (!/^[a-z_][a-z0-9_]*$/.test(fk.table_name) || !/^[a-z_][a-z0-9_]*$/.test(fk.column_name)) continue;
          await tx.execute(sql`update ${sql.raw(fk.table_name)} set ${sql.raw(fk.column_name)} = ${newId}::uuid where ${sql.raw(fk.column_name)} = ${oldId}::uuid`);
        }
      }
      // restore the caller's environment for the rest of the transaction
      await tx.execute(sql`select set_config('app.environment', ${envOf(ctx)}, true)`);

      // Archive the individual identity (retained for historical documents + name snapshots).
      await tx.execute(sql`
        update ${sql.raw(entityTable)} set is_active = false, activation_status = 'suspended',
          updated_by = ${ctx.userId}::uuid, updated_at = now() where id = ${oldId}::uuid`);

      // QNEW-71 §6.4: a one-time transition notice to EVERY workspace linked to the entity (not just
      // one) — the link rows were re-parented onto the company above, so they now point at newId.
      const linkTable = kind === "vendor" ? "tenant_vendors" : "tenant_workshops";
      const entityCol = kind === "vendor" ? "vendor_id" : "workshop_id";
      const links = (await tx.execute(sql`
        select t.id as tenant_id from ${sql.raw(linkTable)} l
        join tenants t on t.id = l.tenant_id
        where l.${sql.raw(entityCol)} = ${newId}::uuid and l.status <> 'archived'`)) as Array<{ tenant_id: string }>;
      for (const l of links) {
        await this.notifications.send(tx, {
          tenantId: l.tenant_id,
          // without this the log row is written as 'live' while the tx runs as 'sandbox', and the
          // restrictive WITH CHECK rejects the INSERT — rolling back the whole upgrade
          environment: envOf(ctx),
          channel: "webhook",
          template: "counterparty.upgraded",
          payload: { kind, entityId: newId, tradingAs: dto.legalName, previousType: "individual" },
        });
      }
      return { kind, companyId: newId, reparentedTables: fks.length, notifiedWorkspaces: links.length };
    });
  }
}
