import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { activationStatus, counterpartyType, tenantVendorStatus, vendorType } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { cities, regions } from "./reference";

/**
 * Vendors (ADR-0008). The vendor is a GLOBAL legal entity (no tenant_id); a workspace links to
 * it via `tenant_vendors` (which carries tenant_id + RLS). Today each workspace sees only its
 * linked vendors; tomorrow the same vendor links to many workspaces with zero schema change.
 * Transaction rows (rfq_vendors, purchase_orders, …) always carry tenant_id, so history stays
 * isolated per workspace even for a shared vendor.
 */

/** Global supplier identity — shared across workspaces. */
export const vendors = pgTable(
  "vendors",
  {
    id: pk(),
    legalName: text("legal_name").notNull(),
    // QNEW-71: individual|company classification; drives which dedup key applies.
    counterpartyType: counterpartyType("counterparty_type").notNull().default("company"),
    // QNEW-71: self-registered rows start 'pending' until they provide their identifier.
    activationStatus: activationStatus("activation_status").notNull().default("active"),
    commercialRegistrationNumber: text("commercial_registration_number"),
    taxNumber: text("tax_number"),
    primaryEmail: text("primary_email"),
    primaryPhone: text("primary_phone"),
    vendorType: vendorType("vendor_type").notNull().default("commercial"),
    paymentTermsDays: integer("payment_terms_days"), // QNEW-50: overdue calc
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    // Scoped dedup keys (partial unique): company→tax_number, individual→mobile (primary_phone).
    uniqueIndex("vendors_company_tax_uq")
      .on(t.taxNumber)
      .where(sql`${t.counterpartyType} = 'company' AND ${t.taxNumber} IS NOT NULL`),
    uniqueIndex("vendors_individual_mobile_uq")
      .on(t.primaryPhone)
      .where(sql`${t.counterpartyType} = 'individual' AND ${t.primaryPhone} IS NOT NULL`),
  ],
);

/** Physical branch of a vendor. Location unified as geography (old had lat/lng + text). */
export const vendorBranches = pgTable(
  "vendor_branches",
  {
    id: pk(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    name: text("name").notNull(),
    regionId: uuid("region_id").references(() => regions.id),
    cityId: uuid("city_id").references(() => cities.id),
    address: text("address"),
    // PostGIS point stored as text(WKT) for now; upgraded to geography(Point) in the PostGIS migration.
    location: text("location"),
    paymentMethod: text("payment_method"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    index("vendor_branches_vendor_idx").on(t.vendorId),
    index("vendor_branches_region_idx").on(t.regionId),
    index("vendor_branches_city_idx").on(t.cityId),
  ],
);

/** Vendor-portal users (linked to the global vendor; may serve multiple tenants). */
export const vendorUsers = pgTable(
  "vendor_users",
  {
    id: pk(),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    isVendorAdmin: boolean("is_vendor_admin").notNull().default(false),
    ...audit,
  },
  (t) => [
    uniqueIndex("vendor_users_vendor_user_uq").on(t.vendorId, t.userId),
    index("vendor_users_user_idx").on(t.userId),
  ],
);

/**
 * The link table: which global vendor is active in which workspace, plus the per-relationship
 * settings. THIS carries tenant_id + RLS — every vendor query goes through here.
 */
export const tenantVendors = pgTable(
  "tenant_vendors",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id),
    status: tenantVendorStatus("status").notNull().default("active"),
    paymentTerms: text("payment_terms"),
    classification: text("classification"),
    agreement: jsonb("agreement").notNull().default({}),
    linkedBy: uuid("linked_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("tenant_vendors_tenant_vendor_uq").on(t.tenantId, t.vendorId),
    index("tenant_vendors_tenant_idx").on(t.tenantId),
    index("tenant_vendors_vendor_idx").on(t.vendorId),
    index("tenant_vendors_linked_by_idx").on(t.linkedBy),
  ],
);
