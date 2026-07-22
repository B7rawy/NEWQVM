import { bigint, boolean, integer, pgTable, text, uuid, index, unique } from "drizzle-orm/pg-core";
import { audit, pk, timestamps } from "./_shared";
import { entityType, statusDomain } from "./enums";
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
    ...timestamps,
  },
  (t) => [
    index("status_logs_tenant_idx").on(t.tenantId),
    index("status_logs_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("status_logs_changed_by_idx").on(t.changedBy),
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
    regionId: uuid("region_id").references(() => regions.id),
    prefix: text("prefix").notNull(),
    nextValue: integer("next_value").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    // Key on (tenant, prefix): prefix already encodes the region/scope, and this keeps
    // ON CONFLICT working (region_id is nullable and NULLs break a unique conflict target).
    unique("order_number_counters_scope_uq").on(t.tenantId, t.prefix),
    index("order_number_counters_tenant_idx").on(t.tenantId),
    index("order_number_counters_region_idx").on(t.regionId),
  ],
);
