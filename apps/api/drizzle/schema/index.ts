// Schema barrel — the single source drizzle-kit reads (drizzle.config.ts).
// One file per domain; every transactional table carries tenant_id + RLS (added in migrations).
//
// Foundation slice (Phase 1a — this commit):
export * from "./enums";
export * from "./reference";
export * from "./tenancy";
export * from "./identity";
export * from "./org";

// Order chain, vendors, pricing, billing, cross-cutting (Phase 1b — this commit):
export * from "./vendors";
export * from "./rfq";
export * from "./orders";
export * from "./purchasing";
export * from "./fulfillment";
export * from "./billing";
export * from "./pricing";
export * from "./crosscutting";

// Roadmap modules (QNEW):
export * from "./parts"; // QNEW-28 Master Data Foundation
export * from "./insurance"; // QNEW-31 Insurance/Payer
export * from "./pricing_engine"; // QNEW-30 Unified Pricing Engine
export * from "./vendor_assignment"; // QNEW-29 Auto Vendor Assignment
export * from "./infra"; // QNEW-47 audit_log + business_calendar
export * from "./approvals"; // QNEW-53 Approval Engine
export * from "./vendor_selfservice"; // QNEW-49/51 Vendor stock + pricing policy
export * from "./vendor_finance"; // QNEW-50/52 Vendor payments + financing
