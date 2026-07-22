import { integer, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
// (uniqueIndex used for the pricing-policy scope constraint below)
import { audit, money, pct, pk } from "./_shared";
import { adjustmentType, pricingScopeType } from "./enums";
import { tenants } from "./tenancy";
import { vendors } from "./vendors";
import { cities, regions } from "./reference";
import { workshopBranches } from "./org";

/**
 * Vendor self-service (QNEW-49/51). Tenant-scoped (the vendor's catalog & pricing as used in a
 * workspace). Real quantity is internal-only; externally exposed as Available/Not-Available.
 */
export const vendorStockItems = pgTable(
  "vendor_stock_items",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    rawPartNumber: text("raw_part_number"),
    cleanedPartNumber: text("cleaned_part_number").notNull(),
    nameEn: text("name_en"),
    nameAr: text("name_ar"),
    partType: text("part_type"),
    quantity: integer("quantity").notNull().default(0), // internal only
    wholesalePrice: money("wholesale_price"),
    retailPrice: money("retail_price"),
    priceBeforeDiscount: money("price_before_discount"),
    uploadSource: text("upload_source").notNull().default("excel_upload"),
    ...audit,
  },
  (t) => [
    uniqueIndex("vendor_stock_uq").on(t.tenantId, t.vendorId, t.cleanedPartNumber),
    index("vendor_stock_tenant_idx").on(t.tenantId),
    index("vendor_stock_vendor_idx").on(t.vendorId),
    index("vendor_stock_part_idx").on(t.tenantId, t.cleanedPartNumber),
  ],
);

/** Vendor discount/markup rules by scope; most-specific (client_branch > region > global) wins. */
export const vendorPricingPolicies = pgTable(
  "vendor_pricing_policies",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    scopeType: pricingScopeType("scope_type").notNull().default("global"),
    regionId: uuid("region_id").references(() => regions.id),
    workshopBranchId: uuid("workshop_branch_id").references(() => workshopBranches.id),
    adjustmentType: adjustmentType("adjustment_type").notNull().default("discount"),
    adjustmentPct: pct("adjustment_pct").notNull().default("0"),
    ...audit,
  },
  (t) => [
    // UNIQUE (…) NULLS NOT DISTINCT added by hand migration (drizzle 0.36 limitation) so
    // resolvePrice is deterministic and setPricingPolicy upserts per scope.
    index("vendor_pricing_scope_idx").on(t.tenantId, t.vendorId, t.scopeType, t.regionId, t.workshopBranchId),
    index("vendor_pricing_tenant_idx").on(t.tenantId),
    index("vendor_pricing_vendor_idx").on(t.tenantId, t.vendorId),
    index("vendor_pricing_region_idx").on(t.regionId),
    index("vendor_pricing_branch_idx").on(t.workshopBranchId),
  ],
);
