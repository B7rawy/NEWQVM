import { boolean, pgTable, text, uuid, index } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { orderCategory } from "./enums";
import { tenants } from "./tenancy";
import { cities, regions } from "./reference";

/**
 * Client organizations WITHIN a workspace: the workshops (Qparts' clients) and their branches.
 * Fixes old §6.2: the customer now lives at the RFQ HEADER via workshop_branch_id (NOT NULL there),
 * not scattered on line items.
 */

/** A client company (workshop) inside a tenant/workspace. */
export const workshops = pgTable(
  "workshops",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    taxNumber: text("tax_number"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [index("workshops_tenant_idx").on(t.tenantId)],
);

/** A physical branch of a workshop. RFQs are placed by / for a branch. */
export const workshopBranches = pgTable(
  "workshop_branches",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id),
    name: text("name").notNull(),
    regionId: uuid("region_id").references(() => regions.id),
    cityId: uuid("city_id").references(() => cities.id),
    orderCategory: orderCategory("order_category").notNull().default("regular"),
    isBulk: boolean("is_bulk").notNull().default(false),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    index("workshop_branches_tenant_idx").on(t.tenantId),
    index("workshop_branches_workshop_idx").on(t.workshopId),
    index("workshop_branches_region_idx").on(t.regionId),
    index("workshop_branches_city_idx").on(t.cityId),
  ],
);
