import {
  boolean,
  doublePrecision,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  uuid,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { audit, pk } from "./_shared";
import { entityType, environmentType, statusDomain, workflowFlowStatus } from "./enums";
import { itemStatuses, vendorStatuses } from "./reference";
import { tenants } from "./tenancy";

/**
 * WORKFLOW ENGINE STORAGE (Jira epic QNEW-64).
 *
 * One shape, read by three consumers — which is why it is worth getting right before it is applied:
 *   1. the CANVAS renders and edits it (hence canvas_x / canvas_y on each step),
 *   2. the GUARD enforces it (a status move must match a workflow_transitions row),
 *   3. the AI ASSISTANT emits it (the model returns this object; a human reviews it on the canvas
 *      and saves; the model never writes SQL).
 * A flow drawn by hand, completed by the AI, then hand-edited again is the same object throughout —
 * that is what makes "build it myself / let the AI do it / do half each" one feature, not three.
 *
 * SCOPING (owner's decision, 2026-07-25): flows belong to the WORKSPACE (`tenant_id`), never to an
 * individual workshop — everything under a workspace follows that workspace's rules. Tenant RLS
 * therefore isolates one workspace's flows from another's for free.
 *
 * VERSIONING: a flow is edited freely while `status = 'draft'`. Activating it freezes it (enforced
 * by triggers in the migration, not by convention); editing an active flow produces a NEW version.
 * Records bind to the exact flow row they entered (workflowRecordState), so changing a flow can
 * never strand an order mid-flight at a step the new version deleted.
 *
 * NOTE — two deliberate first-in-repo deviations, both introduced here on purpose:
 *   • COMPOSITE foreign keys (`foreignKey({ columns, foreignColumns })`). Single-column FKs would let
 *     a step or an arrow belong to a different flow / tenant / environment / domain than the row it
 *     claims — RI triggers bypass RLS, and the only actor managing flows is internal, so the tenant
 *     policy constrains nothing on this path. The composite keys pin the whole scope.
 *   • Table CHECK constraints (in the migration). Every `check (` in migrations today is an RLS
 *     `with check` clause; these are real table checks.
 */

/** A named set of steps + transitions. `flowKey` is stable across versions; `version` increments. */
export const workflowFlows = pgTable(
  "workflow_flows",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // ADR-0012: a flow is built and tested in Sandbox, then activated in Live.
    environment: environmentType("environment").notNull().default("live"),
    flowKey: text("flow_key").notNull(),
    version: integer("version").notNull().default(1),
    nameEn: text("name_en").notNull(),
    nameAr: text("name_ar").notNull(),
    status: workflowFlowStatus("status").notNull().default("draft"),
    /** The fallback when no selection condition matches. One ACTIVE default per tenant+env+domain. */
    isDefault: boolean("is_default").notNull().default(false),
    /** Which vocabulary this flow's steps speak — item lifecycle or vendor-side lifecycle. */
    statusDomain: statusDomain("status_domain").notNull().default("item"),
    /**
     * Condition deciding whether a NEW record enters this flow (order type, payer_type, branch…),
     * in the same shape the transitions use so the builder has one editor for both.
     *
     * THREE STATES, and the difference matters:
     *   NULL → never auto-selected (routing not decided yet). This is the default.
     *   {}   → matches EVERY record, same as a transition's `{}` meaning unconditional.
     *   {…}  → matches records satisfying it.
     * Without the NULL state a half-finished flow is born matching everything and quietly captures
     * every new record ahead of the intended flow.
     */
    selectionCondition: jsonb("selection_condition"),
    /**
     * Which flow wins when TWO conditions both match the record entering (0065).
     *
     * Highest first, then oldest — the same rule `workflow_transitions` uses for two arrows joining
     * the same pair of steps, deliberately reused rather than invented again one level up. Ignored
     * on the `is_default` flow: that one is the fallback, not a candidate, so it can never outrank
     * the specific flow an admin drew for insurance work.
     */
    selectionPriority: integer("selection_priority").notNull().default(0),
    /**
     * How records get INTO this flow at all (0066).
     *
     *   'selected' → a record entering the domain is matched against selectionCondition, or lands
     *                here because this is the default. Every flow before 0066 is this.
     *   'handoff'  → records only ever arrive by crossing a transition whose `toFlowKey` names this
     *                flow. Nothing selects it, so it needs no selection condition.
     *
     * It exists to stop a lie being stored. A sub-flow must be active and non-default (only one
     * active default per domain), and `workflow_flows_selection_complete` then demands a non-null
     * selectionCondition from exactly that shape of flow. The cheap way to satisfy it is `{}` — which
     * this file defines two comments above as "matches EVERY record". That would be a flow declaring
     * it accepts every new record, waiting for the day selection is evaluated to capture them.
     */
    entryMode: text("entry_mode").notNull().default("selected"),
    /** Canvas-wide metadata (zoom/pan). Layout belonging to a STEP lives on the step. */
    canvas: jsonb("canvas").notNull().default({}),
    ...audit,
  },
  (t) => [
    unique("workflow_flows_key_version_uq").on(t.tenantId, t.environment, t.flowKey, t.version),
    // Only ONE version of a flowKey may be active: activation is two writes (retire v1, activate v2)
    // and a crash between them would otherwise leave routing to pick nondeterministically.
    uniqueIndex("workflow_flows_active_uq")
      .on(t.tenantId, t.environment, t.flowKey)
      .where(sql`status = 'active'`),
    // `status = 'active'` is load-bearing: without it a DRAFT v2 of the default collides with the
    // live v1 and the whole versioning path becomes impossible.
    uniqueIndex("workflow_flows_default_uq")
      .on(t.tenantId, t.environment, t.statusDomain)
      .where(sql`is_default and status = 'active'`),
    // referenced by the composite FKs below — a unique on (id, …scope) is what lets a child pin it
    unique("workflow_flows_id_scope_uq").on(t.id, t.tenantId, t.environment),
    unique("workflow_flows_id_scope_domain_uq").on(t.id, t.tenantId, t.environment, t.statusDomain),
    index("workflow_flows_tenant_idx").on(t.tenantId, t.environment),
    index("workflow_flows_status_idx").on(t.tenantId, t.environment, t.status),
  ],
);

