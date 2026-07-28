import { sql } from "drizzle-orm";
import { bigint, boolean, foreignKey, integer, jsonb, pgTable, text, timestamp, uuid, index, unique } from "drizzle-orm/pg-core";
import { audit, pk, timestamps } from "./_shared";
import { entityType, environmentType, statusDomain } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { regions } from "./reference";

/**
 * Cross-cutting tables — ONE mechanism each, replacing the old duplicates:
 *  - attachments: replaces files + quotation_attachments + purchase_invoice_attachments + returned_issue_attachments
 *  - statusLogs: append-only (no updated_by); one polymorphic log instead of per-table columns
 *  - notes: one polymorphic notes table
 *  - orderNumberCounters: real per-(tenant,scope) counter, incremented atomically (no MAX()+1)
 */

/** Unified polymorphic attachment. file_key points at MinIO/S3 object. */
export const attachments = pgTable(
  "attachments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    entityType: entityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    fileKey: text("file_key").notNull(),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("attachments_tenant_idx").on(t.tenantId),
    index("attachments_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("attachments_uploaded_by_idx").on(t.uploadedBy),
  ],
);

/** Append-only status change log (no updated_by — the old status_logs had a meaningless one). */
export const statusLogs = pgTable(
  "status_logs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    entityType: entityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    /**
     * status_domain says which vocabulary from/to point at (item_statuses vs vendor_statuses),
     * so vendor-side transitions log correctly. No hard FK (the target table varies) — the app
     * validates against the right table by domain.
     */
    statusDomain: statusDomain("status_domain").notNull().default("item"),
    fromStatusId: uuid("from_status_id"),
    toStatusId: uuid("to_status_id"),
    changedBy: uuid("changed_by").references(() => users.id),
    /**
     * ── ADDED BY THE WORKFLOW ENGINE'S HAND-WRITTEN MIGRATIONS, DECLARED HERE BY 0067 ─────────
     *
     * `override_reason` / `overridden_gates` came with 0051, `auto_advanced` with 0059 and `flow_id`
     * with 0066. None was written back into this file, so drizzle's model of the log was four
     * columns short of the log — and a column drizzle cannot see is a column the next generated
     * migration is written without.
     */
    /** Why a warn_override gate was overridden, and which ones — the record of a judgement call. */
    overrideReason: text("override_reason"),
    overriddenGates: jsonb("overridden_gates"),
    /** True when the engine made this move by itself, so the run log can say nobody did it. */
    autoAdvanced: boolean("auto_advanced").notNull().default(false),
    /**
     * WHICH FLOW JUDGED THIS MOVE — on a crossing, the flow the record landed in (0066). Read by
     * the run log rather than re-derived from today's binding, because by then the record may be
     * home again and the binding no longer says where it was.
     */
    flowId: uuid("flow_id"),
    ...timestamps,
  },
  (t) => [
    index("status_logs_tenant_idx").on(t.tenantId),
    index("status_logs_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("status_logs_changed_by_idx").on(t.changedBy),
    // `.nullsFirst()` is not decoration: Postgres reads a bare `DESC` as `DESC NULLS FIRST`, which
    // is how 0059 created this index, while drizzle spells `.desc()` out as `DESC NULLS LAST`. The
    // two are the same index here (created_at is NOT NULL) and different index DEFINITIONS, and the
    // difference is what a future `generate` would offer to "fix" by rebuilding it.
    index("status_logs_recent_idx").on(t.tenantId, t.environment, t.createdAt.desc().nullsFirst()),
  ],
);

/** Polymorphic notes. */
export const notes = pgTable(
  "notes",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    entityType: entityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    body: text("body").notNull(),
    isInternal: boolean("is_internal").notNull().default(false),
    ...audit,
  },
  (t) => [
    index("notes_tenant_idx").on(t.tenantId),
    index("notes_entity_idx").on(t.tenantId, t.entityType, t.entityId),
  ],
);

/**
 * Notification outbox — EVERY outbound side-effect (email/whatsapp/webhook) is recorded here.
 * `status` = 'sent' | 'suppressed' | 'failed'. In a sandbox tenant the NotificationsService writes
 * a 'suppressed' row and never touches a real provider (ADR-0004) — this table is the audit trail
 * and the proof that sandbox isolation held.
 */
