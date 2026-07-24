import { integer, pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, money, pk } from "./_shared";
import { tenants } from "./tenancy";
import { itemStatuses, returnReasons } from "./reference";
import { orders, orderItems } from "./orders";

/**
 * Billing: client invoices + credit notes (old: invoices/invoice_items/creditnotes/creditnote_items).
 * All amounts numeric(14,2), all dates timestamptz — old stored these as text on the flat notes.
 */

export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    invoiceNumber: text("invoice_number"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    totalBeforeVat: money("total_before_vat"),
    vatAmount: money("vat_amount"),
    totalInclVat: money("total_incl_vat"),
    externalRef: text("external_ref"), // Zoho id
    statusId: uuid("status_id").references(() => itemStatuses.id),
    ...audit,
  },
  (t) => [
    index("invoices_tenant_idx").on(t.tenantId),
    index("invoices_order_idx").on(t.orderId),
    index("invoices_status_idx").on(t.statusId),
    // DB backstop for "one invoice per order" (services check-then-insert; 23505 → 400)
    uniqueIndex("invoices_order_uq").on(t.orderId),
  ],
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    qty: integer("qty"),
    unitPrice: money("unit_price"),
    ...audit,
  },
  (t) => [
    index("invoice_items_tenant_idx").on(t.tenantId),
    index("invoice_items_invoice_idx").on(t.invoiceId),
    index("invoice_items_order_item_idx").on(t.orderItemId),
  ],
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    creditNoteNumber: text("credit_note_number"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    total: money("total"),
    externalRef: text("external_ref"),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    ...audit,
  },
  (t) => [
    index("credit_notes_tenant_idx").on(t.tenantId),
    index("credit_notes_order_idx").on(t.orderId),
    index("credit_notes_status_idx").on(t.statusId),
  ],
);

export const creditNoteItems = pgTable(
  "credit_note_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    qty: integer("qty"),
    returnReasonId: uuid("return_reason_id").references(() => returnReasons.id),
    ...audit,
  },
  (t) => [
    index("credit_note_items_tenant_idx").on(t.tenantId),
    index("credit_note_items_cn_idx").on(t.creditNoteId),
    index("credit_note_items_order_item_idx").on(t.orderItemId),
    index("credit_note_items_reason_idx").on(t.returnReasonId),
  ],
);
