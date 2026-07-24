import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { targetTenant } from "../../common/tenant-target.js";

/**
 * Counterparty governed onboarding — Slice 2 (QNEW-71).
 *
 * A workspace never writes the global directory (vendors/workshops) directly. It SUBMITS a proposed
 * counterparty; a server-side match engine attaches candidates; then either:
 *   • the submitted key EXACTLY matches an existing identity (company→tax, individual→mobile) →
 *     auto-LINK the workspace to it (no new identity, no admin needed — safe, no data leak), or
 *   • it is new/ambiguous → PENDING admin review (approve = create new identity + link; merge = link
 *     an existing identity; reject).
 * All directory writes happen here under an INTERNAL db-session (global_write = app_is_internal), so
 * the decision — not the raw RLS — is what authorises the write.
 */

/** Auto-link on an EXACT key match. Creating a brand-new identity always goes through review. */
const AUTO_LINK_ON_EXACT_KEY = true;

export const submitCounterpartySchema = z
  .object({
    kind: z.enum(["vendor", "workshop"]),
    counterpartyType: z.enum(["individual", "company"]).default("company"),
    legalName: z.string().min(2),
    taxNumber: z.string().trim().min(1).optional(),
    commercialRegistrationNumber: z.string().trim().min(1).optional(),
    mobile: z.string().trim().min(1).optional(),
    email: z.string().email().optional(),
    classification: z.string().optional(),
    tenantId: z.string().uuid().optional(), // platform staff: submit on behalf of a workspace
  })
  .refine((d) => d.taxNumber || d.mobile || d.email, {
    message: "provide at least one identifier: taxNumber, mobile, or email",
  });
export const approveSchema = z.object({ notes: z.string().optional(), classification: z.string().optional() });
export const mergeSchema = z.object({ targetEntityId: z.string().uuid(), notes: z.string().optional() });
export const rejectSchema = z.object({ notes: z.string().optional() });
/** Bulk import — the client parses the Excel/CSV into rows and posts them (server validates + stages).
 *  email is intentionally NOT .email() here: import data is messy; rows are validated per-row inline. */
export const importSchema = z.object({
  kind: z.enum(["vendor", "workshop"]),
  filename: z.string().optional(),
  tenantId: z.string().uuid().optional(),
  rows: z
    .array(
      z.object({
        counterpartyType: z.enum(["individual", "company"]).default("company"),
        legalName: z.string().default(""),
        taxNumber: z.string().optional(),
        commercialRegistrationNumber: z.string().optional(),
        mobile: z.string().optional(),
        email: z.string().optional(),
        classification: z.string().optional(),
      }),
    )
    .min(1)
    .max(1000),
});

interface Candidate {
  id: string;
  name: string;
  cpType: "individual" | "company";
  score: number;
  reasons: string[];
}
type SubmissionRow = {
  id: string;
  tenant_id: string;
  kind: "vendor" | "workshop";
  counterparty_type: "individual" | "company";
  legal_name: string;
  tax_number: string | null;
  commercial_registration_number: string | null;
  mobile: string | null;
  email: string | null;
  classification: string | null;
  status: string;
  tenant_id_is_null?: boolean;
  payload?: { pendingEntityId?: string } | null;
};

@Injectable()
export class CounterpartyService {
  constructor(private readonly dbService: DbService) {}

  /** Resolve the workspace a submission is for via the shared helper (platform may target any). */
  private targetTenant(ctx: RlsContext, dtoTenantId?: string) {
    return targetTenant(ctx, dtoTenantId);
  }

