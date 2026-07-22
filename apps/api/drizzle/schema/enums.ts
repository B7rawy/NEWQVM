import { pgEnum } from "drizzle-orm/pg-core";

/**
 * PostgreSQL enums = fixed, small, code-controlled sets the user does NOT extend.
 * Business vocabulary that admins may extend (statuses, brands, regions, reasons) lives in
 * reference TABLES instead (see reference.ts) — this replaces the old generic list_data.
 */

/** How a membership/role sits relative to the platform. Mirrors @qvm/shared enums. */
export const membershipRole = pgEnum("membership_role", [
  // platform (Qparts) side
  "super_admin",
  "staff",
  "account_manager",
  "purchasing",
  "part_extractor",
  // company (workshop) side
  "company_admin",
  "branch_manager",
  "service_advisor",
  // vendor side
  "vendor_admin",
  "vendor_user",
]);

/** RFQ / order commercial type. */
export const orderType = pgEnum("order_type", ["regular", "bulk"]);

/** Delivery arrangement. */
export const deliveryType = pgEnum("delivery_type", ["delivery", "pickup"]);

/** Branch order category (old: client_branches.order_category / is_bulk). */
export const orderCategory = pgEnum("order_category", ["regular", "bulk"]);

/** Who is responsible for a return/issue (old: free int; now explicit). */
export const returnResponsibility = pgEnum("return_responsibility", [
  "internal",
  "vendor",
  "client",
  "delivery_agent",
]);

/** Where a price came from (old: list 8 + text CHECK + text column — unified here). */
export const pricingSource = pgEnum("pricing_source", [
  "internal_erp",
  "external_excel",
  "external_api",
  "manual",
  "agency_catalog",
]);

/** Vendor classification (old: vendors.vendor_type text + vendor_type_id — unified). */
export const vendorType = pgEnum("vendor_type", ["agency", "commercial", "external"]);

/** Part-number extraction workflow state (QNEW-21 lineage). */
export const extractionStatus = pgEnum("extraction_status", [
  "pending",
  "extracted",
  "not_found",
]);

/** Polymorphic entity kinds referenced by attachments / status_logs / notes. */
export const entityType = pgEnum("entity_type", [
  "rfq",
  "rfq_item",
  "rfq_vendor",
  "order",
  "order_item",
  "purchase_order",
  "delivery",
  "return",
  "return_issue",
  "invoice",
  "credit_note",
]);
