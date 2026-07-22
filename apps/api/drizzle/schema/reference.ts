import { integer, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { isActive, money, pk } from "./_shared";
import { returnReasonSide } from "./enums";

/**
 * Reference / lookup tables — the clean replacement for the old generic `lists`/`list_data`.
 * Each concept gets its OWN table (so a car_brand id can never land in item_status), and each
 * row carries bilingual labels (label_ar / label_en) + a stable machine `code`.
 *
 * `legacy_id` = the old list_data_id, kept ONLY to map old→new during migration (Phase 6),
 * nullable and not used at runtime. The status VOCABULARY is preserved exactly as the old
 * system (Kareem's instruction), seeded from drizzle/seed/reference-data.ts.
 *
 * These are GLOBAL (no tenant_id) — shared vocabulary across all workspaces. Writable only by
 * platform staff; readable by all authenticated users (RLS in migrations/_rls.sql).
 */

const refColumns = {
  code: text("code").notNull(), // stable machine key, e.g. "confirmed"
  labelEn: text("label_en").notNull(),
  labelAr: text("label_ar").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: isActive(),
  legacyId: integer("legacy_id"), // old list_data_id — migration mapping only
};

/** item_status — the RFQ/order line lifecycle. Same vocabulary as old list 3. */
export const itemStatuses = pgTable(
  "item_statuses",
  { id: pk(), ...refColumns },
  (t) => [uniqueIndex("item_statuses_code_uq").on(t.code)],
);

/** vendor_status — supplier-side lifecycle. Same vocabulary as old list 15 (Arabic). */
export const vendorStatuses = pgTable(
  "vendor_statuses",
  { id: pk(), ...refColumns },
  (t) => [uniqueIndex("vendor_statuses_code_uq").on(t.code)],
);

/** Car brands (old list 4 — deduplicated, non-brands removed). */
export const carBrands = pgTable("car_brands", { id: pk(), ...refColumns });

/** Brand class: Genuine / OEM / Aftermarket / Used. */
export const brandClasses = pgTable("brand_classes", { id: pk(), ...refColumns });

/** Part categories. */
export const partCategories = pgTable("part_categories", { id: pk(), ...refColumns });

/** Regions (old list 2). */
export const regions = pgTable("regions", { id: pk(), ...refColumns });

/** Cities — replaces the free-text `city` columns; linked to a region. */
export const cities = pgTable(
  "cities",
  {
    id: pk(),
    regionId: uuid("region_id")
      .notNull()
      .references(() => regions.id),
    ...refColumns,
  },
  (t) => [index("cities_region_idx").on(t.regionId)],
);

/** Cancellation reasons (cleaned — no status values mixed in, unlike old list 23). */
export const cancellationReasons = pgTable("cancellation_reasons", { id: pk(), ...refColumns });

/**
 * Return reasons — both sides in one table (old list 23 client + list 13 internal/vendor),
 * discriminated by `side`. The 4 responsibility buckets stay on return_item.responsibility;
 * this holds the specific reason vocabulary (Wrong Part Number, Wrong Pricing, Defective…).
 */
export const returnReasons = pgTable("return_reasons", {
  id: pk(),
  side: returnReasonSide("side").notNull().default("client"),
  ...refColumns,
});

/** Payment accounts. */
export const paymentAccounts = pgTable("payment_accounts", { id: pk(), ...refColumns });

/**
 * Cost ranges for the profit-margin matrix — WITH numeric boundaries so an actual cost maps to a
 * range (old stored this as jsonb text, flagged as a bug). upper_bound NULL = open-ended top range.
 */
export const costRanges = pgTable("cost_ranges", {
  id: pk(),
  code: text("code").notNull(),
  labelEn: text("label_en").notNull(),
  labelAr: text("label_ar").notNull(),
  lowerBound: money("lower_bound").notNull(),
  upperBound: money("upper_bound"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: isActive(),
  legacyId: integer("legacy_id"),
});
