import {
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { audit, money, pct, pk } from "./_shared";
import { deliveryType, extractionStatus, orderType } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { workshopBranches } from "./org";
import { vendors, vendorBranches } from "./vendors";
import { brandClasses, carBrands, itemStatuses, partCategories, vendorStatuses } from "./reference";

/**
 * RFQ / quotation stage (old: quotations / quotation_items / quotation_vendors / quotation_vendor_items).
 * Fix vs old: customer (workshop_branch_id) lives at the HEADER, NOT NULL. Vendor access token is
 * hashed. sla_hours is numeric only. `winning_vendor_quote_item_id` = old `cost_id` (the winning quote).
 */

/** RFQ header. `order_number` is issued from a per-tenant sequence (no MAX()+1). */
export const rfqs = pgTable(
  "rfqs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderNumber: text("order_number").notNull(),
    workshopBranchId: uuid("workshop_branch_id")
      .notNull() // customer at the header — fixes old §6.2
      .references(() => workshopBranches.id),
    plateNumber: text("plate_number"),
    vin: text("vin"),
    carBrandId: uuid("car_brand_id").references(() => carBrands.id),
    model: text("model"),
    orderType: orderType("order_type").notNull().default("regular"),
    deliveryType: deliveryType("delivery_type").notNull().default("delivery"),
    serviceAdvisorId: uuid("service_advisor_id").references(() => users.id),
    accountManagerId: uuid("account_manager_id").references(() => users.id),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    shippingPrice: money("shipping_price"),
    shippingType: text("shipping_type"),
    ...audit,
  },
  (t) => [
    uniqueIndex("rfqs_tenant_order_number_uq").on(t.tenantId, t.orderNumber),
    index("rfqs_tenant_idx").on(t.tenantId),
    index("rfqs_tenant_branch_idx").on(t.tenantId, t.workshopBranchId),
    index("rfqs_tenant_status_idx").on(t.tenantId, t.statusId),
    index("rfqs_service_advisor_idx").on(t.serviceAdvisorId),
    index("rfqs_account_manager_idx").on(t.accountManagerId),
    index("rfqs_car_brand_idx").on(t.carBrandId),
  ],
);

/** RFQ line item. `winningVendorQuoteItemId` FK added after rfq_vendor_items exists (below). */
export const rfqItems = pgTable(
  "rfq_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id),
    partNumber: text("part_number"),
    partDescription: text("part_description"),
    alternativePartNumber: text("alternative_part_number"),
    quantity: integer("quantity").notNull().default(1),
    carYear: integer("car_year"),
    brandClassId: uuid("brand_class_id").references(() => brandClasses.id),
    partCategoryId: uuid("part_category_id").references(() => partCategories.id),
    partPhotoKey: text("part_photo_key"),
    vin: text("vin"),
    statusId: uuid("status_id").references(() => itemStatuses.id),
    sellingPrice: money("selling_price"),
    discountPct: pct("discount_pct"),
    agencyPrice: money("agency_price"),
    /** The winning vendor quote (old cost_id). AnyPgColumn types the same-file forward ref. */
    winningVendorQuoteItemId: uuid("winning_vendor_quote_item_id").references(
      (): AnyPgColumn => rfqVendorItems.id,
    ),
    extractionStatus: extractionStatus("extraction_status"),
    extractedBy: uuid("extracted_by").references(() => users.id),
    extractedAt: timestamp("extracted_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    index("rfq_items_tenant_idx").on(t.tenantId),
    index("rfq_items_rfq_idx").on(t.rfqId),
    index("rfq_items_tenant_status_idx").on(t.tenantId, t.statusId),
    index("rfq_items_brand_class_idx").on(t.brandClassId),
    index("rfq_items_part_category_idx").on(t.partCategoryId),
    index("rfq_items_winning_quote_idx").on(t.winningVendorQuoteItemId),
    index("rfq_items_extracted_by_idx").on(t.extractedBy),
  ],
);

/** RFQ sent to a vendor/branch. Access token is HASHED (old stored plaintext). */
export const rfqVendors = pgTable(
  "rfq_vendors",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    rfqId: uuid("rfq_id")
      .notNull()
      .references(() => rfqs.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    vendorBranchId: uuid("vendor_branch_id").references(() => vendorBranches.id),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    tokenHash: text("token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    uniqueIndex("rfq_vendors_token_hash_uq").on(t.tokenHash), // hot public lookup + no dup tokens
    index("rfq_vendors_tenant_idx").on(t.tenantId),
    index("rfq_vendors_rfq_idx").on(t.rfqId),
    index("rfq_vendors_vendor_idx").on(t.vendorId),
    index("rfq_vendors_branch_idx").on(t.vendorBranchId),
    index("rfq_vendors_status_idx").on(t.statusId),
  ],
);

/** A vendor's price for one RFQ line. sla_hours numeric only (old also had text sla). */
export const rfqVendorItems = pgTable(
  "rfq_vendor_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    rfqVendorId: uuid("rfq_vendor_id")
      .notNull()
      .references(() => rfqVendors.id),
    rfqItemId: uuid("rfq_item_id")
      .notNull()
      .references(() => rfqItems.id),
    offeredCost: money("offered_cost"),
    discountPct: pct("discount_pct"),
    slaHours: integer("sla_hours"),
    availableQty: integer("available_qty"),
    availableBrandClassId: uuid("available_brand_class_id").references(() => brandClasses.id),
    alternativePartNumber: text("alternative_part_number"),
    statusId: uuid("status_id").references(() => vendorStatuses.id),
    notes: text("notes"),
    ...audit,
  },
  (t) => [
    uniqueIndex("rfq_vendor_items_vendor_item_uq").on(t.rfqVendorId, t.rfqItemId),
    index("rfq_vendor_items_tenant_idx").on(t.tenantId),
    index("rfq_vendor_items_rfq_item_idx").on(t.rfqItemId),
    index("rfq_vendor_items_brand_class_idx").on(t.availableBrandClassId),
    index("rfq_vendor_items_status_idx").on(t.statusId),
  ],
);