/**
 * A step = one status placed in one flow, with its position on the canvas.
 * The status stays in the governed catalog — a flow ARRANGES statuses, it does not own them, so two
 * flows may use the same status differently.
 */
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    flowId: uuid("flow_id").notNull(),
    /**
     * Split by vocabulary so BOTH get a real FK. A single soft `status_id` would accept a
     * wrong-catalog or deleted id indistinguishably, and the guard would then stall every record at
     * the step before it — after activation freezes the flow, repair means a new version.
     * Exactly one of the two is set; the CHECK in the migration ties it to status_domain.
     */
    statusDomain: statusDomain("status_domain").notNull(),
    itemStatusId: uuid("item_status_id").references(() => itemStatuses.id),
    vendorStatusId: uuid("vendor_status_id").references(() => vendorStatuses.id),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Where a new record starts. Exactly one per flow (partial unique below). */
    isEntry: boolean("is_entry").notNull().default(false),
    /** No outgoing transition — the record is finished here. */
    isTerminal: boolean("is_terminal").notNull().default(false),
    /** Target time at this step; drives "late" reporting now that status_logs records history. */
    slaHours: integer("sla_hours"),
    /**
     * GOVERNANCE (0048). Both default to `[]`, and empty means "no opinion" — a workspace that
     * configures neither behaves exactly as it did before these columns existed.
     *
     * They are classified DIFFERENTLY against the freeze trigger, and that distinction is the rule
     * for every column added here in future: SEMANTICS ARE FROZEN, VIEW IS TUNABLE.
     *   pages      — which screens a record here surfaces on. TUNABLE on an active flow, because a
     *                mis-routed status hides live work and must be fixable without republishing.
     *   ownerRoles — which roles are responsible while a record sits here. FROZEN, because it
     *                governs who may act and in-flight records are bound to this version.
     */
    pages: jsonb("pages").notNull().default(sql`'[]'::jsonb`),
    ownerRoles: jsonb("owner_roles").notNull().default(sql`'[]'::jsonb`),
    // doublePrecision, NOT numeric: drizzle returns numeric as a STRING, so the first drag would do
    // "120.00" + 5 = "120.005" and the node would teleport — and that value would be saved.
    canvasX: doublePrecision("canvas_x").notNull().default(0),
    canvasY: doublePrecision("canvas_y").notNull().default(0),
    ...audit,
  },
  (t) => [
    foreignKey({
      columns: [t.flowId, t.tenantId, t.environment, t.statusDomain],
      foreignColumns: [
        workflowFlows.id,
        workflowFlows.tenantId,
        workflowFlows.environment,
        workflowFlows.statusDomain,
      ],
      name: "workflow_steps_flow_scope_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    // referenced by the transition edge FKs, so an arrow can never join two different flows
    unique("workflow_steps_id_flow_uq").on(t.id, t.flowId),
    uniqueIndex("workflow_steps_flow_item_status_uq")
      .on(t.flowId, t.itemStatusId)
      .where(sql`item_status_id is not null`),
    uniqueIndex("workflow_steps_flow_vendor_status_uq")
      .on(t.flowId, t.vendorStatusId)
      .where(sql`vendor_status_id is not null`),
    // exactly one entry: zero wedges every new record, two makes the start nondeterministic
    uniqueIndex("workflow_steps_entry_uq").on(t.flowId).where(sql`is_entry`),
    index("workflow_steps_flow_idx").on(t.flowId),
    index("workflow_steps_tenant_idx").on(t.tenantId, t.environment),
  ],
);

/** A permitted move between two steps — the arrow on the canvas, and the rule the guard enforces. */
export const workflowTransitions = pgTable(
  "workflow_transitions",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    flowId: uuid("flow_id").notNull(),
    fromStepId: uuid("from_step_id").notNull(),
    toStepId: uuid("to_step_id").notNull(),
    labelEn: text("label_en"),
    labelAr: text("label_ar"),
    /** Gate this move behind the approvals engine (QNEW-53) instead of performing it immediately. */
    requiresApproval: boolean("requires_approval").notNull().default(false),
    /** Empty array = anyone the endpoint's own guard allows. Non-empty = these roles only. */
    allowedRoles: jsonb("allowed_roles").notNull().default([]),
    /** The IF part: field / operator / reference, AND-OR composed. `{}` = unconditional. */
    condition: jsonb("condition").notNull().default({}),
    /**
     * Several rules may share one arrow: "Confirmed → Purchased goes straight through under 5,000,
     * needs the finance manager above it" is two rows on the same pair. Candidates for
     * (flow_id, from_step_id) are evaluated in priority order and the FIRST matching condition wins.
     */
    priority: integer("priority").notNull().default(0),
    /**
     * THE CROSSING (0066). Taking this arrow also hands the record to the ACTIVE version of the flow
     * named here, landing on that flow's step for the destination status. Null — almost always —
     * means an ordinary move inside this flow.
     *
     * A KEY, NOT AN ID, so the target flow can republish on its own schedule without every flow that
     * crosses into it needing a new version. An id would pin the border to one version and aim it at
     * a retired graph the day the target published v2.
     *
     * Frozen by workflow_child_freeze() on a non-draft flow: it decides which RULEBOOK governs the
     * record after the move, so re-aiming a live border would redirect orders already crossing it
     * with no version change and nothing in the audit trail.
     */
    toFlowKey: text("to_flow_key"),
    ...audit,
  },
  (t) => [
    foreignKey({
      columns: [t.flowId, t.tenantId, t.environment],
      foreignColumns: [workflowFlows.id, workflowFlows.tenantId, workflowFlows.environment],
      name: "workflow_transitions_flow_scope_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      columns: [t.fromStepId, t.flowId],
      foreignColumns: [workflowSteps.id, workflowSteps.flowId],
      name: "workflow_transitions_from_step_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      columns: [t.toStepId, t.flowId],
      foreignColumns: [workflowSteps.id, workflowSteps.flowId],
      name: "workflow_transitions_to_step_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    unique("workflow_transitions_edge_uq").on(t.flowId, t.fromStepId, t.toStepId, t.priority),
    index("workflow_transitions_eval_idx").on(t.flowId, t.fromStepId, t.priority),
    // these are the repo's only cascading FKs; without a covering index each step delete is a seq scan
    index("workflow_transitions_from_step_idx").on(t.fromStepId),
    index("workflow_transitions_to_step_idx").on(t.toStepId),
    index("workflow_transitions_tenant_idx").on(t.tenantId, t.environment),
  ],
);

/**
 * Which flow VERSION a given record is executing. Polymorphic, matching the codebase convention
 * (status_logs / attachments / notes all key on entity_type + entity_id).
 *
 * This is what makes flow editing safe: an order that entered v1 keeps executing v1 after v2 is
 * activated, so a step deleted in v2 cannot strand it.
 */
export const workflowRecordState = pgTable(
  "workflow_record_state",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    environment: environmentType("environment").notNull().default("live"),
    entityType: entityType("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    /** NO DEFAULT on purpose: defaulting to 'item' would silently mis-bind rfq_vendor, the one
     *  vendor-domain entity, to a flow speaking the wrong vocabulary — and then nothing resolves. */
    statusDomain: statusDomain("status_domain").notNull(),
    flowId: uuid("flow_id").notNull(),
    /**
     * Where the record came from while it is AWAY in a sub-flow (0066) — written on the outbound
     * crossing, cleared on the return.
     *
     * A HINT, NOT A POINTER, and that word is the whole safety argument. On the way home the resolver
     * PREFERS this version when it is non-draft and still contains the landing status, and otherwise
     * falls back to the active version of the flow the return arrow names. So a null, stale or
     * unusable value costs the record nothing: the crossing still completes against the live graph.
     * A return address that MUST resolve is precisely the thing that strands a record on the day it
     * cannot, which is why this one is never required.
     */
    originFlowId: uuid("origin_flow_id"),
    // `audit`, not `timestamps`: apply_tenant_rls attaches trg_set_row_audit unconditionally, and
    // set_row_audit() writes created_by/updated_by — without those columns the FIRST insert dies
    // with "record new has no field created_by".
    ...audit,
  },
  (t) => [
    // NO onDelete: an in-flight record must BLOCK deletion of the flow version it is executing.
    foreignKey({
      columns: [t.flowId, t.tenantId, t.environment, t.statusDomain],
      foreignColumns: [
        workflowFlows.id,
        workflowFlows.tenantId,
        workflowFlows.environment,
        workflowFlows.statusDomain,
      ],
      name: "workflow_record_state_flow_scope_fk",
    }).onUpdate("cascade"),
    // Mirrors the FK above for the flow the record is AWAY from. MATCH SIMPLE, so it is simply
    // unchecked while origin_flow_id is null — which is the wanted behaviour (a record that is not
    // away has no origin) and the same trick the flow FK relies on.
    foreignKey({
      columns: [t.originFlowId, t.tenantId, t.environment, t.statusDomain],
      foreignColumns: [
        workflowFlows.id,
        workflowFlows.tenantId,
        workflowFlows.environment,
        workflowFlows.statusDomain,
      ],
      name: "workflow_record_state_origin_flow_fk",
    }).onUpdate("cascade"),
    unique("workflow_record_state_entity_uq").on(t.tenantId, t.environment, t.entityType, t.entityId),
    index("workflow_record_state_flow_idx").on(t.flowId),
    // "which records are currently away in a sub-flow" is a small set inside a table holding every
    // live record, so the index is partial.
    index("workflow_record_state_away_idx")
      .on(t.tenantId, t.environment)
      .where(sql`origin_flow_id is not null`),
  ],
);
