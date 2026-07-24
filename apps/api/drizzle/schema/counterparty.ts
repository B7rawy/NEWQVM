import { integer, jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { audit, pk } from "./_shared";
import { counterpartyType, importBatchStatus, submissionKind, submissionSource, submissionStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * Counterparty Identity & Governed Onboarding (QNEW-71 + onboarding pipeline) — Slice 1.
 *
 * Directory entities (vendors/workshops) are GLOBAL master data and only internal staff may write
 * them (global_write). A workspace never creates a directory row directly — it SUBMITS a proposed
 * counterparty (single form or Excel row), which lands here in a TENANT-scoped review queue. A
 * server-side match engine attaches candidate matches; an admin then approves (create new identity),
 * merges (link an existing identity), or rejects. These staging tables carry tenant_id + RLS, so a
 * workspace only ever sees its own submissions/imports.
 */

/** An Excel upload job (one file → many submission rows). Tenant-scoped. */
export const importBatches = pgTable(
  "import_batches",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: submissionKind("kind").notNull(),
    filename: text("filename"),
    status: importBatchStatus("status").notNull().default("uploaded"),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    errorRows: integer("error_rows").notNull().default(0),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    ...audit,
  },
  (t) => [index("import_batches_tenant_idx").on(t.tenantId)],
);

/** A proposed counterparty awaiting review, then approved/merged/rejected. Tenant-scoped. */
export const counterpartySubmissions = pgTable(
  "counterparty_submissions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: submissionKind("kind").notNull(),
    counterpartyType: counterpartyType("counterparty_type").notNull().default("company"),
    legalName: text("legal_name"),
    taxNumber: text("tax_number"),
    commercialRegistrationNumber: text("commercial_registration_number"),
    mobile: text("mobile"),
    email: text("email"),
    classification: text("classification"),
    payload: jsonb("payload").notNull().default({}),
    source: submissionSource("source").notNull().default("manual"),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id),
    status: submissionStatus("status").notNull().default("pending"),
    /** Server match-engine suggestions captured at submission time. */
    matchCandidates: jsonb("match_candidates").notNull().default([]),
    /** The directory entity this resolved to (created-new on approve, or existing on merge). */
    resolvedEntityId: uuid("resolved_entity_id"),
    reviewNotes: text("review_notes"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    index("counterparty_submissions_tenant_idx").on(t.tenantId),
    index("counterparty_submissions_status_idx").on(t.status),
    index("counterparty_submissions_kind_idx").on(t.kind),
    index("counterparty_submissions_batch_idx").on(t.importBatchId),
  ],
);
