import { pgTable, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { automationMode } from "./enums";
import { tenants } from "./tenancy";
import { workshopBranches } from "./org";
import { cities, partCategories } from "./reference";
import { vendors } from "./vendors";

/**
 * Auto vendor assignment (QNEW-29/35/38). Admin defines rules linking a client branch (null = all)
 * + part category (null = all) + city (null = any) → a set of vendors, with suggest vs auto mode.
 * Tenant-scoped.
 */
export const vendorSelectionRules = pgTable(
  "vendor_selection_rules",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workshopBranchId: uuid("workshop_branch_id").references(() => workshopBranches.id),
    partCategoryId: uuid("part_category_id").references(() => partCategories.id),
    cityId: uuid("city_id").references(() => cities.id),
    automationMode: automationMode("automation_mode").notNull().default("suggest"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    // one rule per (branch, category, city) scope
    uniqueIndex("vendor_selection_rules_scope_uq").on(
      t.tenantId,
      t.workshopBranchId,
      t.partCategoryId,
      t.cityId,
    ),
    index("vendor_selection_rules_tenant_idx").on(t.tenantId),
    index("vendor_selection_rules_branch_idx").on(t.workshopBranchId),
    index("vendor_selection_rules_category_idx").on(t.partCategoryId),
    index("vendor_selection_rules_city_idx").on(t.cityId),
  ],
);

export const vendorSelectionRuleVendors = pgTable(
  "vendor_selection_rule_vendors",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => vendorSelectionRules.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("vsr_vendors_uq").on(t.ruleId, t.vendorId),
    index("vsr_vendors_tenant_idx").on(t.tenantId),
    index("vsr_vendors_rule_idx").on(t.ruleId),
    index("vsr_vendors_vendor_idx").on(t.vendorId),
  ],
);
