import { boolean, integer, pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { audit, isActive, pk } from "./_shared";
import { approvalActionType, approvalLevelMode, approvalStatus, environmentType } from "./enums";
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
    environment: environmentType("environment").notNull().default("live"),
    policyId: uuid("policy_id")
      .notNull()
      .references(() => approvalPolicies.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    requestedBy: uuid("requested_by").references(() => users.id),
    currentLevel: integer("current_level").notNull().default(1),
    overallStatus: approvalStatus("overall_status").notNull().default("pending"),
    /**
     * ── THE WORKFLOW ENGINE'S HALF OF THIS TABLE, DECLARED HERE BY 0067 ───────────────────────
     *
     * `transition_key` and `consumed_at` came with 0052, `requested_by_name` with 0053 and
     * `flow_id` with 0066, all as hand-written SQL that never came back to this file. Drizzle
     * therefore modelled a four-column-smaller table than the one it manages.
     */
    /** `from>to` — which ARROW the signature is for. Null on a request nothing in a flow raised. */
    transitionKey: text("transition_key"),
    /** Spent when the approved move is performed, so one signature cannot authorise two moves. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** The requester's name AS IT WAS, so the inbox reads correctly after they leave. */
    requestedByName: text("requested_by_name"),
    /**
     * WHICH FLOW ASKED (0066). `transition_key` carries no flow, so once one record can execute two
     * flows, a signature granted for `priced>confirmed` under the standard flow was spendable by an
     * identically-named arrow under insurance. This column, folded into the two indexes below with
     * NULLS NOT DISTINCT, is what keeps them apart; null is the only correct reading of a pre-0066
     * row and matches on purpose.
     */
    flowId: uuid("flow_id"),
    ...audit,
  },
  (t) => [
    index("approval_requests_tenant_idx").on(t.tenantId),
    index("approval_requests_policy_idx").on(t.policyId),
    index("approval_requests_entity_idx").on(t.tenantId, t.entityType, t.entityId),
    index("approval_requests_requested_by_idx").on(t.requestedBy),
    // one OPEN request per entity (0037) — the service checks-then-inserts; 23505 → 409
    uniqueIndex("approval_requests_pending_uq").on(t.tenantId, t.entityType, t.entityId).where(sql`overall_status = 'pending'`),
    index("approval_requests_pending_idx")
      .on(t.tenantId, t.environment, t.overallStatus)
      .where(sql`overall_status = 'pending'`),
    // the lookup that answers "is this move already signed off" on every guarded transition
    index("approval_requests_granted_idx")
      .on(t.tenantId, t.environment, t.entityId, t.flowId, t.transitionKey)
      .where(sql`overall_status = 'approved' and consumed_at is null`),
    // NOT DECLARED HERE: approval_requests_open_uq, the partial unique that keeps one open request
    // per (entity, flow, arrow). It is `NULLS NOT DISTINCT`, and drizzle-orm 0.36 offers that only
    // on a unique CONSTRAINT, never on a partial unique INDEX — the same limitation that made 0026
    // hand-written SQL. Declaring it without the clause would be worse than leaving it out: the .ts
    // would then describe an index that treats two pre-0066 rows (flow_id null) as distinct, which
    // is the collision the index exists to prevent. It lives in 0052/0066 and stays there.

  ],
);

export const approvalActions = pgTable(
  "approval_actions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
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
