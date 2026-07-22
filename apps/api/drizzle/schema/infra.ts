import { date, integer, jsonb, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, pk } from "./_shared";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * Cross-cutting infra (QNEW-47). Prerequisites for the Approval Engine and Vendor Financing SLAs.
 */

/** Generic audit log — a single home for who-changed-what (beyond per-domain status/price logs). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    ...audit,
  },
  (t) => [
    index("audit_log_tenant_idx").on(t.tenantId),
    index("audit_log_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("audit_log_actor_idx").on(t.actorUserId),
  ],
);

/** Working-days / hours config per workspace (KSA default Sun–Thu). Drives SLA countdowns. */
export const businessCalendarSettings = pgTable(
  "business_calendar_settings",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // JS weekday numbers that are working days (0=Sun … 6=Sat). KSA default = Sun–Thu.
    workingDays: jsonb("working_days").notNull().default([0, 1, 2, 3, 4]),
    dayStartMinute: integer("day_start_minute").notNull().default(8 * 60),
    dayEndMinute: integer("day_end_minute").notNull().default(17 * 60),
    timezone: text("timezone").notNull().default("Asia/Riyadh"),
    ...audit,
  },
  (t) => [uniqueIndex("business_calendar_tenant_uq").on(t.tenantId)],
);

export const businessHolidays = pgTable(
  "business_holidays",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    holidayDate: date("holiday_date").notNull(),
    name: text("name"),
    ...audit,
  },
  (t) => [
    uniqueIndex("business_holidays_uq").on(t.tenantId, t.holidayDate),
    index("business_holidays_tenant_idx").on(t.tenantId),
  ],
);
