import { sql } from "drizzle-orm";
import { boolean, jsonb, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { activationStatus, counterpartyType, providerScope, tenantVendorStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * Service providers (QNEW-71 AC11) — the third counterparty family, mirroring vendors/workshops:
 * a GLOBAL entity (no tenant_id), individual|company classification with the same dedup keys, linked
 * to workspaces through `tenant_service_providers`. `scope` distinguishes Qparts' own internal
 * service teams from external partners (delivery, inspection, insurance-claims, …).
 */
export const serviceProviders = pgTable(
  "service_providers",
  {
    id: pk(),
    legalName: text("legal_name").notNull(),
    counterpartyType: counterpartyType("counterparty_type").notNull().default("company"),
    activationStatus: activationStatus("activation_status").notNull().default("active"),
    scope: providerScope("scope").notNull().default("external"),
    serviceType: text("service_type"), // free-text: "Shipping", "Parts inspection", …
    commercialRegistrationNumber: text("commercial_registration_number"),
    taxNumber: text("tax_number"),
    primaryEmail: text("primary_email"),
    primaryPhone: text("primary_phone"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    // same scoped dedup keys as vendors/workshops: company→tax, individual→mobile.
    uniqueIndex("service_providers_company_tax_uq")
      .on(t.taxNumber)
      .where(sql`${t.counterpartyType} = 'company' AND ${t.taxNumber} IS NOT NULL`),
    uniqueIndex("service_providers_individual_mobile_uq")
      .on(t.primaryPhone)
      .where(sql`${t.counterpartyType} = 'individual' AND ${t.primaryPhone} IS NOT NULL`),
  ],
);

/** Service-provider-portal users (linked to the global provider; may serve multiple tenants). */
export const serviceProviderUsers = pgTable(
  "service_provider_users",
  {
    id: pk(),
    serviceProviderId: uuid("service_provider_id")
      .notNull()
      .references(() => serviceProviders.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    isProviderAdmin: boolean("is_provider_admin").notNull().default(false),
    ...audit,
  },
  (t) => [
    uniqueIndex("service_provider_users_sp_user_uq").on(t.serviceProviderId, t.userId),
    index("service_provider_users_user_idx").on(t.userId),
  ],
);

/** Link table: which global provider is active in which workspace (carries tenant_id + RLS). */
export const tenantServiceProviders = pgTable(
  "tenant_service_providers",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    serviceProviderId: uuid("service_provider_id")
      .notNull()
      .references(() => serviceProviders.id),
    status: tenantVendorStatus("status").notNull().default("active"),
    classification: text("classification"),
    agreement: jsonb("agreement").notNull().default({}),
    linkedBy: uuid("linked_by").references(() => users.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("tenant_service_providers_uq").on(t.tenantId, t.serviceProviderId),
    index("tenant_service_providers_tenant_idx").on(t.tenantId),
    index("tenant_service_providers_sp_idx").on(t.serviceProviderId),
  ],
);
