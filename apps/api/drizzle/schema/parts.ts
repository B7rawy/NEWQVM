import { pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { partSource } from "./enums";
import { partCategories } from "./reference";

/**
 * Master data foundation (QNEW-28/32/33/34). Replaces the static partDictionary.json with real,
 * ID-referenced tables shared by workshop / vendor / purchasing. GLOBAL (no tenant_id) — a shared
 * catalog, same record referenced everywhere; readable by all, writable by platform staff (RLS).
 */

/** Canonical part record. `source` is mandatory provenance (QNEW-32). */
export const partsMaster = pgTable(
  "parts_master",
  {
    id: pk(),
    nameAr: text("name_ar"),
    nameEn: text("name_en"),
    partCategoryId: uuid("part_category_id").references(() => partCategories.id),
    source: partSource("source").notNull(),
    isActive: isActive(),
    ...audit,
  },
  (t) => [index("parts_master_category_idx").on(t.partCategoryId)],
);

/** Alternate names/spellings that resolve to a part (QNEW-32/33 auto-detect). */
export const partSynonyms = pgTable(
  "part_synonyms",
  {
    id: pk(),
    partId: uuid("part_id")
      .notNull()
      .references(() => partsMaster.id),
    synonym: text("synonym").notNull(),
    ...audit,
  },
  (t) => [
    uniqueIndex("part_synonyms_synonym_uq").on(t.synonym),
    index("part_synonyms_part_idx").on(t.partId),
  ],
);

/**
 * Normalizing map from raw dictionary category variants (e.g. "Brakes"→"Brake", "BODY"→"Body")
 * onto the canonical part_categories (QNEW-32 — widening, not narrowing).
 */
export const partCategoryMapping = pgTable(
  "part_category_mapping",
  {
    id: pk(),
    rawVariant: text("raw_variant").notNull(),
    partCategoryId: uuid("part_category_id")
      .notNull()
      .references(() => partCategories.id),
    ...audit,
  },
  (t) => [
    uniqueIndex("part_category_mapping_variant_uq").on(t.rawVariant),
    index("part_category_mapping_category_idx").on(t.partCategoryId),
  ],
);
