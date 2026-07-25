import { jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { audit, money, pct, pk, timestamps } from "./_shared";
import { environmentType, pricingSource } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { brandClasses, carBrands, costRanges, partCategories } from "./reference";
import { vendors } from "./vendors";
import { workshopBranches } from "./org";
import { rfqItems } from "./rfq";

/**
 * Pricing & margins (old: cost_logs/pricing_logs/profit_*). pricing_source is ONE enum (old had
 * a list + a text CHECK + a text column). Logs are append-only (no updated_by). Margins are
 * tenant-scoped (each workspace may differ). Two old profit-audit tables → one `profitMarginAudit`.
 */

/** Purchase-price history (append-only). */
export const costLogs = pgTable(
  "cost_logs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    rfqItemId: uuid("rfq_item_id").references(() => rfqItems.id),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    cost: money("cost"),
    pricingSource: pricingSource("pricing_source"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("cost_logs_tenant_idx").on(t.tenantId),
    index("cost_logs_rfq_item_idx").on(t.rfqItemId),
    index("cost_logs_vendor_idx").on(t.vendorId),
    index("cost_logs_created_by_idx").on(t.createdBy),
  ],
);

/** Selling-price history (append-only). */
export const pricingLogs = pgTable(
  "pricing_logs",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    rfqItemId: uuid("rfq_item_id").references(() => rfqItems.id),
    price: money("price"),
    pricingSource: pricingSource("pricing_source"),
    createdBy: uuid("created_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("pricing_logs_tenant_idx").on(t.tenantId),
    index("pricing_logs_rfq_item_idx").on(t.rfqItemId),
    index("pricing_logs_created_by_idx").on(t.createdBy),
  ],
);

/** Profit category = (part category × brand class). Tenant-scoped. */
export const profitCategories = pgTable(
  "profit_categories",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name"),
    partCategoryId: uuid("part_category_id").references(() => partCategories.id),
    brandClassId: uuid("brand_class_id").references(() => brandClasses.id),
    ...audit,
  },
  (t) => [
    index("profit_categories_tenant_idx").on(t.tenantId),
    index("profit_categories_part_cat_idx").on(t.partCategoryId),
    index("profit_categories_brand_class_idx").on(t.brandClassId),
    // UNIQUE (tenant, part_category, brand_class) NULLS NOT DISTINCT — deterministic margin lookup —
    // added by hand migration 0037 (drizzle 0.36 can't emit NULLS NOT DISTINCT).
  ],
);

/** Margin matrix: (profit category × cost range) → margin %. */
export const profitMargins = pgTable(
  "profit_margins",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    profitCategoryId: uuid("profit_category_id")
      .notNull()
      .references(() => profitCategories.id),
    costRangeId: uuid("cost_range_id").references(() => costRanges.id),
    marginPct: pct("margin_pct"),
    ...audit,
  },
  (t) => [
    index("profit_margins_tenant_idx").on(t.tenantId),
    index("profit_margins_category_idx").on(t.profitCategoryId),
    index("profit_margins_cost_range_idx").on(t.costRangeId),
  ],
);

/** Branch-level margin override. */
export const profitMarginsBranch = pgTable(
  "profit_margins_branch",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workshopBranchId: uuid("workshop_branch_id")
      .notNull()
      .references(() => workshopBranches.id),
    profitCategoryId: uuid("profit_category_id")
      .notNull()
      .references(() => profitCategories.id),
    costRangeId: uuid("cost_range_id").references(() => costRanges.id),
    marginPct: pct("margin_pct"),
    ...audit,
  },
  (t) => [
    index("profit_margins_branch_tenant_idx").on(t.tenantId),
    index("profit_margins_branch_branch_idx").on(t.workshopBranchId),
    index("profit_margins_branch_category_idx").on(t.profitCategoryId),
    index("profit_margins_branch_cost_range_idx").on(t.costRangeId),
  ],
);

/** Single margin-change audit trail (old had profit_margins_audit + profit_percentage_update_logs). */
export const profitMarginAudit = pgTable(
  "profit_margin_audit",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    profitMarginId: uuid("profit_margin_id"),
    oldValue: pct("old_value"),
    newValue: pct("new_value"),
    changedBy: uuid("changed_by").references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("profit_margin_audit_tenant_idx").on(t.tenantId),
    index("profit_margin_audit_changed_by_idx").on(t.changedBy),
  ],
);

/** Agency price catalogs (old: stock_files). */
export const stockFiles = pgTable(
  "stock_files",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    fileDate: timestamp("file_date", { withTimezone: true }),
    partNumber: text("part_number"),
    brandClassId: uuid("brand_class_id").references(() => brandClasses.id),
    carBrandId: uuid("car_brand_id").references(() => carBrands.id),
    costBeforeDiscount: money("cost_before_discount"),
    discountPct: pct("discount_pct"),
    vendorId: uuid("vendor_id").references(() => vendors.id),
    meta: jsonb("meta").notNull().default({}),
    ...audit,
  },
  (t) => [
    index("stock_files_tenant_idx").on(t.tenantId),
    index("stock_files_part_number_idx").on(t.tenantId, t.partNumber),
    index("stock_files_vendor_idx").on(t.vendorId),
    index("stock_files_brand_class_idx").on(t.brandClassId),
    index("stock_files_car_brand_idx").on(t.carBrandId),
  ],
);
