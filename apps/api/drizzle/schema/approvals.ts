import { boolean, integer, pgTable, text, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { approvalActionType, approvalLevelMode, approvalStatus } from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";

/**
 * Generic multi-level approval engine (QNEW-53) — attachable to any action by entity_type.
 * Levels name a specific USER (not a role, per QNEW-53). The underlying record stays unchanged and
 * visibly "pending" until all required levels approve; a rejection halts permanently.
 */
export const approvalPolicies = pgTable(
  "approval_policies",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    entityType: text("entity_type").notNull(), // purchase_order | order | cancellation | return | file_upload | report_download
    levelMode: approvalLevelMode("level_mode").notNull().default("sequential"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    index("approval_policies_tenant_idx").on(t.tenantId),
    index("approval_policies_entity_idx").on(t.tenantId, t.entityType),
  ],
);

export const approvalLevels = pgTable(
  "approval_levels",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => approvalPolicies.id),
    levelOrder: integer("level_order").notNull(),
    approverUserId: uuid("approver_user_id")
      .notNull()
      .references(() => users.id),
    isRequired: boolean("is_required").notNull().default(true),
    ...audit,
  },
  (t) => [
    uniqueIndex("approval_levels_uq").on(t.policyId, t.levelOrder),
    index("approval_levels_tenant_idx").on(t.tenantId),
    index("approval_levels_policy_idx").on(t.policyId),
    index("approval_levels_approver_idx").on(t.approverUserId),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => approvalPolicies.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    requestedBy: uuid("requested_by").references(() => users.id),
    currentLevel: integer("current_level").notNull().default(1),
    overallStatus: approvalStatus("overall_status").notNull().default("pending"),
    ...audit,
  },
  (t) => [
    index("approval_requests_tenant_idx").on(t.tenantId),
    index("approval_requests_policy_idx").on(t.policyId),
    index("approval_requests_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("approval_requests_requested_by_idx").on(t.requestedBy),
  ],
);

export const approvalActions = pgTable(
  "approval_actions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    requestId: uuid("request_id")
      .notNull()
      .references(() => approvalRequests.id),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id),
    action: approvalActionType("action").notNull(),
    reassignedToUserId: uuid("reassigned_to_user_id").references(() => users.id),
    comment: text("comment"),
    ...audit,
  },
  (t) => [
    index("approval_actions_tenant_idx").on(t.tenantId),
    index("approval_actions_request_idx").on(t.requestId),
    index("approval_actions_actor_idx").on(t.actorUserId),
    index("approval_actions_reassigned_idx").on(t.reassignedToUserId),
  ],
);
