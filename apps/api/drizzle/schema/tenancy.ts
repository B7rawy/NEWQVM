import { boolean, jsonb, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";

/**
 * Tenancy core (ADR-0003). A `tenant` = a full workspace (an operator like Qparts) that owns
 * its own isolated world: workshops, vendors links, users, RFQs, orders, portals, subdomain.
 * Isolation is enforced by RLS on `tenant_id` across every transactional table.
 */

/** Subscription plans (super-admin managed). */
export const plans = pgTable("plans", {
  id: pk(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  features: jsonb("features").notNull().default({}),
  isActive: isActive(),
  ...audit,
});

/** The workspace / operator company. `slug` is the subdomain used for routing. */
export const tenants = pgTable(
  "tenants",
  {
    id: pk(),
    name: text("name").notNull(),
    slug: text("slug").notNull(), // subdomain: <slug>.<APP_ROOT_DOMAIN>
    logoUrl: text("logo_url"),
    settings: jsonb("settings").notNull().default({}),
    planId: uuid("plan_id").references(() => plans.id),
    /** Drives side-effect isolation (ADR-0004): sandbox tenants never hit real providers. */
    isSandbox: boolean("is_sandbox").notNull().default(false),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    uniqueIndex("tenants_slug_uq").on(t.slug),
    index("tenants_plan_idx").on(t.planId),
  ],
);
