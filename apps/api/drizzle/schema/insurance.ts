import { pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pct, pk } from "./_shared";
import { tenants } from "./tenancy";

/**
 * Insurance / payer flow (QNEW-31/42). Tenant-scoped master of insurance companies a workspace
 * deals with, each with a suggested discount % and a quote file-format preference.
 */
export const insuranceCompanies = pgTable(
  "insurance_companies",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    suggestedDiscountPct: pct("suggested_discount_pct").notNull().default("0"),
    fileFormat: text("file_format").notNull().default("separate"), // separate | combined
    contactInfo: text("contact_info"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    uniqueIndex("insurance_companies_tenant_name_uq").on(t.tenantId, t.name),
    index("insurance_companies_tenant_idx").on(t.tenantId),
  ],
);
