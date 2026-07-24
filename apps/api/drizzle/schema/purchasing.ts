import { integer, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, money, pk } from "./_shared";
import { returnResponsibility } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { paymentAccounts, returnReasons, vendorStatuses } from "./reference";
import { vendors } from "./vendors";
import { orders, orderItems } from "./orders";
import { rfqVendorItems } from "./rfq";

/**
 * Purchasing (old: purchase_orders / purchase_items / pickups / pickup_items).
 * Vendor invoices/returns move to the unified `attachments` + credit_notes (old had url columns).
 */

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    paymentAccountId: uuid("payment_account_id").references(() => paymentAccounts.id),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    vendorInvoiceNumber: text("vendor_invoice_number"),
    invoiceAmount: money("invoice_amount"), // QNEW-50: vendor invoice total
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    index("purchase_orders_tenant_idx").on(t.tenantId),
    index("purchase_orders_order_idx").on(t.orderId),
    index("purchase_orders_vendor_idx").on(t.vendorId),
    index("purchase_orders_payment_account_idx").on(t.paymentAccountId),
    index("purchase_orders_status_idx").on(t.statusId),
    index("purchase_orders_uploaded_by_idx").on(t.uploadedBy),
    // DB backstop for "one PO per (order, vendor)" (createForOrder checks-then-inserts; 23505 → 400)
    uniqueIndex("purchase_orders_order_vendor_uq").on(t.orderId, t.vendorId),
  ],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id),
    vendorQuoteItemId: uuid("vendor_quote_item_id").references(() => rfqVendorItems.id),
    qty: integer("qty"),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    ...audit,
  },
  (t) => [
    index("purchase_items_tenant_idx").on(t.tenantId),
    index("purchase_items_po_idx").on(t.purchaseOrderId),
    index("purchase_items_order_item_idx").on(t.orderItemId),
    index("purchase_items_quote_idx").on(t.vendorQuoteItemId),
    index("purchase_items_status_idx").on(t.statusId),
  ],
);

/** Pickup from a vendor branch. */
export const pickups = pgTable(
  "pickups",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    deliveryAgentId: uuid("delivery_agent_id").references(() => users.id),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    ...audit,
  },
  (t) => [
    index("pickups_tenant_idx").on(t.tenantId),
    index("pickups_po_idx").on(t.purchaseOrderId),
    index("pickups_agent_idx").on(t.deliveryAgentId),
    index("pickups_status_idx").on(t.statusId),
  ],
);

export const pickupItems = pgTable(
  "pickup_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    pickupId: uuid("pickup_id")
      .notNull()
      .references(() => pickups.id),
    purchaseItemId: uuid("purchase_item_id")
      .notNull()
      .references(() => purchaseItems.id),
    qty: integer("qty"),
    ...audit,
  },
  (t) => [
    index("pickup_items_tenant_idx").on(t.tenantId),
    index("pickup_items_pickup_idx").on(t.pickupId),
    index("pickup_items_purchase_item_idx").on(t.purchaseItemId),
  ],
);

/**
 * Vendor credit notes — returning parts TO a vendor for credit (old: vendor_creditnotes /
 * vendor_creditnote_items). Distinct from client-side credit_notes (billing.ts). Restores the
 * purchase-side return link the review (C1) found missing from the chain.
 */
export const vendorCreditNotes = pgTable(
  "vendor_credit_notes",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    creditNoteNumber: text("credit_note_number"),
    total: money("total"),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    ...audit,
  },
  (t) => [
    index("vendor_credit_notes_tenant_idx").on(t.tenantId),
    index("vendor_credit_notes_po_idx").on(t.purchaseOrderId),
    index("vendor_credit_notes_status_idx").on(t.statusId),
  ],
);

export const vendorCreditNoteItems = pgTable(
  "vendor_credit_note_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vendorCreditNoteId: uuid("vendor_credit_note_id")
      .notNull()
      .references(() => vendorCreditNotes.id),
    purchaseItemId: uuid("purchase_item_id")
      .notNull()
      .references(() => purchaseItems.id),
    returnQty: integer("return_qty"),
    returnReasonId: uuid("return_reason_id").references(() => returnReasons.id),
    responsibility: returnResponsibility("responsibility"),
    ...audit,
  },
  (t) => [
    index("vendor_credit_note_items_tenant_idx").on(t.tenantId),
    index("vendor_credit_note_items_vcn_idx").on(t.vendorCreditNoteId),
    index("vendor_credit_note_items_purchase_item_idx").on(t.purchaseItemId),
    index("vendor_credit_note_items_reason_idx").on(t.returnReasonId),
  ],
);
