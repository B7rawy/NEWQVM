import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";

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

interface Candidate {
  id: string;
  name: string;
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
};

@Injectable()
export class CounterpartyService {
  constructor(private readonly dbService: DbService) {}

  /** Resolve the workspace a submission is for: platform staff may target any; others use active. */
  private targetTenant(ctx: RlsContext, dtoTenantId?: string) {
    if (dtoTenantId && dtoTenantId !== ctx.tenantId && !ctx.isInternal)
      throw new ForbiddenException("only platform staff can submit on behalf of another workspace");
    const target = ctx.isInternal ? dtoTenantId ?? ctx.tenantId : ctx.tenantId;
    if (!target) throw new BadRequestException("no target workspace resolved (subdomain / X-Tenant)");
    return target;
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
    const name = d.legalName ?? "";
    const rows = (await tx.execute(sql`
      select id, ${sql.raw(nameCol)} as name,
        (${tax}::text is not null and tax_number = ${tax}) as m_tax,
        (${mobile}::text is not null and primary_phone = ${mobile}) as m_mobile,
        (${email}::text is not null and lower(primary_email) = lower(${email})) as m_email,
        (${name} <> '' and ${sql.raw(nameCol)} ilike '%' || ${name} || '%') as m_name
      from ${sql.raw(table)}
      where is_active = true and (
        (${tax}::text is not null and tax_number = ${tax}) or
        (${mobile}::text is not null and primary_phone = ${mobile}) or
        (${email}::text is not null and lower(primary_email) = lower(${email})) or
        (${name} <> '' and ${sql.raw(nameCol)} ilike '%' || ${name} || '%')
      )
      limit 20`)) as Array<{ id: string; name: string; m_tax: boolean; m_mobile: boolean; m_email: boolean; m_name: boolean }>;
    const scored = rows.map((r) => {
      const reasons: string[] = [];
      let score = 0;
      if (r.m_tax) (reasons.push("tax"), (score = Math.max(score, 100)));
      if (r.m_mobile) (reasons.push("mobile"), (score = Math.max(score, 90)));
      if (r.m_email) (reasons.push("email"), (score = Math.max(score, 80)));
      if (r.m_name) (reasons.push("name"), (score = Math.max(score, 40)));
      return { id: r.id, name: r.name, score, reasons };
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

  /** Workspace submits a proposed counterparty. Auto-links on an exact key, else queues for review. */
  async submit(ctx: RlsContext, dto: z.infer<typeof submitCounterpartySchema>) {
    const target = this.targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: true }, async (tx) => {
      const candidates = await this.findCandidates(tx, dto.kind, dto);
      const exact = candidates.find(
        (c) =>
          (dto.counterpartyType === "company" && c.reasons.includes("tax")) ||
          (dto.counterpartyType === "individual" && c.reasons.includes("mobile")),
      );
      const cand = JSON.stringify(candidates);
      if (AUTO_LINK_ON_EXACT_KEY && exact) {
        await this.linkEntity(tx, dto.kind, target, exact.id, dto.classification ?? null, ctx.userId);
        const [s] = (await tx.execute(sql`
          insert into counterparty_submissions
            (tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
             mobile, email, classification, source, status, match_candidates, resolved_entity_id,
             submitted_by, reviewed_at, review_notes, created_by, updated_by)
          values (${target}::uuid, ${dto.kind}, ${dto.counterpartyType}, ${dto.legalName}, ${dto.taxNumber ?? null},
             ${dto.commercialRegistrationNumber ?? null}, ${dto.mobile ?? null}, ${dto.email ?? null},
             ${dto.classification ?? null}, 'manual', 'merged', ${cand}::jsonb, ${exact.id}::uuid,
             ${ctx.userId}::uuid, now(), 'auto-linked on exact key match', ${ctx.userId}::uuid, ${ctx.userId}::uuid)
          returning id`)) as Array<{ id: string }>;
        return { submissionId: s.id, status: "merged" as const, autoLinked: true, entityId: exact.id, candidates };
      }
      const [s] = (await tx.execute(sql`
        insert into counterparty_submissions
          (tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
           mobile, email, classification, source, status, match_candidates, submitted_by, created_by, updated_by)
        values (${target}::uuid, ${dto.kind}, ${dto.counterpartyType}, ${dto.legalName}, ${dto.taxNumber ?? null},
           ${dto.commercialRegistrationNumber ?? null}, ${dto.mobile ?? null}, ${dto.email ?? null},
           ${dto.classification ?? null}, 'manual', 'pending', ${cand}::jsonb, ${ctx.userId}::uuid,
           ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      return { submissionId: s.id, status: "pending" as const, autoLinked: false, candidates };
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
            t.name as workspace, t.slug as workspace_slug
          from counterparty_submissions s
          join tenants t on t.id = s.tenant_id
          where s.status = 'pending'
          order by s.created_at asc`),
    );
    return { count: rows.length, submissions: rows };
  }

  private async loadPending(tx: Tx, id: string): Promise<SubmissionRow> {
    const [s] = (await tx.execute(sql`
      select id, tenant_id, kind, counterparty_type, legal_name, tax_number, commercial_registration_number,
        mobile, email, classification, status
      from counterparty_submissions where id = ${id}::uuid limit 1`)) as SubmissionRow[];
    if (!s) throw new NotFoundException("submission not found");
    if (s.status !== "pending") throw new BadRequestException(`submission already ${s.status}`);
    return s;
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
      } catch {
        // scoped partial-unique tripped → an identity with this key already exists
        throw new BadRequestException("an identity with this key already exists — use merge instead");
      }
      await this.linkEntity(tx, s.kind, s.tenant_id, entityId, dto.classification ?? s.classification, ctx.userId);
      await tx.execute(sql`
        update counterparty_submissions set status = 'approved', resolved_entity_id = ${entityId}::uuid,
          reviewed_by = ${ctx.userId}::uuid, reviewed_at = now(), review_notes = ${dto.notes ?? null},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
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
      await this.linkEntity(tx, s.kind, s.tenant_id, dto.targetEntityId, s.classification, ctx.userId);
      await tx.execute(sql`
        update counterparty_submissions set status = 'merged', resolved_entity_id = ${dto.targetEntityId}::uuid,
          reviewed_by = ${ctx.userId}::uuid, reviewed_at = now(), review_notes = ${dto.notes ?? null},
          updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
      return { entityId: dto.targetEntityId, status: "merged" as const };
    });
  }

  /** Reject: leave the directory untouched; record the decision. */
  async reject(ctx: RlsContext, id: string, dto: z.infer<typeof rejectSchema>) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      await this.loadPending(tx, id);
      await tx.execute(sql`
        update counterparty_submissions set status = 'rejected', reviewed_by = ${ctx.userId}::uuid,
          reviewed_at = now(), review_notes = ${dto.notes ?? null}, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where id = ${id}::uuid`);
      return { status: "rejected" as const };
    });
  }
}