  /** Score a proposed counterparty against the global directory (tax → mobile → email → name). */
  private async findCandidates(
    tx: Tx,
    kind: "vendor" | "workshop",
    d: { taxNumber?: string; mobile?: string; email?: string; legalName: string },
  ): Promise<Candidate[]> {
    const table = kind === "vendor" ? "vendors" : "workshops";
    const nameCol = kind === "vendor" ? "legal_name" : "name";
    const tax = d.taxNumber ?? null;
    const mobile = d.mobile ?? null;
    const email = d.email ?? null;
    // Escape LIKE metacharacters so a name containing % or _ can't broaden the fuzzy match
    // (backslash is Postgres' default LIKE escape character).
    const escName = (d.legalName ?? "").replace(/[\\%_]/g, (c) => "\\" + c);
    const namePat = d.legalName ? `%${escName}%` : null;
    const rows = (await tx.execute(sql`
      select id, ${sql.raw(nameCol)} as name, counterparty_type as cp_type,
        (${tax}::text is not null and tax_number = ${tax}) as m_tax,
        (${mobile}::text is not null and primary_phone = ${mobile}) as m_mobile,
        (${email}::text is not null and lower(primary_email) = lower(${email})) as m_email,
        (${namePat}::text is not null and ${sql.raw(nameCol)} ilike ${namePat}) as m_name
      from ${sql.raw(table)}
      where is_active = true and (
        (${tax}::text is not null and tax_number = ${tax}) or
        (${mobile}::text is not null and primary_phone = ${mobile}) or
        (${email}::text is not null and lower(primary_email) = lower(${email})) or
        (${namePat}::text is not null and ${sql.raw(nameCol)} ilike ${namePat})
      )
      limit 20`)) as Array<{ id: string; name: string; cp_type: "individual" | "company"; m_tax: boolean; m_mobile: boolean; m_email: boolean; m_name: boolean }>;
    const scored = rows.map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (r.m_tax) (reasons.push("tax"), (score = Math.max(score, 100)));
      if (r.m_mobile) (reasons.push("mobile"), (score = Math.max(score, 90)));
      if (r.m_email) (reasons.push("email"), (score = Math.max(score, 80)));
      if (r.m_name) (reasons.push("name"), (score = Math.max(score, 40)));
      return { id: r.id, name: r.name, cpType: r.cp_type, score, reasons };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 5);
  }

  /** Link an existing directory identity to a workspace (idempotent). */
  private async linkEntity(
    tx: Tx,
    kind: "vendor" | "workshop",
    tenantId: string,
    entityId: string,
    classification: string | null,
    userId: string | null,
  ) {
    if (kind === "vendor") {
      await tx.execute(sql`
        insert into tenant_vendors (tenant_id, vendor_id, status, classification, linked_by, created_by, updated_by)
        values (${tenantId}::uuid, ${entityId}::uuid, 'active', ${classification ?? null}, ${userId}::uuid, ${userId}::uuid, ${userId}::uuid)
        on conflict (tenant_id, vendor_id) do update set status = 'active', updated_by = ${userId}::uuid, updated_at = now()`);
    } else {
      await tx.execute(sql`
        insert into tenant_workshops (tenant_id, workshop_id, status, linked_by, created_by, updated_by)
        values (${tenantId}::uuid, ${entityId}::uuid, 'active', ${userId}::uuid, ${userId}::uuid, ${userId}::uuid)
        on conflict (tenant_id, workshop_id) do update set status = 'active', updated_by = ${userId}::uuid, updated_at = now()`);
    }
  }

  /**
   * Match + stage/auto-link ONE proposed counterparty. Shared by single submit and bulk import.
   * MUST run inside a withContext({ isInternal: true }) tx (needs the global directory read + link write).
   * Type-normalises identifiers (tax/CR are company concepts; an individual is keyed by mobile).
   */
  private async processRow(
    tx: Tx,
    target: string,
    kind: "vendor" | "workshop",
    row: {
      counterpartyType: "individual" | "company";
      legalName: string;
      taxNumber?: string | null;
      commercialRegistrationNumber?: string | null;
      mobile?: string | null;
      email?: string | null;
      classification?: string | null;
    },
    source: "manual" | "excel_import",
    batchId: string | null,
    userId: string | null,
  ): Promise<{ submissionId: string; status: "pending" | "merged"; autoLinked: boolean; entityId: string | null; matchCount: number }> {
    const isCompany = row.counterpartyType === "company";
    const taxNumber = isCompany ? row.taxNumber ?? null : null;
    const cr = isCompany ? row.commercialRegistrationNumber ?? null : null;
    const candidates = await this.findCandidates(tx, kind, {
      taxNumber: taxNumber ?? undefined,
      mobile: row.mobile ?? undefined,
      email: row.email ?? undefined,
      legalName: row.legalName,
    });
    // Auto-link ONLY on an exact key match to a same-type identity (company↔tax, individual↔mobile).
    const exact = candidates.find(
      (c) =>
        (isCompany && c.cpType === "company" && c.reasons.includes("tax")) ||
        (!isCompany && c.cpType === "individual" && c.reasons.includes("mobile")),
    );
    const cand = JSON.stringify(candidates);
    if (AUTO_LINK_ON_EXACT_KEY && exact) {
      await this.linkEntity(tx, kind, target, exact.id, row.classification ?? null, userId);
      const [s] = (await tx.execute(sql`
        insert into counterparty_submissions
          (tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
           mobile, email, classification, source, import_batch_id, status, match_candidates, resolved_entity_id,
           submitted_by, reviewed_at, review_notes, created_by, updated_by)
        values (${target}::uuid, ${kind}, ${row.counterpartyType}, ${row.legalName}, ${taxNumber},
           ${cr}, ${row.mobile ?? null}, ${row.email ?? null}, ${row.classification ?? null}, ${source},
           ${batchId}::uuid, 'merged', ${cand}::jsonb, ${exact.id}::uuid,
           ${userId}::uuid, now(), 'auto-linked on exact key match', ${userId}::uuid, ${userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      return { submissionId: s.id, status: "merged", autoLinked: true, entityId: exact.id, matchCount: candidates.length };
    }
    const [s] = (await tx.execute(sql`
      insert into counterparty_submissions
        (tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
         mobile, email, classification, source, import_batch_id, status, match_candidates, submitted_by, created_by, updated_by)
      values (${target}::uuid, ${kind}, ${row.counterpartyType}, ${row.legalName}, ${taxNumber},
         ${cr}, ${row.mobile ?? null}, ${row.email ?? null}, ${row.classification ?? null}, ${source},
         ${batchId}::uuid, 'pending', ${cand}::jsonb, ${userId}::uuid, ${userId}::uuid, ${userId}::uuid)
      returning id`)) as Array<{ id: string }>;
    return { submissionId: s.id, status: "pending", autoLinked: false, entityId: null, matchCount: candidates.length };
  }

  /** Workspace submits a single proposed counterparty. Auto-links on an exact key, else queues. */
  async submit(ctx: RlsContext, dto: z.infer<typeof submitCounterpartySchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    const r = await this.dbService.withContext(
      { tenantId: target, userId: ctx.userId, isInternal: true },
      (tx) => this.processRow(tx, target, dto.kind, dto, "manual", null, ctx.userId),
    );
    // never echo candidate names/ids to the (non-internal) workspace — privacy boundary.
    return { submissionId: r.submissionId, status: r.status, autoLinked: r.autoLinked, entityId: r.entityId ?? undefined, matchCount: r.matchCount };
  }

  /**
   * Bulk import — one batch → many staged submissions, each matched/auto-linked like a single submit.
   * Rows failing basic validation (no name or no identifier) are counted as errors and skipped.
   */
  async importRows(ctx: RlsContext, dto: z.infer<typeof importSchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: true }, async (tx) => {
      const [batch] = (await tx.execute(sql`
        insert into import_batches (tenant_id, kind, filename, status, total_rows, uploaded_by, created_by, updated_by)
        values (${target}::uuid, ${dto.kind}, ${dto.filename ?? null}, 'submitted', ${dto.rows.length},
          ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      let autoLinked = 0;
      let pending = 0;
      let errors = 0;
      const perRow: Array<{ index: number; legalName: string; status: string; matchCount?: number; reason?: string }> = [];
      for (const [i, row] of dto.rows.entries()) {
        const hasIdentifier = !!(row.taxNumber || row.mobile || row.email);
        if (!row.legalName || row.legalName.trim().length < 2 || !hasIdentifier) {
          errors++;
          perRow.push({ index: i, legalName: row.legalName ?? "", status: "error", reason: "missing name or identifier" });
          continue;
        }
        const r = await this.processRow(tx, target, dto.kind, row, "excel_import", batch.id, ctx.userId);
        r.autoLinked ? autoLinked++ : pending++;
        perRow.push({ index: i, legalName: row.legalName, status: r.status, matchCount: r.matchCount });
      }
      await tx.execute(sql`
        update import_batches set valid_rows = ${dto.rows.length - errors}, error_rows = ${errors},
          status = 'completed', updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${batch.id}::uuid`);
      return { batchId: batch.id, total: dto.rows.length, autoLinked, pending, errors, perRow };
    });
  }

  /** The workspace's own submissions (tenant-scoped). */
  async listMine(ctx: RlsContext) {
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: false },
      (tx) =>
        tx.execute(sql`
          select id, kind, counterparty_type, legal_name, tax_number, mobile, email, status, resolved_entity_id,
            jsonb_array_length(match_candidates) as candidate_count, created_at
          from counterparty_submissions
          order by created_at desc`),
    );
    return { count: rows.length, submissions: rows };
  }

  /** The platform review queue — every pending submission across workspaces (internal only). */
  async listReview(ctx: RlsContext) {
    const rows = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true },
      (tx) =>
        tx.execute(sql`
          select s.id, s.kind, s.counterparty_type, s.legal_name, s.tax_number, s.commercial_registration_number,
            s.mobile, s.email, s.classification, s.status, s.match_candidates, s.source, s.created_at,
            coalesce(t.name, 'Self-service') as workspace, t.slug as workspace_slug,
            (s.payload->>'reason') as reason
          from counterparty_submissions s
          left join tenants t on t.id = s.tenant_id
          where s.status = 'pending'
          order by s.created_at asc`),
    );
    return { count: rows.length, submissions: rows };
  }

  private async loadPending(tx: Tx, id: string): Promise<SubmissionRow> {
    // FOR UPDATE serialises concurrent decisions: a second reviewer blocks until the first commits,
    // then sees the terminal status and is rejected below (no double-create / double-link).
    const [s] = (await tx.execute(sql`
      select id, tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
        mobile, email, classification, status, payload
      from counterparty_submissions where id = ${id}::uuid limit 1 for update`)) as SubmissionRow[];
    if (!s) throw new NotFoundException("submission not found");
    if (s.status !== "pending") throw new BadRequestException(`submission already ${s.status}`);
    return s;
  }

  /** Write a review decision to the platform audit trail (QNEW-71 §4.3). */
  private audit(tx: Tx, ctx: RlsContext, action: string, kind: string, entityId: string | null, meta: object) {
    return tx.execute(sql`
      insert into platform_audit (tenant_id, actor_user_id, impersonator_id, action, entity_type, entity_id, metadata)
      values (null, ${ctx.userId}::uuid, ${ctx.impersonatorId ?? null}::uuid, ${action}, ${kind}, ${entityId}::uuid,
              ${JSON.stringify(meta)}::jsonb)`);
  }

  /** Re-parent every single-column FK reference from one directory entity to another, then archive
   *  the source (QNEW-71 §4.2 merge history-transfer — same FK-catalog walk as the upgrade path). */
  private async reparent(tx: Tx, kind: "vendor" | "workshop", fromId: string, toId: string) {
    const entityTable = kind === "vendor" ? "vendors" : "workshops";
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
      await tx.execute(sql`update ${sql.raw(fk.table_name)} set ${sql.raw(fk.column_name)} = ${toId}::uuid where ${sql.raw(fk.column_name)} = ${fromId}::uuid`);
    }
    await tx.execute(sql`
      update ${sql.raw(entityTable)} set is_active = false, activation_status = 'suspended', updated_at = now()
      where id = ${fromId}::uuid`);
  }

  /** Approve: create a NEW directory identity + link it to the requesting workspace. */
  async approve(ctx: RlsContext, id: string, dto: z.infer<typeof approveSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const s = await this.loadPending(tx, id);
      let entityId: string;
      try {
        if (s.kind === "vendor") {
          const [v] = (await tx.execute(sql`
            insert into vendors (legal_name, counterparty_type, tax_number, commercial_registration_number,
              primary_email, primary_phone, created_by, updated_by)
            values (${s.legal_name}, ${s.counterparty_type}, ${s.tax_number}, ${s.commercial_registration_number},
              ${s.email}, ${s.mobile}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
            returning id`)) as Array<{ id: string }>;
          entityId = v.id;
        } else {
          const [w] = (await tx.execute(sql`
            insert into workshops (name, counterparty_type, tax_number, commercial_registration_number,
              primary_phone, primary_email, created_by, updated_by)
            values (${s.legal_name}, ${s.counterparty_type}, ${s.tax_number}, ${s.commercial_registration_number},
              ${s.mobile}, ${s.email}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
            returning id`)) as Array<{ id: string }>;
          entityId = w.id;
        }
      } catch (e) {
        // ONLY a scoped partial-unique violation (23505) means "already exists → merge"; surface anything else.
        // 409 Conflict — consistent with every other unique-violation mapping in the codebase.
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("an identity with this key already exists — use merge instead");
        throw e;
      }
      // a self-service collision submission carries no workspace (tenant_id NULL) — nothing to link.
      if (s.tenant_id) await this.linkEntity(tx, s.kind, s.tenant_id, entityId, dto.classification ?? s.classification, ctx.userId);
      await tx.execute(sql`
        update counterparty_submissions set status = 'approved', resolved_entity_id = ${entityId}::uuid,
          reviewed_by = ${ctx.userId}::uuid, reviewed_at = now(), review_notes = ${dto.notes ?? null},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
      await this.audit(tx, ctx, "counterparty.approve", s.kind, entityId, { submissionId: id });
      return { entityId, status: "approved" as const };
    });
  }

  /** Merge: link an EXISTING directory identity to the requesting workspace (dedupe, no new row). */
  async merge(ctx: RlsContext, id: string, dto: z.infer<typeof mergeSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const s = await this.loadPending(tx, id);
      const table = s.kind === "vendor" ? "vendors" : "workshops";
      const ex = (await tx.execute(
        sql`select 1 from ${sql.raw(table)} where id = ${dto.targetEntityId}::uuid limit 1`,
      )) as Array<unknown>;
      if (!ex[0]) throw new NotFoundException("target entity not found in the directory");
      if (s.tenant_id) await this.linkEntity(tx, s.kind, s.tenant_id, dto.targetEntityId, s.classification, ctx.userId);
      // a self-service collision submission (tenant_id NULL) also re-parents the pending account's
      // history onto the surviving identity, then archives the pending duplicate (QNEW-71 §4.2).
      const pendingEntityId = (s as { payload?: { pendingEntityId?: string } }).payload?.pendingEntityId;
      if (pendingEntityId && pendingEntityId !== dto.targetEntityId) {
        await this.reparent(tx, s.kind, pendingEntityId, dto.targetEntityId);
      }
      await tx.execute(sql`
        update counterparty_submissions set status = 'merged', resolved_entity_id = ${dto.targetEntityId}::uuid,
          reviewed_by = ${ctx.userId}::uuid, reviewed_at = now(), review_notes = ${dto.notes ?? null},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
      await this.audit(tx, ctx, "counterparty.merge", s.kind, dto.targetEntityId, { submissionId: id, mergedFrom: pendingEntityId ?? null });
      return { entityId: dto.targetEntityId, status: "merged" as const };
    });
  }

  /** Reject: leave the directory untouched; record the decision. */
  async reject(ctx: RlsContext, id: string, dto: z.infer<typeof rejectSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const s = await this.loadPending(tx, id);
      await tx.execute(sql`
        update counterparty_submissions set status = 'rejected', reviewed_by = ${ctx.userId}::uuid,
          reviewed_at = now(), review_notes = ${dto.notes ?? null}, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
      await this.audit(tx, ctx, "counterparty.reject", s.kind, null, { submissionId: id });
      return { status: "rejected" as const };
    });
  }
}
