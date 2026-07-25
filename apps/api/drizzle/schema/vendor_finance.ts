import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { audit, money, pct, pk } from "./_shared";
import { environmentType, financingStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { vendors } from "./vendors";
import { purchaseOrders } from "./purchasing";

/**
 * Vendor financials (QNEW-50) + financing (QNEW-52). Tenant-scoped.
 * Payments allocate to purchase orders many-to-many (one payment across invoices, one invoice
 * across payments) — partial payments supported.
 */
export const vendorPayments = pgTable(
  "vendor_payments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    amount: money("amount").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    reference: text("reference"),
    uploadSource: text("upload_source").notNull().default("manual"),
    ...audit,
  },
  (t) => [
    index("vendor_payments_tenant_idx").on(t.tenantId),
    index("vendor_payments_vendor_idx").on(t.tenantId, t.vendorId),
  ],
);

export const vendorPaymentAllocations = pgTable(
  "vendor_payment_allocations",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => vendorPayments.id),
    purchaseOrderId: uuid("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id),
    allocatedAmount: money("allocated_amount").notNull(),
    ...audit,
  },
  (t) => [
    index("vpa_tenant_idx").on(t.tenantId),
    index("vpa_payment_idx").on(t.paymentId),
    index("vpa_po_idx").on(t.purchaseOrderId),
  ],
);

export const vendorFinancingRequests = pgTable(
  "vendor_financing_requests",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    requestedAmount: money("requested_amount").notNull(),
    interestRatePct: pct("interest_rate_pct").notNull(),
    interestAmount: money("interest_amount").notNull(),
    status: financingStatus("status").notNull().default("pending"),
    slaDueDate: timestamp("sla_due_date", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    index("vfr_tenant_idx").on(t.tenantId),
    index("vfr_vendor_idx").on(t.tenantId, t.vendorId),
    index("vfr_approved_by_idx").on(t.approvedBy),
  ],
);
