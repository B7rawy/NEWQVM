import { pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, money, pct, pk } from "./_shared";
import { adjustmentType, payerType, priceBasis } from "./enums";
import { tenants } from "./tenancy";
import { insuranceCompanies } from "./insurance";

/**
 * Unified pricing engine (QNEW-30/39/40/41). Tenant-scoped.
 *   - agency_price_reference: saved agency price per part number (multiple per source).
 *   - pricing_basis_settings: per (tenant × payer scenario [× optional insurance company]) — how the
 *     selling price is derived (agency / vendor cost / calculated margin) + a discount/markup.
 */

export const agencyPriceReference = pgTable(
  "agency_price_reference",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    partNumber: text("part_number").notNull(),
    price: money("price").notNull(),
    source: text("source").notNull().default("manual"), // manual | excel_upload | api
    priceUpdatedAt: timestamp("price_updated_at", { withTimezone: true }).notNull().defaultNow(),
    ...audit,
  },
  (t) => [
    uniqueIndex("agency_price_ref_uq").on(t.tenantId, t.partNumber, t.source),
    index("agency_price_ref_tenant_idx").on(t.tenantId),
  ],
);

export const pricingBasisSettings = pgTable(
  "pricing_basis_settings",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    payerScenario: payerType("payer_scenario").notNull(),
    insuranceCompanyId: uuid("insurance_company_id").references(() => insuranceCompanies.id),
    priceBasis: priceBasis("price_basis").notNull().default("calculated_margin"),
    adjustmentType: adjustmentType("adjustment_type").notNull().default("markup"),
    adjustmentPct: pct("adjustment_pct").notNull().default("0"),
    ...audit,
  },
  (t) => [
    uniqueIndex("pricing_basis_uq").on(t.tenantId, t.payerScenario, t.insuranceCompanyId),
    index("pricing_basis_tenant_idx").on(t.tenantId),
    index("pricing_basis_insurance_idx").on(t.insuranceCompanyId),
  ],
);
