import { integer, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, pk } from "./_shared";
import { environmentType } from "./enums";
import { tenants } from "./tenancy";
import { itemStatuses } from "./reference";
import { rfqs, rfqItems, rfqVendorItems } from "./rfq";

/**
 * Confirmed order stage (old: confirmed_orders / confirmed_items).
 * `order_items` is THE SPINE — delivery, invoice, credit note, return and issue all hang off it
 * (old `confirmed_item_id`). One order_item ↔ one rfq_item (UNIQUE), matching the old 1:1.
 */

export const orders = pgTable(
  "orders",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id),
    orderNumber: text("order_number").notNull(),
    clientPo: text("client_po"),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("orders_tenant_order_number_uq").on(t.tenantId, t.orderNumber),
    uniqueIndex("orders_rfq_uq").on(t.rfqId), // one order per RFQ (review #6)
    index("orders_tenant_idx").on(t.tenantId),
    index("orders_tenant_status_idx").on(t.tenantId, t.statusId),
  ],
);

/** The confirmed line — execution spine. UNIQUE on rfq_item_id (strict 1:1 with the RFQ line). */
export const orderItems = pgTable(
  "order_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    rfqItemId: uuid("rfq_item_id")
      .notNull()
      .references(() => rfqItems.id),
    finalPartNumber: text("final_part_number"),
    approvedQty: integer("approved_qty"),
    winningVendorQuoteItemId: uuid("winning_vendor_quote_item_id").references(
      () => rfqVendorItems.id,
    ),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("order_items_rfq_item_uq").on(t.rfqItemId), // 1:1 with RFQ line
    index("order_items_tenant_idx").on(t.tenantId),
    index("order_items_order_idx").on(t.orderId),
    index("order_items_tenant_status_idx").on(t.tenantId, t.statusId),
    index("order_items_winning_quote_idx").on(t.winningVendorQuoteItemId),
  ],
);
