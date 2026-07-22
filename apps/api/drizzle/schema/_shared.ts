import { sql } from "drizzle-orm";
import { boolean, numeric, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Shared column builders. Every table composes these to stay consistent and to fix
 * old-system issues by construction (CONVENTIONS §DB):
 *  - money is ALWAYS numeric(14,2)   (old: mixed float8/float4/text)
 *  - timestamps are ALWAYS timestamptz in UTC  (old: mixed + Asia/Riyadh defaults)
 *  - PKs are uuid  (old: bigint identity, enumerable)
 *
 * NOTE on uuid version: DB default is gen_random_uuid() (v4) so raw inserts work on PG16.
 * The app layer overrides with uuid v7 (sortable) via Drizzle $defaultFn in the db client —
 * see ADR note in docs/design/new-schema-design.md §8.
 */

/** Primary key: uuid, DB-defaulted (app layer supplies v7). */
export const pk = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);

/** created_at / updated_at (UTC). updated_at is bumped by the shared trigger, not the app. */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** created_by / updated_by. Written server-side by the audit trigger from the session, never the request body. */
export const authorship = {
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
};

/** Standard audit block = timestamps + authorship. */
export const audit = { ...timestamps, ...authorship };

/** Money column helper — numeric(14,2). */
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/** Percentage column helper — numeric(5,2) (e.g. 12.50). */
export const pct = (name: string) => numeric(name, { precision: 5, scale: 2 });

/** is_active flag defaulting to true. */
export const isActive = () => boolean("is_active").notNull().default(true);
