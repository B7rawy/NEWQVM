import { jsonb, pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { pk } from "./_shared";
import { users } from "./identity";
import { tenants } from "./tenancy";

/**
 * Platform-level audit trail for cross-workspace admin actions (impersonation, membership/vendor
 * status changes, workspace edits). Distinct from the tenant-scoped `audit_log` because these span
 * workspaces. `tenant_id` is nullable (impersonation isn't tied to one). Carries a nullable
 * tenant_id so the 0001 RLS loop applies tenant_isolation → internal-only visibility.
 */
export const platformAudit = pgTable(
  "platform_audit",
  {
    id: pk(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    impersonatorId: uuid("impersonator_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("platform_audit_actor_idx").on(t.actorUserId),
    index("platform_audit_action_idx").on(t.action),
    index("platform_audit_tenant_idx").on(t.tenantId),
  ],
);
