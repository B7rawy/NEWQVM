import { boolean, jsonb, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { orderCategory, tenantWorkshopStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { cities, regions } from "./reference";

/**
 * Workshops (Qparts' clients) and their branches. Like vendors, a workshop is a GLOBAL entity so the
 * same real company can be shared across multiple workspaces (ADR-0011). Workspace access is granted
 * via `tenant_workshops` (mirrors tenant_vendors); operational rows (RFQs/orders) carry their own
 * tenant_id, so a branch used in workspace A produces A-scoped RFQs.
 */

/** A client company (workshop) — global master data. */
export const workshops = pgTable("workshops", {
  id: pk(),
  name: text("name").notNull(),
  taxNumber: text("tax_number"),
  isActive: isActive(),
  ...audit,
});

/**
 * Workshop portal identity — which global user works for which global workshop (mirrors vendor_users).
 * Global (no tenant_id); a workshop user reaches a workspace via tenant_workshops. `/me` resolves
 * persona = "workshop" when a row exists here; the AuthGuard grants workspace access the same way.
 */
export const workshopUsers = pgTable(
  "workshop_users",
  {
    id: pk(),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    isWorkshopAdmin: boolean("is_workshop_admin").notNull().default(false),
    ...audit,
  },
  (t) => [
    uniqueIndex("workshop_users_workshop_user_uq").on(t.workshopId, t.userId),
    index("workshop_users_user_idx").on(t.userId),
  ],
);

/** A physical branch of a workshop (global, under the workshop). RFQs are placed for a branch. */
export const workshopBranches = pgTable(
  "workshop_branches",
  {
    id: pk(),
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
    index("workshop_branches_workshop_idx").on(t.workshopId),
    index("workshop_branches_region_idx").on(t.regionId),
    index("workshop_branches_city_idx").on(t.cityId),
  ],
);

/**
 * Link table: which global workshop is active in which workspace (mirrors tenant_vendors).
 * Carries tenant_id + RLS — every workspace-scoped workshop query goes through here.
 */
export const tenantWorkshops = pgTable(
  "tenant_workshops",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    workshopId: uuid("workshop_id")
      .notNull()
      .references(() => workshops.id),
    status: tenantWorkshopStatus("status").notNull().default("active"),
    settings: jsonb("settings").notNull().default({}),
    linkedBy: uuid("linked_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("tenant_workshops_tenant_workshop_uq").on(t.tenantId, t.workshopId),
    index("tenant_workshops_tenant_idx").on(t.tenantId),
    index("tenant_workshops_workshop_idx").on(t.workshopId),
    index("tenant_workshops_linked_by_idx").on(t.linkedBy),
  ],
);
