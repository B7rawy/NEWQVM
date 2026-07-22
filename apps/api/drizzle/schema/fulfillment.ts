import { integer, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { audit, money, pk } from "./_shared";
import { returnIssueType, returnResponsibility } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { itemStatuses, returnReasons } from "./reference";
import { vendors } from "./vendors";
import { orders, orderItems } from "./orders";
import { creditNotes, invoices } from "./billing";

/**
 * Fulfillment: deliveries + returns (old: deliveries/delivery_items/returns/return_items,
 * plus the flat text-typed delivery_notes/return_notes — dropped, notes become generated docs).
 * Split delivery IS supported: a line's qty can span multiple delivery_items.
 * `return_issues` merges the old duplicate return_issues + returned_issues into one table.
 */

/** Captured signature (referenced by deliveries/returns). */
export const signatures = pgTable(
  "signatures",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    imageKey: text("image_key").notNull(),
    signedBy: text("signed_by"),
    ...audit,
  },
  (t) => [index("signatures_tenant_idx").on(t.tenantId)],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    deliveryNumber: text("delivery_number"),
    clientPo: text("client_po"),
    deliveryCompany: text("delivery_company"),
    shippingPrice: money("shipping_price"), // charged to client
    shippingCost: money("shipping_cost"), // actually paid — delivery margin = price - cost
    signatureId: uuid("signature_id").references(() => signatures.id),
    signedBy: uuid("signed_by").references(() => users.id),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    index("deliveries_tenant_idx").on(t.tenantId),
    index("deliveries_order_idx").on(t.orderId),
    index("deliveries_status_idx").on(t.statusId),
    index("deliveries_signature_idx").on(t.signatureId),
    index("deliveries_signed_by_idx").on(t.signedBy),
  ],
);

/** Delivered quantity for a line — supports partial/split delivery. invoice_id linked later. */
export const deliveryItems = pgTable(
  "delivery_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    qty: integer("qty"), // sent
    receivedQty: integer("received_qty"), // received — discrepancy drives the return flow
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    ...audit,
  },
  (t) => [
    index("delivery_items_tenant_idx").on(t.tenantId),
    index("delivery_items_delivery_idx").on(t.deliveryId),
    index("delivery_items_order_item_idx").on(t.orderItemId),
    index("delivery_items_invoice_idx").on(t.invoiceId),
  ],
);

export const returns = pgTable(
  "returns",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    returnNumber: text("return_number"),
    signatureId: uuid("signature_id").references(() => signatures.id),
    signedBy: uuid("signed_by").references(() => users.id),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    index("returns_tenant_idx").on(t.tenantId),
    index("returns_order_idx").on(t.orderId),
    index("returns_status_idx").on(t.statusId),
    index("returns_signature_idx").on(t.signatureId),
    index("returns_signed_by_idx").on(t.signedBy),
  ],
);

export const returnItems = pgTable(
  "return_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    returnId: uuid("return_id")
      .notNull()
      .references(() => returns.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    qty: integer("qty"),
    returnReasonId: uuid("return_reason_id").references(() => returnReasons.id),
    responsibility: returnResponsibility("responsibility"),
    creditNoteId: uuid("credit_note_id").references(() => creditNotes.id),
    ...audit,
  },
  (t) => [
    index("return_items_tenant_idx").on(t.tenantId),
    index("return_items_return_idx").on(t.returnId),
    index("return_items_order_item_idx").on(t.orderItemId),
    index("return_items_reason_idx").on(t.returnReasonId),
    index("return_items_credit_note_idx").on(t.creditNoteId),
  ],
);

/** Return-issue file — merges old return_issues + returned_issues into ONE table. */
export const returnIssues = pgTable(
  "return_issues",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    responsibility: returnResponsibility("responsibility"),
    issueType: returnIssueType("issue_type"),
    deliveryAgentId: uuid("delivery_agent_id").references(() => users.id),
    mainVendorId: uuid("main_vendor_id").references(() => vendors.id),
    partNumberSource: text("part_number_source"),
    notes: text("notes"),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    ...audit,
  },
  (t) => [
    index("return_issues_tenant_idx").on(t.tenantId),
    index("return_issues_order_item_idx").on(t.orderItemId),
    index("return_issues_agent_idx").on(t.deliveryAgentId),
    index("return_issues_vendor_idx").on(t.mainVendorId),
    index("return_issues_status_idx").on(t.statusId),
  ],
);