export const notificationLog = pgTable(
  "notification_log",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    channel: text("channel").notNull(), // email | whatsapp | webhook
    recipient: text("recipient"),
    template: text("template"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull(), // sent | suppressed | failed
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("notification_log_tenant_idx").on(t.tenantId),
    index("notification_log_created_by_idx").on(t.createdBy),
  ],
);

/**
 * IN-APP NOTIFICATION INBOX — the one channel with real delivery (migration 0061).
 *
 * notificationLog above records OUTBOUND attempts against providers that do not exist yet. This
 * table is different in kind: the row IS the delivery, because the reader is this same application.
 * It is therefore the only notification anything in this system may claim to have sent.
 *
 * Addressed to a PERSON. A RESTRICTIVE policy limits SELECT/UPDATE/DELETE to recipient_user_id, so
 * the app_is_internal() escape in the tenant policy cannot read somebody's inbox. INSERT is not
 * covered by it — delivery is written inside the transaction of whoever CAUSED the notification —
 * which is why the delivery path must never use `.returning()` (RETURNING re-checks the SELECT
 * policy and would fail whenever the writer is not the recipient).
 */
export const inAppNotifications = pgTable(
  "in_app_notifications",
  {
    id: pk(),
    /**
     * The two foreign keys are declared in the config block below rather than inline, purely so they
     * can be NAMED. 0061 was hand-written SQL, so Postgres named them `…_fkey`, while an inline
     * `.references()` makes drizzle call them `…_tenant_id_tenants_id_fk`. The DO-$$-EXCEPTION
     * wrapper drizzle emits only swallows `duplicate_object`, and a different name is not a
     * duplicate — so the mismatch would have added a SECOND, redundant foreign key on the same
     * column the first time anyone generated against this table.
     */
    tenantId: uuid("tenant_id").notNull(),
    environment: environmentType("environment").notNull().default("live"),
    recipientUserId: uuid("recipient_user_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app router path ("/approvals"); a DB check refuses absolute and protocol-relative URLs. */
    link: text("link"),
    kind: text("kind").notNull().default("system"),
    /** NULL = unread. The unread count is served by a PARTIAL index on exactly this predicate. */
    readAt: timestamp("read_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    // PARTIAL, and the predicate is the point: "how many unread do I have" is asked on every page
    // load, and an index over unread rows only stays small however large the read history grows.
    // Declared here exactly as migration 0061 creates it — a declaration that quietly omitted the
    // WHERE would make the next `drizzle-kit generate` propose replacing the fast index with a slow
    // one, which is a performance regression nobody would read as a schema change.
    index("in_app_notifications_unread_idx")
      .on(t.recipientUserId, t.tenantId, t.environment)
      .where(sql`read_at is null`),
    // `.nullsFirst()` for the same reason as status_logs_recent_idx above — 0061 wrote a bare
    // `created_at DESC`, which Postgres stores as DESC NULLS FIRST.
    index("in_app_notifications_inbox_idx").on(
      t.recipientUserId,
      t.tenantId,
      t.environment,
      t.createdAt.desc().nullsFirst(),
    ),
    // Named to match what 0061 actually created — see the note on tenantId above.
    foreignKey({
      columns: [t.tenantId],
      foreignColumns: [tenants.id],
      name: "in_app_notifications_tenant_id_fkey",
    }),
    foreignKey({
      columns: [t.recipientUserId],
      foreignColumns: [users.id],
      name: "in_app_notifications_recipient_user_id_fkey",
    }),
  ],
);

/**
 * Per-(tenant, region) order-number counter. Replaces old MAX()+1: a row is locked and its
 * `next_value` incremented atomically inside the number-issuing function (no full-table scan,
 * no cross-order contention beyond the single counter row).
 */
export const orderNumberCounters = pgTable(
  "order_number_counters",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    regionId: uuid("region_id").references(() => regions.id),
    prefix: text("prefix").notNull(),
    nextValue: integer("next_value").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    // Key on (tenant, prefix, environment): prefix already encodes the region/scope, and this keeps
    // ON CONFLICT working (region_id is nullable and NULLs break a unique conflict target).
    // environment is part of the key so a sandbox test can never burn a live document number.
    unique("order_number_counters_scope_uq").on(t.tenantId, t.prefix, t.environment),
    index("order_number_counters_tenant_idx").on(t.tenantId),
    index("order_number_counters_region_idx").on(t.regionId),
  ],
);
