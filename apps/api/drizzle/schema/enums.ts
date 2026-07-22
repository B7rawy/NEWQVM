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

/**
 * Platform-staff roles (Qparts internal) — a member with any of these sees ALL workspaces.
 * Distinct from membershipRole (per-tenant). Includes finance_manager / pricing_supervisor
 * to reconcile the role list ↔ code mismatch flagged by QNEW-48-A.
 */
export const platformRole = pgEnum("platform_role", [
  "super_admin",
  "staff",
  "account_manager",
  "purchasing",
  "part_extractor",
  "finance_manager",
  "pricing_supervisor",
]);

/** Where a parts_master row came from (QNEW-32) — mandatory provenance on every part. */
export const partSource = pgEnum("part_source", [
  "manual_purchasing",
  "vendor_portal",
  "excel_upload",
  "invoice_ocr",
  "direct_admin",
  "dictionary_migration",
]);

/** Who ultimately pays (QNEW-43) — distinct from order_type. */
export const payerType = pgEnum("payer_type", ["cash_client", "credit_client", "insurance"]);

/** How a selling price is derived (QNEW-39). */
export const priceBasis = pgEnum("price_basis", ["agency_price", "vendor_price", "calculated_margin"]);

/** Price adjustment direction (QNEW-39/51). */
export const adjustmentType = pgEnum("adjustment_type", ["discount", "markup"]);

/** Scope of a vendor pricing policy (QNEW-51) — most-specific wins. */
export const pricingScopeType = pgEnum("pricing_scope_type", ["global", "region", "client_branch"]);

/** Vendor invoice-financing request lifecycle (QNEW-52). */
export const financingStatus = pgEnum("financing_status", [
  "pending",
  "approved",
  "rejected",
  "disbursed",
]);

/** Shipping / logistics (QNEW-54/55). */
export const carrierModel = pgEnum("carrier_model", [
  "on_demand_same_city",
  "hub_dropoff_pickup",
  "hub_and_spoke",
  "independent_driver",
]);
export const carrierOwnerType = pgEnum("carrier_owner_type", ["vendor", "client_branch"]);
export const shipmentStatus = pgEnum("shipment_status", [
  "created",
  "assigned",
  "in_transit",
  "delivered",
  "cancelled",
]);
export const driverOwnerType = pgEnum("driver_owner_type", ["private", "marketplace"]);
export const driverRequestStatus = pgEnum("driver_request_status", [
  "pending",
  "accepted",
  "rejected",
  "expired",
]);

/** Vendor-assignment automation (QNEW-35): suggest in the modal vs auto-send. */
export const automationMode = pgEnum("automation_mode", ["suggest", "auto"]);

/** Approval engine (QNEW-53). */
export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected"]);
export const approvalActionType = pgEnum("approval_action_type", ["approve", "reject", "reassign"]);
export const approvalLevelMode = pgEnum("approval_level_mode", ["sequential", "parallel"]);

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

/** Vendor link status within a workspace (old: tenant_vendors.status free text). */
export const tenantVendorStatus = pgEnum("tenant_vendor_status", [
  "active",
  "suspended",
  "archived",
]);

/** Link status of a global workshop within a workspace (mirrors tenant_vendor_status). */
export const tenantWorkshopStatus = pgEnum("tenant_workshop_status", [
  "active",
  "suspended",
  "archived",
]);

/** Data environment within a workspace — sandbox data never triggers real side-effects (ADR-0012). */
export const environmentType = pgEnum("environment_type", ["live", "sandbox"]);

/** Which side a return reason belongs to (old lists 13 internal + 23 client). */
export const returnReasonSide = pgEnum("return_reason_side", ["client", "internal"]);

/** Return-issue classification (old: return_issues.issue_type free int/text). */
export const returnIssueType = pgEnum("return_issue_type", [
  "wrong_part",
  "wrong_price",
  "defective",
  "damaged",
  "delay",
  "other",
]);

/** Status vocabulary a status_log row refers to (item lifecycle vs vendor lifecycle). */
export const statusDomain = pgEnum("status_domain", ["item", "vendor"]);

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
