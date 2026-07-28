import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";
import { envOf, type Environment } from "./env-guards.js";
import { runGates, type GateConfig, type GateFailure } from "../modules/workflow/gates.js";
import { runActions, type ActionConfig } from "../modules/workflow/actions.js";
import { NotificationsService } from "../modules/notifications/notifications.service.js";
import {
  evaluate, describe, gatherFacts, isEmptyCondition, type Condition,
} from "../modules/workflow/conditions.js";

/**
 * THE SINGLE STATUS-WRITE ENTRY POINT (QNEW-64 §7.6.1 / QNEW-75).
 *
 * Before this, 22 sites across 8 services wrote a status column directly. Nothing recorded WHO moved
 * a record, WHEN, or FROM WHAT — `status_logs` was fully designed and had zero writers and zero rows.
 * That single gap is why stage-speed reporting, early-vs-late cancellation classification, and
 * "reject a cancellation and restore the previous status" all had no data source.
 *
 * Every status change goes through transition(). It resolves the current value, refuses a no-op,
 * writes the column, and appends to status_logs with the actor taken from the CONTEXT (never from a
 * caller-supplied id — that is the spoofable-audit-identity defect the old system has).
 *
 * It is also where the GUARD lives (see assertTransitionAllowed): because all 22 former write sites
 * were collapsed into this one function first, the workflow check exists in ONE place rather than 22.
 * That ordering was the point — a rule engine bolted onto one of twenty paths enforces nothing.
 */

/** The tables this gateway may write, and which status vocabulary each one speaks. */
const ENTITIES = {
  rfq: { table: "rfqs", domain: "item" },
  rfq_item: { table: "rfq_items", domain: "item" },
  rfq_vendor: { table: "rfq_vendors", domain: "vendor" },
  order: { table: "orders", domain: "item" },
  order_item: { table: "order_items", domain: "item" },
  purchase_order: { table: "purchase_orders", domain: "item" },
  delivery: { table: "deliveries", domain: "item" },
  return: { table: "returns", domain: "item" },
  invoice: { table: "invoices", domain: "item" },
  credit_note: { table: "credit_notes", domain: "item" },
} as const;

export type StatusEntity = keyof typeof ENTITIES;

export interface StatusContext {
  tenantId: string | null;
  userId: string | null;
  environment?: Environment;
  /**
   * Set only by the exception machinery itself when it executes or reverses its own decision.
   * Everything else must be held by the freeze — otherwise resolving a cancellation would be
   * blocked by the very cancellation being resolved.
   */
  resolvingException?: boolean;
  /**
   * A written justification for bypassing a `warn_override` gate. Supplied by the caller who chose
   * to override, recorded against the move it permitted. A `block` gate ignores it entirely — the
   * point of block is that no reason is good enough.
   */
  overrideReason?: string | null;
  /**
   * How many automatic moves deep we already are. THE LOOP GUARD.
   *
   * An automatic move can satisfy the conditions of another, which can satisfy the first — and this
   * engine has a specific closed cycle available to it, because the final approval performs the move
   * (0052). A hard depth cap is cruder than cycle detection and strictly better behaved: it stops in
   * bounded time whatever shape the flow is.
   *
   * It is ALSO what makes a system actor's own write unable to restart the rules — see reevaluate().
   */
  autoDepth?: number;
}

/** Beyond this an automatic chain stops, rather than running an order to the end of the flow. */
const MAX_AUTO_DEPTH = 3;

/**
 * Raised when a move needs a signature it does not have yet.
 *
 * Carries the request id so the caller can link straight to it — being told "needs approval" without
 * being told WHICH request is the difference between a workflow and a wall.
 */
export class ApprovalRequiredException extends ConflictException {
  constructor(transitionKey: string, requestId: string | null, reason: string) {
    super({ message: reason, needsApproval: true, transitionKey, requestId });
  }
}

/** Raised when the business rules on a transition are not satisfied. 409, not 400: the request is
 *  well-formed, the world is not ready for it. */
export class GateNotSatisfiedException extends ConflictException {
  constructor(public readonly failures: GateFailure[]) {
    super({
      message: failures.map((f) => f.detail).join("; "),
      gates: failures.map((f) => ({
        gate: f.gate, label: f.label, detail: f.detail,
        offending: f.offending, enforcement: f.enforcement,
      })),
      // the UI renders this on the disabled button, so it must be enough to act on without a lookup
      canOverride: failures.every((f) => f.enforcement === "warn_override"),
    });
  }
}

@Injectable()
export class StatusService {
  /**
   * The ONLY dependency, and it is here so that the `notify` action can exist without reaching past
   * the single side-effect boundary. Nothing on the guard/gate/log path touches it — a status move
   * that configures no notify action never calls it at all.
   */
  constructor(private readonly notifications: NotificationsService) {}

  /**
   * The roles this actor genuinely holds in this workspace.
   *
   * Resolved from the database on every check rather than read off the request context, for the
   * same reason changed_by is: a caller-supplied role is a caller-controlled role. The AuthGuard
   * picks ONE role for the request (a `limit 1` with no ordering), which is fine for coarse route
   * guards but wrong here — a user who is both a branch_manager and an account_manager must satisfy
   * a rule naming either, and which one the guard happened to pick must not decide it.
   *
   * A platform super_admin holds every role by construction: they are the break-glass path, and a
   * workspace that has locked itself out of its own orders needs one.
   */
  private async effectiveRoles(tx: Tx, ctx: StatusContext): Promise<Set<string>> {
    if (!ctx.userId) return new Set();
    const rows = (await tx.execute(sql`
      select role::text as code from tenant_memberships
        where user_id = ${ctx.userId}::uuid and tenant_id = ${ctx.tenantId}::uuid and is_active
      union
      select role::text from platform_members
        where user_id = ${ctx.userId}::uuid and is_active`)) as Array<{ code: string }>;
    return new Set(rows.map((r) => r.code));
  }

  /** Resolve a status code to its id in the right vocabulary. Codes, never integers — the legacy
   *  numeric ids exist only for the eventual old→new migration mapping. */
  private async resolveStatusId(tx: Tx, domain: "item" | "vendor", code: string): Promise<string> {
    const table = domain === "vendor" ? "vendor_statuses" : "item_statuses";
    const row = (await tx.execute(
      sql`select id from ${sql.raw(table)} where code = ${code} limit 1`,
    ))[0] as { id: string } | undefined;
    // a typo'd code must fail loudly, not silently leave the record where it was
    if (!row) throw new BadRequestException(`unknown ${domain} status '${code}'`);
    return row.id;
  }

  /**
   * Move ONE record to `toCode` and log it.
   *
   * @returns `changed:false` when the record is already there — a self-transition is a no-op and
   *          writes NO log row, so history stays a record of real movement (QNEW-75 AC2).
   */
  async transition(
    tx: Tx,
    ctx: StatusContext,
    input: { entity: StatusEntity; id: string; toCode: string },
  ): Promise<{ changed: boolean; fromStatusId: string | null; toStatusId: string }> {
    const [res] = await this.transitionMany(tx, ctx, { ...input, ids: [input.id] });
    return res;
  }

  /**
   * Move SEVERAL records of the same entity to the same status in one pass — the shape the callers
   * actually need (confirm all winning items, deliver all lines of a delivery…). One resolve, one
   * UPDATE, one log row per record that genuinely moved.
   */
  async transitionMany(
    tx: Tx,
    ctx: StatusContext,
    input: { entity: StatusEntity; ids: string[]; toCode: string },
  ): Promise<Array<{ changed: boolean; fromStatusId: string | null; toStatusId: string }>> {
    return this.write(tx, ctx, input, false);
  }

  /**
   * A record ENTERS the flow — QNEW-90 item 7, the `created` trigger, adopted minimally.
   *
   * Until this existed, creating an RFQ or confirming an order wrote status_id straight onto the new
   * row. The consequence was not cosmetic: a record's FIRST status was the one status it ever held
   * that produced no status_logs row (so time-in-first-status could not be measured and the history
   * of every record began mid-life), and nothing bound it to the flow version it was born under, so
   * "a record executes the flow that was live when it entered" was true of every status except the
   * one it entered at.
   *
   * ENTRY IS NOT REFUSABLE, AND THAT IS THE WHOLE DESIGN CONSTRAINT. A workspace with a half-drawn
   * flow must still be able to raise an RFQ. So this deliberately runs NONE of the machinery that
   * can say no — no arrow lookup, no roles, no gates, no approval — because there is no arrow: the
   * record is arriving from outside the flow, not moving along it. What it does instead is bind the
   * record to the flow version live right now, which is the fact that was missing. Everything the
   * flow has to say about the record starts applying on its first real MOVE, exactly as before.
   *
   * Callers insert the row with status_id NULL and then call this, inside the same transaction. A
   * NULL status is never observable outside it, and doing it in this order is what lets the entry be
   * a genuine from-nothing→somewhere event rather than a self-transition the gateway would discard.
   *
   * THAT IS THE ONLY THING IT IS FOR. Because it asks the workflow nothing, calling it on a record
   * that already has a status would move that record past every rule the flow has — use
   * transitionMany, which is what the rest of the system does.
   */
  async enterMany(
    tx: Tx,
    ctx: StatusContext,
    input: { entity: StatusEntity; ids: string[]; toCode: string },
  ): Promise<Array<{ changed: boolean; fromStatusId: string | null; toStatusId: string }>> {
    return this.write(tx, ctx, input, true);
  }

  /** One record entering the flow. See enterMany. */
  async enter(
    tx: Tx,
    ctx: StatusContext,
    input: { entity: StatusEntity; id: string; toCode: string },
  ): Promise<{ changed: boolean; fromStatusId: string | null; toStatusId: string }> {
    const [res] = await this.enterMany(tx, ctx, { ...input, ids: [input.id] });
    return res;
  }

  /**
   * The shared body of transitionMany and enterMany. `entry` decides which question is being asked
   * of the workflow — "may this record take this arrow" or "which flow is this record joining" —
   * and nothing else differs, so the write, the log and the auto-advance cannot drift apart between
   * the two. A second function that also writes status_id is the one thing this file exists to
   * prevent.
   */
  private async write(
    tx: Tx,
    ctx: StatusContext,
    input: { entity: StatusEntity; ids: string[]; toCode: string },
    entry: boolean,
  ): Promise<Array<{ changed: boolean; fromStatusId: string | null; toStatusId: string }>> {
    const spec = ENTITIES[input.entity];
    if (!spec) throw new BadRequestException(`status changes are not supported for '${input.entity}'`);
    if (input.ids.length === 0) return [];

    const toStatusId = await this.resolveStatusId(tx, spec.domain, input.toCode);
    const ids = sql.join(
      input.ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    );

    // read BEFORE the write so the log's from_status_id is the real prior value — and lock, because
    // two stations may now hold the same record: see the note on concurrent stations below.
    const before = (await tx.execute(
      sql`select id, status_id from ${sql.raw(spec.table)} where id in (${ids}) order by id for update`,
    )) as Array<{ id: string; status_id: string | null }>;
    const found = new Set(before.map((b) => b.id));
    const missing = input.ids.filter((i) => !found.has(i));
    // RLS already scopes this table, so "not found" means another tenant/environment or a bad id —
    // either way, refuse rather than silently move a subset.
    if (missing.length > 0)
      throw new BadRequestException(`${input.entity} not found in this workspace: ${missing.join(", ")}`);

    // The freeze comes before everything, including the "no active flow means permissive" rule:
    // it is not one of the workflow's rules, it is a statement that this record must not be moving
    // at all right now. A workspace with no flow configured still must not ship an order somebody
    // has asked to cancel.
    for (const b of before) {
      const frozenBy = await this.frozenByException(tx, ctx, input.entity, b.id);
      if (frozenBy)
        throw new ConflictException({
          message:
            // Was an if/else that said "a return" for anything that was not a cancellation, so a
            // hold reported itself as a return being reviewed — two wrong facts in one sentence.
            frozenBy.kind === "cancellation"
              ? "a cancellation is being reviewed for this order, so it cannot move until that is decided"
              : frozenBy.kind === "return"
              ? "a return is being reviewed for this line, so it cannot move until that is decided"
              : "the workflow put this on hold, so it cannot move until somebody releases it",
          frozenBy: frozenBy.kind,
          reason: frozenBy.reason,
        });
    }

    const moving = before.filter((b) => b.status_id !== toStatusId);

    // ── the guard: is this move one the workspace's workflow actually permits? ──
    /** Gates that were waived on this move, so the log can say what was let through and why. */
    const overridden: GateFailure[] = [];
    /**
     * Which flow each record's move was JUDGED under, so the log row can say so — 0066.
     *
     * It has to be carried out of the guard rather than read back here, because since a record can
     * cross into another flow the answer is decided DURING the guard and is not recoverable
     * afterwards: by the time anyone reads the history the record may be home again, and
     * workflow_record_state would answer 'standard' for a move judged under 'insurance'. Empty for
     * a record no flow governs, which stays null in the log and means what it always meant.
     */
    let judgedUnder = new Map<string, string>();
    if (entry) {
      // Nothing is waived on an entry because nothing was asked: see enterMany.
      judgedUnder = await this.bindOnEntry(tx, ctx, spec, input.entity, moving, toStatusId);
    } else {
      const guard = await this.assertTransitionAllowed(
        tx, ctx, spec, input.entity, moving, toStatusId, input.toCode,
      );
      overridden.push(...guard.waived);
      judgedUnder = guard.flowByRecord;
    }

    if (moving.length > 0) {
      const movingIds = sql.join(
        moving.map((m) => sql`${m.id}::uuid`),
        sql`, `,
      );
      await tx.execute(
        sql`update ${sql.raw(spec.table)} set status_id = ${toStatusId}::uuid, updated_at = now() where id in (${movingIds})`,
      );
      for (const m of moving) {
        await tx.execute(sql`
          insert into status_logs (tenant_id, environment, entity_type, entity_id, status_domain,
                                   from_status_id, to_status_id, changed_by,
                                   override_reason, overridden_gates, auto_advanced, flow_id)
          values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${input.entity}, ${m.id}::uuid, ${spec.domain},
                  ${m.status_id}::uuid, ${toStatusId}::uuid,
                  ${(ctx.autoDepth ?? 0) > 0 ? null : ctx.userId}::uuid,
                  ${overridden.length ? (ctx.overrideReason ?? null) : null},
                  ${overridden.length ? JSON.stringify(overridden.map((f) => f.gate)) : null}::jsonb,
                  ${(ctx.autoDepth ?? 0) > 0},
                  -- The flow this particular move was judged under. On a crossing that is the flow
                  -- the record LANDED in, which is the one whose arrow was taken and whose step it
                  -- now stands on. Null when no flow governs the record.
                  ${judgedUnder.get(m.id) ?? null}::uuid)`);
      }
    }

    // ── did that unlock a move the flow says should happen on its own? ────────────────────────
    // Runs AFTER the write, inside the same transaction, so an automatic move that turns out to be
    // impossible rolls back the move that triggered it rather than leaving the record half-advanced.
    if (moving.length) await this.autoAdvance(tx, ctx, input.entity, moving.map((m) => m.id));

    return before.map((b) => ({
      changed: b.status_id !== toStatusId,
      fromStatusId: b.status_id,
      toStatusId,
    }));
  }


  /**
   * THE GUARD (QNEW-75). A status may only move along an arrow the workspace drew.
   *
   * Deliberately PERMISSIVE UNTIL CONFIGURED. Every record that exists today predates the engine and
   * is bound to no flow, and there is no active flow until an admin activates one — so if either is
   * missing this returns silently and the system behaves exactly as it did before. Enforcement
   * switches on for a workspace the moment it activates a flow, and only for records that entered
   * under it. Rolling this out any other way would freeze live orders the day it shipped.
   *
   * A record is BOUND to the flow version live at the time it first moves, and stays on it — so
   * publishing a new version can never strand an order mid-flight.
   *
   * CONCURRENT STATIONS: the same status can be an `action` station on several screens, so two
   * people pressing different buttons on the same record at the same instant is ordinary use, not a
   * race to be waved away. transitionMany takes `for update` on the rows before reading their
   * current status, so the second transaction waits, re-reads the status the first one wrote, and is
   * judged against reality. Without it both would pass the guard and the loser's status_logs row
   * would claim a move from a state the record was never in.
   */
  /**
   * Is this record frozen by an open cancellation, return, or a hold the engine placed?
   *
   * The freeze is deliberately NOT part of the flow's own rules: an order must stop moving the
   * moment someone asks to cancel it, whatever the workflow says, or the decision is being made
   * about a record that has meanwhile been shipped.
   *
   * A LINE IS FROZEN BY ITS HEADER'S EXCEPTION TOO. Returns are per line, but a cancellation is
   * usually raised on the order — and letting the lines march on while their parent is being
   * cancelled would defeat the whole thing.
   */
  private async frozenByException(
    tx: Tx,
    ctx: StatusContext,
    entity: StatusEntity,
    id: string,
  ): Promise<{ kind: string; reason: string } | null> {
    if (ctx.resolvingException) return null;
    const parent =
      entity === "rfq_item" ? sql`select rfq_id from rfq_items where id = ${id}::uuid`
      : entity === "order_item" ? sql`select order_id from order_items where id = ${id}::uuid`
      : null;
    const parentType = entity === "rfq_item" ? "rfq" : entity === "order_item" ? "order" : null;

    const row = (await tx.execute(sql`
      select kind, reason from workflow_exceptions
      where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)} and status = 'open'
        -- ONLY EXCEPTIONS RECORDED BEFORE THIS TRANSACTION. Without this clause the lock_record
        -- action eats the operation that triggered it: confirming an RFQ moves the header, whose
        -- arrow fires the action, which opens a hold on the header — and the very next statement of
        -- the same confirm moves the lines, which inherit their header's freeze (see above). The
        -- move is refused, the whole transaction rolls back, and the user is told the order cannot
        -- be confirmed because of a hold that no longer exists anywhere. Nothing happened at all,
        -- not even the run log that would have explained it.
        -- A consequence of a move must not retroactively veto the move it followed, nor the sibling
        -- work that belongs to the same business operation. xmin is the row's writing transaction,
        -- so this reads exactly as intended: somebody else's freeze, recorded earlier, still bites.
        and xmin <> pg_current_xact_id()::xid
        and (
          (entity_type = ${entity} and entity_id = ${id}::uuid)
          ${parent && parentType
            ? sql`or (entity_type = ${parentType} and entity_id = (${parent}))`
            : sql``}
        )
      limit 1`))[0] as { kind: string; reason: string } | undefined;
    return row ?? null;
  }

  /**
   * Bind a record that is ENTERING to the flow version live right now. The whole of the entry event
   * that is not simply "write the status and log it".
   *
   * IT CANNOT REFUSE. There is no `throw` anywhere in here and there must never be one: raising an
   * RFQ is the highest-traffic path in the product, and a workspace whose flow is half drawn — or
   * whose flow deliberately says nothing about how requests begin — has to be able to trade. Every
   * shape of missing configuration therefore falls out the same way, by doing less rather than by
   * saying no:
   *
   *   no active default flow  → no binding. Identical to the behaviour before the engine existed.
   *   flow has no step for the arrival status → no binding. The record is genuinely not on this
   *     flow, so claiming it is would put a step_entered_at and an SLA clock on a step it is not
   *     standing on, and would hand somebody custody of a record the flow never described.
   *
   * In both cases the record's later moves fall back to today's default flow exactly as they did
   * before, so an unbound entry costs nothing except the version pin.
   *
   * `is_entry` IS DELIBERATELY NOT CONSULTED. A flow has exactly one step marked as its start
   * (workflow_steps_entry_uq), but four different entity kinds enter this engine at four different
   * statuses — an rfq at new_rfq, an order at confirmed. Requiring the arrival status to be THE
   * entry step would mean an order could never be bound at birth, which is precisely the record
   * whose first status is written by another service and never logged.
   *
   * WHICH flow it binds to is now a real question — see selectFlow(). It is asked exactly once, here,
   * and never again for the life of the record.
   */
  private async bindOnEntry(
    tx: Tx,
    ctx: StatusContext,
    spec: { table: string; domain: "item" | "vendor" },
    entity: StatusEntity,
    entering: Array<{ id: string; status_id: string | null }>,
    toStatusId: string,
  ): Promise<Map<string, string>> {
    /** Which flow each record actually bound to, so write() can stamp it on the log row (0066). */
    const bound = new Map<string, string>();
    if (entering.length === 0 || !ctx.tenantId) return bound;

    const flows = await this.selectableFlows(tx, ctx, spec.domain);
    if (!flows.candidates.length && !flows.fallback) return bound;

    /**
     * How a record arriving on THIS flow lands: the step it stands on, and who holds it. Cached per
     * flow because it depends on the flow and the arrival status, neither of which varies inside
     * this call — while the flow itself now varies per record, so the lookup can no longer simply be
     * hoisted out of the loop. Without the cache, confirming a twenty-line request would run twenty
     * identical step-and-owner lookups. `null` records "this flow has no step for that status", so a
     * second record joining the same flow does not re-ask.
     */
    const arrivals = new Map<
      string,
      { assignee: string | null; assigneeRole: string | null; slaHours: number | null } | null
    >();

    for (const m of entering) {
      const flowId = await this.selectFlow(tx, flows, entity, m.id);
      if (!flowId) continue;

      if (!arrivals.has(flowId)) {
        const toStep = (await tx.execute(sql`
          select owner_roles, sla_hours from workflow_steps
          where flow_id = ${flowId}::uuid
            and coalesce(item_status_id, vendor_status_id) = ${toStatusId}::uuid
          limit 1`))[0] as { owner_roles: string[] | null; sla_hours: number | null } | undefined;

        if (!toStep) {
          arrivals.set(flowId, null);
        } else {
          // Custody on arrival follows the same rule a `pool` handoff follows on any other move: the
          // destination step's owners hold it, and a step with exactly ONE possible owner
          // auto-assigns, because leaving a record unclaimed when there is only one candidate is
          // busywork.
          const owners = (toStep.owner_roles ?? []) as string[];
          let assignee: string | null = null;
          let assigneeRole: string | null = null;
          if (owners.length) {
            assigneeRole = owners[0];
            const one = (await tx.execute(sql`
              select user_id from tenant_memberships
              where tenant_id = ${ctx.tenantId}::uuid and is_active
                and role::text in (${sql.join(owners.map((r) => sql`${r}`), sql`, `)})
              limit 2`)) as Array<{ user_id: string }>;
            if (one.length === 1) assignee = one[0].user_id;
          }
          arrivals.set(flowId, { assignee, assigneeRole, slaHours: toStep.sla_hours });
        }
      }

      // The flow this record was selected for does not describe the status it is arriving at, so it
      // is not standing on this flow — see the header. Binding it anyway would start an SLA clock on
      // a step it is not at. It stays unbound and its later moves fall back to the default, exactly
      // as they did before flow selection existed.
      const arrival = arrivals.get(flowId);
      if (!arrival) continue;

      const due = arrival.slaHours
        ? sql`now() + ${`${arrival.slaHours} hours`}::interval`
        : sql`null::timestamptz`;

      // ON CONFLICT DO NOTHING, unlike the move path's DO UPDATE. A record can only be born once;
      // if a row is already here then this is not an entry at all, and quietly rewriting the flow
      // binding of a record already mid-flight is exactly the strand-an-order-mid-version failure
      // the binding exists to prevent.
      await tx.execute(sql`
        insert into workflow_record_state (tenant_id, environment, entity_type, entity_id, status_domain,
                                           flow_id, assignee_user_id, assignee_role, step_entered_at, due_at)
        values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${entity}, ${m.id}::uuid, ${spec.domain},
                ${flowId}::uuid, ${arrival.assignee}::uuid, ${arrival.assigneeRole}, now(), ${due})
        on conflict (tenant_id, environment, entity_type, entity_id) do nothing`);
      bound.set(m.id, flowId);
    }
    return bound;
  }

  /**
   * The flows a record entering this domain could join, in the order they are offered — 0065.
   *
   * ORDER: `selection_priority desc, created_at asc, id asc`. The first two are the rule
   * `workflow_transitions` already uses when two arrows join the same pair of steps, reused verbatim
   * rather than invented again one level up. `id` is not a third rule, it is what makes the sort
   * TOTAL: two flows published in the same transaction share a created_at to the microsecond, and
   * Postgres promises nothing about the order of tied rows — so without it, "which flow governs this
   * order" could differ between two runs of the same query. It never has to be explained to an admin
   * because it can only decide a tie the other two could not.
   *
   * THE DEFAULT IS NOT A CANDIDATE. It is held back as the fallback, and that is the difference
   * between this feature working and not working: the provisioned default carries
   * `selection_condition = '{}'` (matches everything) and is the OLDEST flow in almost every
   * workspace, so ranking it with the rest would let it capture every record ahead of the insurance
   * flow drawn last week — which is precisely the arrangement the owner asked for.
   *
   * A NULL condition is excluded: null means "routing not decided", and a half-drawn flow must not
   * capture records. `{}` is the deliberate way to say "everything" (see the column comment on
   * workflow_flows.selection_condition).
   */
  private async selectableFlows(
    tx: Tx,
    ctx: StatusContext,
    domain: "item" | "vendor",
  ): Promise<{ candidates: Array<{ id: string; condition: Condition }>; fallback: string | null }> {
    const rows = (await tx.execute(sql`
      select id, is_default, selection_condition, entry_mode from workflow_flows
      where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
        and status_domain = ${domain} and status = 'active'
      order by selection_priority desc, created_at asc, id asc`)) as Array<{
      id: string; is_default: boolean; selection_condition: Condition | null; entry_mode: string;
    }>;
    return {
      candidates: rows
        // entry_mode = 'handoff' means "records only ever arrive here by crossing an arrow that
        // names this flow". Nothing stopped such a flow ALSO carrying a selection condition, and
        // this filter did not read the column — so a sub-flow could win the race for a brand-new
        // record and capture it at birth, which is the exact failure the column was added to
        // prevent. A record born into a sub-flow finishes inside the wrong rulebook, and its
        // terminals are the ones activation warns "stay in this workflow for good".
        .filter((f) => f.entry_mode !== "handoff")
        .filter((f) => !f.is_default && f.selection_condition !== null)
        .map((f) => ({ id: f.id, condition: f.selection_condition as Condition })),
      fallback: rows.find((f) => f.is_default)?.id ?? null,
    };
  }

  /**
   * WHICH RULEBOOK IS THIS RECORD JOINING? Asked once, when it enters, and never asked again.
   *
   * That is the whole design constraint, not an optimisation. `payer_type` is an ordinary editable
   * field: if the answer were recomputed on every move, correcting a request's payer halfway through
   * would swap the rulebook underneath the people working it — arrows that existed yesterday would
   * be gone, the step it is standing on might not exist in the new flow, and the audit trail would
   * show a record executing two flows with nothing recording the switch. So the choice is written to
   * workflow_record_state.flow_id (bindOnEntry) and assertTransitionAllowed reads THAT.
   *
   * Facts are read per record rather than per batch: the lines of one request happen to share their
   * header's facts today (gatherFacts resolves a line to its rfq), but "every record in this batch
   * gets the same answer" is not a property this function is allowed to assume. The read is skipped
   * entirely when the workspace has no conditional flow, which is every workspace until somebody
   * draws a second one.
   */
  private async selectFlow(
    tx: Tx,
    flows: { candidates: Array<{ id: string; condition: Condition }>; fallback: string | null },
    entity: StatusEntity,
    id: string,
  ): Promise<string | null> {
    if (!flows.candidates.length) return flows.fallback;
    const facts = await gatherFacts(tx, entity, id);
    return flows.candidates.find((c) => evaluate(c.condition, facts))?.id ?? flows.fallback;
  }

  private async assertTransitionAllowed(
    tx: Tx,
    ctx: StatusContext,
    spec: { table: string; domain: "item" | "vendor" },
    entity: StatusEntity,
    moving: Array<{ id: string; status_id: string | null }>,
    toStatusId: string,
    toCode: string,
  ): Promise<{ waived: GateFailure[]; flowByRecord: Map<string, string> }> {
    const waived: GateFailure[] = [];
    /**
     * The flow each record's move was judged under, keyed by record id — 0066.
     *
     * On a crossing this is the flow the record LANDED in, not the one it left: that is the graph
     * whose arrow was taken, whose step the record now stands on, and whose owners are holding it.
     * write() stamps it on the status_logs row so "which rulebook was in force" survives the record
     * coming home and the flow being republished three times afterwards.
     */
    const flowByRecord = new Map<string, string>();
    if (moving.length === 0 || !ctx.tenantId) return { waived, flowByRecord };

    // THE DEFAULT, AND ONLY THE DEFAULT — selection is NOT re-run on a move.
    //
    // A record that was bound at entry executes the flow it was bound to (below). A record that was
    // not — one that predates the engine, or entered at a status its flow does not draw — falls back
    // to today's default, which is exactly what it did before flow selection existed. Evaluating
    // selection_condition here as well would mean editing a request's payer mid-flight silently
    // moved it to a different rulebook, and this is the code that would then judge its next move
    // against arrows nobody working the record has seen.
    const active = (await tx.execute(sql`
      select id from workflow_flows
      where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
        and status_domain = ${spec.domain} and status = 'active' and is_default
      limit 1`))[0] as { id: string } | undefined;

    for (const m of moving) {
      // which flow is THIS record executing? the one it was bound to, else today's default
      const bound = (await tx.execute(sql`
        select flow_id from workflow_record_state
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
          and entity_type = ${entity} and entity_id = ${m.id}::uuid
        limit 1`))[0] as { flow_id: string } | undefined;
      const flowId = bound?.flow_id ?? active?.id;
      if (!flowId) continue; // nothing configured — behave as before the engine existed

      const steps = (await tx.execute(sql`
        select id, coalesce(item_status_id, vendor_status_id) as status_id, owner_roles, sla_hours
        from workflow_steps where flow_id = ${flowId}::uuid`)) as Array<
        { id: string; status_id: string; owner_roles: string[] | null; sla_hours: number | null }
      >;
      const toStep = steps.find((x) => x.status_id === toStatusId);
      const fromStep = steps.find((x) => x.status_id === m.status_id);

      // If the record's CURRENT status is not in this flow, it is not really executing it — we
      // cannot judge the move, so allow it. But once it IS on the flow, leaving for a status the
      // flow does not contain is precisely the thing to stop: otherwise "the workflow says
      // new_rfq → confirmed" is advice, not a rule.
      if (!fromStep) continue;

      // one lookup: the error messages, the approval key and the audit trail all want this
      const fromCodeStr = ((await tx.execute(sql`
        select coalesce(i.code, v.code) as code from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.id = ${fromStep.id}::uuid`))[0] as { code: string } | undefined)?.code ?? "current";
      if (!toStep) {
        const fc = (await tx.execute(sql`
          select coalesce(i.code, v.code) as code from workflow_steps s
          left join item_statuses i on i.id = s.item_status_id
          left join vendor_statuses v on v.id = s.vendor_status_id
          where s.id = ${fromStep.id}::uuid`))[0] as { code: string } | undefined;
        throw new BadRequestException(
          `'${toCode}' is not a step in this workflow, so '${fc?.code ?? "the current status"}' cannot move there. ` +
            `Add the step to the workflow, or pick a status it contains.`,
        );
      }

      // ALL matching arrows, highest priority first — not `limit 1` with no ordering.
      // Two arrows may connect the same pair with different conditions ("insurance goes this way,
      // everyone else that way"), and picking one arbitrarily made both `condition` and `priority`
      // meaningless. The first arrow whose condition holds is the one being taken.
      const candidates = (await tx.execute(sql`
        select allowed_roles, handoff, gates, condition, priority, requires_approval, actions,
               to_flow_key
        from workflow_transitions
        where flow_id = ${flowId}::uuid and from_step_id = ${fromStep.id}::uuid and to_step_id = ${toStep.id}::uuid
        order by priority desc, created_at asc`)) as Array<{
        allowed_roles: string[] | null; handoff: string;
        gates: GateConfig[] | null; condition: Condition | null; priority: number;
        requires_approval: boolean; actions: ActionConfig[] | null;
        /** 0066 — set when this arrow is a BORDER. Arrow selection itself is unchanged. */
        to_flow_key: string | null;
      }>;

      let edge: (typeof candidates)[number] | undefined;
      let blockedBy: Condition | null = null;
      if (candidates.length) {
        const unconditional = candidates.filter((c) => isEmptyCondition(c.condition));
        const conditional = candidates.filter((c) => !isEmptyCondition(c.condition));
        // reading the record once is enough for every clause on every candidate
        const facts = conditional.length ? await gatherFacts(tx, entity, m.id) : {};
        edge =
          conditional.find((c) => evaluate(c.condition, facts)) ??
          unconditional[0];
        // every arrow exists but none applies here — say WHICH rule turned it away, not "not allowed"
        if (!edge && conditional.length) blockedBy = conditional[0].condition;
      }

      if (!edge && blockedBy) {
        throw new BadRequestException(
          `this move is only allowed when ${describe(blockedBy)}`,
        );
      }
      if (!edge) {
        const fromCode = (await tx.execute(sql`
          select coalesce(i.code, v.code) as code from workflow_steps s
          left join item_statuses i on i.id = s.item_status_id
          left join vendor_statuses v on v.id = s.vendor_status_id
          where s.id = ${fromStep.id}::uuid`))[0] as { code: string } | undefined;
        throw new BadRequestException(
          `this workflow does not allow '${fromCode?.code ?? "current"}' → '${toCode}'. ` +
            `Add that transition to the workflow, or move the order along a step that is drawn.`,
        );
      }

      // ── who may make this move ────────────────────────────────────────────────────────────
      // Two independent gates, and an empty list on either is silence, not denial:
      //   step.owner_roles       — who is responsible for the record while it sits here
      //   transition.allowed_roles — who may fire this particular arrow
      // Both must be satisfied, which is what lets an admin say "this desk belongs to purchasing"
      // once on the step, and still single out one arrow for a manager.
      const ownerRoles = (fromStep.owner_roles ?? []) as string[];
      const edgeRoles = (edge.allowed_roles ?? []) as string[];
      // An automatic move has no person behind it, so "who may do this" is not a question that can
      // be asked of it. The gates and conditions still apply — the machine gets no shortcut past the
      // business rules, only past the permissions of a human who is not there.
      if ((ctx.autoDepth ?? 0) === 0 && (ownerRoles.length || edgeRoles.length)) {
        const held = await this.effectiveRoles(tx, ctx);
        // break-glass: a workspace that has restricted a step to a role nobody holds still needs a
        // way out, and refusing the platform owner would make that unrecoverable without SQL.
        if (!held.has("super_admin")) {
          const fails = (req: string[]) => req.length > 0 && !req.some((r) => held.has(r));
          if (fails(ownerRoles))
            throw new ForbiddenException(
              `this step is handled by ${ownerRoles.join(" or ")}; your account is not one of them`,
            );
          if (fails(edgeRoles))
            throw new ForbiddenException(
              `only ${edgeRoles.join(" or ")} may perform '${toCode}' from here`,
            );
        }
      }

      // ── is the business ready for this move? ─────────────────────────────────────────────
      // Ordered AFTER the role check on purpose: telling someone the lines are unpriced, when they
      // were never allowed to confirm in the first place, sends them to fix the wrong thing.
      const gateCfgs = (edge.gates ?? []) as GateConfig[];
      if (gateCfgs.length) {
        const failures = await runGates(tx, entity, m.id, gateCfgs);
        const blocking = failures.filter(
          (f) => f.enforcement === "block" || !ctx.overrideReason,
        );
        if (blocking.length) throw new GateNotSatisfiedException(blocking);

        // everything that failed was overridable AND a reason was given — record what was waived
        if (failures.length) waived.push(...failures);
      }

      // ── does this move need a signature? ─────────────────────────────────────────────────
      // Ordered AFTER the gates: telling someone to go and get an approval, when the lines are not
      // priced and the move could not happen anyway, wastes an approver's time on a decision that
      // is not ready to be made.
      if (edge.requires_approval) {
        const key = `${fromCodeStr}>${toCode}`;
        // `and flow_id` — 0066, AND IT IS A CORRECTNESS FIX, NOT TIDINESS.
        //
        // `transition_key` is `${from}>${to}` with no flow in it, which was sound while one record
        // could only ever execute one flow. Since a record can now cross into a sub-flow and back,
        // the SAME record can meet a `priced>confirmed` arrow in two different flows — and without
        // this predicate a signature given for the standard flow's arrow would be spent by the
        // insurance flow's identically-named one. That is an approval crossing a governance
        // boundary, which is exactly what an approval exists to prevent.
        //
        // The flow used is `flowId`, the one this move is being JUDGED under — not the flow the
        // record is about to land in. The question these keys answer is "has this record already
        // been signed off for this move under THESE rules", and the rules in force are the ones the
        // arrow was drawn on.
        //
        // `or flow_id is null` IS NOT A LOOPHOLE — it is the only correct reading of a pre-0066 row.
        // Every approval granted before this migration carries null, and a bare `=` would render all
        // of them un-granted the moment the deploy landed: work already signed off would ask for a
        // second signature. Those rows cannot possibly belong to a sub-flow, because no record could
        // cross into one until now. A row written since 0066 always carries the flow it was raised
        // under (approvals.service.ts), so the collision above stays shut: a grant stamped with the
        // standard flow is neither equal to the insurance flow nor null.
        const granted = (await tx.execute(sql`
          select id from approval_requests
          where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
            and entity_type = ${entity} and entity_id = ${m.id}::uuid
            and transition_key = ${key} and (flow_id = ${flowId}::uuid or flow_id is null)
            and overall_status = 'approved' and consumed_at is null
          limit 1 for update`))[0] as { id: string } | undefined;

        if (granted) {
          // Spend it. `where consumed_at is null` makes this the arbiter if two moves race for the
          // same grant — the second finds nothing to consume and is turned away.
          const spent = (await tx.execute(sql`
            update approval_requests set consumed_at = now()
            where id = ${granted.id}::uuid and consumed_at is null
            returning id`)) as Array<{ id: string }>;
          if (!spent.length) throw new ApprovalRequiredException(key, null, "that approval was just used");
        } else {
          // NOTHING GRANTED. The guard refuses and says so — it does NOT open the request itself.
          //
          // It cannot: this runs inside the caller's business transaction, and refusing rolls that
          // transaction back, taking any request created here with it. The first cut did exactly
          // that and produced a message saying "sent for sign-off" with nothing on the approvals
          // screen — the worst kind of failure, because it looks like it worked.
          //
          // Asking for a signature is a deliberate act anyway. The caller gets everything it needs
          // to offer it: which move, and whether one is already waiting.
          const pending = (await tx.execute(sql`
            select id from approval_requests
            where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
              and entity_type = ${entity} and entity_id = ${m.id}::uuid
              and transition_key = ${key} and (flow_id = ${flowId}::uuid or flow_id is null)
              and overall_status = 'pending'
            limit 1`))[0] as { id: string } | undefined;

          throw new ApprovalRequiredException(
            key,
            pending?.id ?? null,
            pending ? "already waiting for sign-off" : "this move needs sign-off before it can happen",
          );
        }
      }

      // ── THE CROSSING: does this arrow hand the record to another flow? (0066) ─────────────
      //
      // PLACED HERE ON PURPOSE — after every rule that can still say no (roles, gates, approval),
      // and before anything at all is written. Both refusals below therefore leave the record
      // exactly where it was, on a flow that still governs it, with every other arrow out of its
      // current step still available. That is the whole stranding story: there is no half-crossed
      // state to be in, because the decision is made before the first write.
      //
      // A crossing is ONE move. It changes which flow the upsert below binds the record to and
      // which step's owners take custody of it — it does not re-enter the write path, so there is
      // one status_logs row, one custody write, and nothing in the run log that has to be explained
      // away as an order going backwards.
      let targetFlowId = flowId;
      let landingStep: { id: string; owner_roles: string[] | null; sla_hours: number | null } = toStep;
      /** Non-null ONLY on an outbound crossing: the flow being left, so the record can prefer it home. */
      let originFlowId: string | null = null;
      /**
       * DOES THIS MOVE GET TO DECIDE WHERE HOME IS? Only a crossing does.
       *
       * Without this flag the upsert below wrote `origin_flow_id = excluded.origin_flow_id` on every
       * move, and every ordinary move computes null — so the first step a record took INSIDE a
       * sub-flow erased the memory of where it came from. A sub-flow you leave in a single move
       * survived that; one with any intermediate step, which is the case this feature exists for,
       * did not. The record then lost both its way home: the version hint that lands it back on the
       * right rulebook, and the break-glass lever, which refuses to act on a record it can no longer
       * see as away. An order could be left with no move it was allowed to make and no way to be
       * rescued — confirmed by driving it, and confirmed again by restoring the column by hand and
       * watching the same refused move go straight through.
       */
      let originDecided = false;
      if (edge.to_flow_key) {
        const away = (await tx.execute(sql`
          select origin_flow_id from workflow_record_state
          where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
            and entity_type = ${entity} and entity_id = ${m.id}::uuid
          limit 1`))[0] as { origin_flow_id: string | null } | undefined;

        // IS THIS A RETURN? Only if the record is currently away AND this arrow names the flow it
        // calls HOME. Anything else is an outbound crossing, including a second hop from one
        // sub-flow into another — which needs no special case precisely because there is no stack to
        // unwind. What "home" means is settled at the write below; read that note first.
        const originKey = away?.origin_flow_id
          ? ((await tx.execute(sql`
              select flow_key, status from workflow_flows where id = ${away.origin_flow_id}::uuid`))[0] as
              { flow_key: string; status: string } | undefined)
          : undefined;
        const isReturn = !!originKey && originKey.flow_key === edge.to_flow_key;

        /**
         * THE VERSION HINT, APPLIED. On the way home the record prefers the exact version it left,
         * which is the invariant the flow binding exists to protect: a record does not change
         * rulebooks mid-flight just because somebody republished while it was away.
         *
         * Two conditions, and both are about the hint being USABLE rather than about it existing:
         *   • non-draft — a flow that has gone back to draft is being edited and its graph is not
         *     something a live record may be judged against;
         *   • has a step for the landing status — the version it left may have been superseded by
         *     one that dropped that status, and landing a record on a step that is not there is the
         *     stranding this whole design refuses.
         * If either fails, the fallback below resolves the ACTIVE version of the named key instead.
         * NOTHING DEPENDS ON THE HINT: null, stale or unusable, the crossing still completes.
         */
        let target: { id: string } | undefined;
        if (isReturn && originKey.status !== "draft") {
          target = (await tx.execute(sql`
            select f.id from workflow_flows f
            where f.id = ${away!.origin_flow_id}::uuid
              and exists (select 1 from workflow_steps s
                          where s.flow_id = f.id
                            and coalesce(s.item_status_id, s.vendor_status_id) = ${toStatusId}::uuid)
            limit 1`))[0] as { id: string } | undefined;
        }
        // The fallback, and the ordinary outbound path: the ACTIVE version of the named key.
        // `workflow_flows_active_uq` is unique on (tenant_id, environment, flow_key) where
        // status = 'active', so this is one unique-index lookup and can return at most one row.
        // status_domain is pinned too: handing an item record to a vendor-domain flow would bind it
        // to a graph speaking a vocabulary its statuses do not appear in.
        if (!target) {
          target = (await tx.execute(sql`
            select id from workflow_flows
            where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
              and flow_key = ${edge.to_flow_key} and status_domain = ${spec.domain}
              and status = 'active'
            limit 1`))[0] as { id: string } | undefined;
        }
        if (!target)
          throw new ConflictException(
            `the '${edge.to_flow_key}' workflow has no active version, so this order cannot be ` +
              `handed to it. Publish that workflow, or move the order along a different step.`,
          );

        // WHERE DOES IT STAND WHEN IT ARRIVES? The destination status must be a step in the target
        // flow. Refusing here rather than binding anyway is the difference between a record that
        // did not move and a record sitting on a flow that has no arrows out of where it is.
        const step = (await tx.execute(sql`
          select id, owner_roles, sla_hours from workflow_steps
          where flow_id = ${target.id}::uuid
            and coalesce(item_status_id, vendor_status_id) = ${toStatusId}::uuid
          limit 1`))[0] as { id: string; owner_roles: string[] | null; sla_hours: number | null } | undefined;
        if (!step)
          throw new ConflictException(
            `the '${edge.to_flow_key}' workflow has no step for '${toCode}', so a record handed ` +
              `there would have nowhere to stand. Add that status to it, or aim this move elsewhere.`,
          );

        targetFlowId = target.id;
        landingStep = step;
        /**
         * WHAT "HOME" MEANS, WITHOUT A STACK — and this line is the whole answer.
         *
         * It was `isReturn ? null : flowId`: every outbound crossing overwrote the origin with
         * whatever flow the record happened to be leaving. Fine for one hop. For A → B → C → A —
         * an order that detours through insurance, is passed on to returns, and finishes at home —
         * the second hop rewrote home from A to B, so the arrow back into A no longer matched the
         * origin, was judged an OUTBOUND crossing, and set origin = C. The record is standing in A,
         * which is its home, permanently flagged as away from a flow it is not in: counted for ever
         * in workflow_record_state_away_idx, labelled "from Returns" in My Work while it sits on the
         * standard flow, and handed to the break-glass endpoint, which reports "bring it back from
         * C to A" about a record already in A — false in both halves.
         *
         * THE RULE IS: HOME IS WHERE THE RECORD STARTED, and it is written ONCE — on the first
         * crossing out of it — and cleared only by arriving back there. `away?.origin_flow_id ??`
         * is the entire implementation: an origin that already exists is never overwritten, so B → C
         * keeps home = A and C → A is recognised as the return it is.
         *
         * WHY THAT RULE AND NOT "the flow it most recently left". The alternative needs a stack to
         * be coherent — with only one column, "most recently left" makes A → B → C → A unclosable,
         * because no single value can be both B (for a hop back to B) and A (for a hop home). A
         * stack is exactly what 0066 refused, and for a reason that has not changed: every frame it
         * pushes is a frame that can be orphaned, and an orphaned frame is a record sitting
         * somewhere nobody drew. One column answering one question — "is this record away from
         * home, and where is home" — cannot be orphaned, because the question has one answer at
         * every instant of the record's life.
         *
         * NOTHING IS LOST BY NOT REMEMBERING THE HOPS. status_logs carries flow_id on every row
         * since 0066, so the full itinerary — which flow judged each move, in order — is already
         * recorded and is where "where has this record been" is answered. This column is not a
         * history; it is the single fact the run-time resolver, the away index and the break-glass
         * lever each need, and it is now true at every point on a multi-hop journey.
         */
        originFlowId = isReturn ? null : (away?.origin_flow_id ?? flowId);
        originDecided = true;
      }

      // ── custody: who is holding this record now that it has moved ────────────────────────
      // The flow says what SHOULD happen to responsibility on this arrow; this records what did.
      //   pool  — release it to the destination step's owners (the default: a move usually means
      //           the work has left your desk)
      //   keep  — the current holder keeps it
      //   actor — whoever just made the move takes it on
      // A pooled record with exactly ONE possible owner is auto-assigned: leaving it "unclaimed"
      // when there is only one candidate is busywork, not governance.
      //
      // `landingStep`, not `toStep` — 0066. On an ordinary move the two are the same object, so this
      // is unchanged. On a crossing, the destination step is the one in the TARGET flow, and reading
      // its owners is what makes "the sub-flow's own people" literally true rather than a claim: a
      // `pool` handoff releases the record to insurance's desk, not to whoever happened to own the
      // same status back on the standard flow. The single-candidate auto-assign below works
      // unchanged, and so does the SLA clock, which now starts against the sub-flow's own target.
      const toOwners = ((landingStep.owner_roles ?? []) as string[]);
      let assignee: string | null = null;
      let assigneeRole: string | null = null;
      if (edge.handoff === "keep") {
        const cur = (await tx.execute(sql`
          select assignee_user_id, assignee_role from workflow_record_state
          where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
            and entity_type = ${entity} and entity_id = ${m.id}::uuid limit 1`))[0] as
          { assignee_user_id: string | null; assignee_role: string | null } | undefined;
        assignee = cur?.assignee_user_id ?? null;
        assigneeRole = cur?.assignee_role ?? null;
      } else if (edge.handoff === "actor") {
        assignee = ctx.userId;
        assigneeRole = toOwners[0] ?? null;
      } else if (toOwners.length) {
        assigneeRole = toOwners[0];
        const one = (await tx.execute(sql`
          select user_id from tenant_memberships
          where tenant_id = ${ctx.tenantId}::uuid and is_active
            and role::text in (${sql.join(toOwners.map((r) => sql`${r}`), sql`, `)})
          limit 2`)) as Array<{ user_id: string }>;
        if (one.length === 1) assignee = one[0].user_id;
      }
      const due = landingStep.sla_hours
        ? sql`now() + ${`${landingStep.sla_hours} hours`}::interval`
        : sql`null::timestamptz`;

      // ON CONFLICT DO UPDATE, not DO NOTHING: the row is now living state that must follow the
      // record, not a write-once pin.
      //
      // ── WHEN flow_id CHANGES, AND WHY THAT IS NOT THE FAILURE THIS COMMENT USED TO WARN ABOUT ──
      //
      // This said flow_id is deliberately never updated, because a record stays bound to the version
      // it entered and that is what stops a republish stranding it. That guarantee is intact and
      // this write does not weaken it: on every ordinary move `targetFlowId === flowId`, so the
      // assignment is a no-op and a record bound to a retired v1 stays on v1 while v2 is active.
      //
      // The one case where it differs is a CROSSING, and a crossing is not a quiet rewrite. It is an
      // arrow somebody drew on the canvas, present in both graphs, refused at activation if the
      // destination flow or its landing step is missing, refused again a few lines above if either
      // has gone since, and frozen by the database while records are executing it. The failure the
      // old comment guarded against is a record's rulebook changing UNDER it with nothing recording
      // the change; here the change IS the move, it is the reason the person clicked, and
      // status_logs.flow_id below records which rulebook each move was judged under.
      //
      // origin_flow_id rides the same write — set on the way out, cleared on the way back, and LEFT
      // ALONE by every ordinary move, so a record keeps its way home for as long as it is away.
      // Still ONE write.
      await tx.execute(sql`
        insert into workflow_record_state (tenant_id, environment, entity_type, entity_id, status_domain,
                                           flow_id, origin_flow_id, assignee_user_id, assignee_role,
                                           step_entered_at, due_at)
        values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${entity}, ${m.id}::uuid, ${spec.domain},
                ${targetFlowId}::uuid, ${originFlowId}::uuid, ${assignee}::uuid, ${assigneeRole},
                now(), ${due})
        on conflict (tenant_id, environment, entity_type, entity_id) do update
          set flow_id          = excluded.flow_id,
              origin_flow_id   = ${originDecided ? sql`excluded.origin_flow_id` : sql`workflow_record_state.origin_flow_id`},
              assignee_user_id = excluded.assignee_user_id,
              assignee_role    = excluded.assignee_role,
              step_entered_at  = excluded.step_entered_at,
              due_at           = excluded.due_at,
              updated_at       = now()`);

      // ── what this move DOES ──────────────────────────────────────────────────────────────
      // Placed after every rule that could still refuse the move: an action that fired for a move
      // which was then rejected would be a consequence without a cause. Nothing in here throws — a
      // broken action must not fail a person's correct click. It lands in the run log instead,
      // which is the whole reason that log exists.
      //
      // AND AFTER CUSTODY, which is a later ordering than this block originally had. The reason is
      // `notify`: it is the first action that reads the move rather than only writing to it, and
      // the thing it reads is who is holding the record NOW. Run before the custody write, it saw
      // the previous desk — or, on a record's first move, no custody row at all — so a message
      // announcing "this is yours" went to whoever it had just stopped being. Nothing here can
      // refuse a move, so moving the actions below it costs the original ordering nothing: every
      // rule that could still say no is still above.
      const actionCfgs = (edge.actions ?? []) as ActionConfig[];
      if (actionCfgs.length) {
        await runActions(
          tx,
          {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            environment: envOf(ctx),
            automatic: (ctx.autoDepth ?? 0) > 0,
            /**
             * THE DEPTH TRAVELS INTO THE ACTION RUN, ALWAYS ONE DEEPER — QNEW-90 item 5, third lever.
             *
             * An action is a consequence of a move, so anything it reaches for is engine work, even
             * when the move itself was a person's click (depth 0 → the action runs at 1). That is
             * what makes `set_field` unable to restart the rules: reevaluate() refuses above depth 0,
             * so an action's own write can never be presented back to the engine as a fresh business
             * event. Without it the loop is short and real — set_field writes a field, the field is
             * a fact a condition reads, the re-evaluation fires the move whose action writes the
             * field — and it would come back round with the depth budget reset to zero every lap,
             * so MAX_AUTO_DEPTH would never see it.
             */
            autoDepth: (ctx.autoDepth ?? 0) + 1,
          },
          entity,
          m.id,
          `${fromCodeStr}>${toCode}`,
          actionCfgs,
          { notifications: this.notifications },
        );
      }

      flowByRecord.set(m.id, targetFlowId);
    }

    return { waived, flowByRecord };
  }

  /**
   * Carry a record forward if the flow says a move should happen by itself and its rules now hold.
   *
   * THIS IS EVENT-DRIVEN, NOT SCHEDULED. There is no cron in this repo and none is needed: the
   * moment that matters is when something CHANGES — a quote lands, a line gets priced — and that
   * moment is exactly when a status was just written. So the trigger is the transition itself.
   *
   * Everything about it is bounded:
   *   • only transitions explicitly marked `auto_advance` are considered — opt in, never inferred
   *   • gates and conditions are evaluated normally; the machine gets no shortcut past the rules
   *   • `auto_once` stops a flow that legitimately revisits a status from re-firing the same move
   *   • MAX_AUTO_DEPTH stops any chain, including one this engine can genuinely form: the final
   *     approval performs a move (0052), which could satisfy an auto transition, which could raise
   *     another approval
   *   • a failure is SWALLOWED, not raised. The human's move succeeded; an automatic follow-on that
   *     cannot happen is not their problem to be told about mid-click.
   */
  private async autoAdvance(
    tx: Tx,
    ctx: StatusContext,
    entity: StatusEntity,
    ids: string[],
  ): Promise<void> {
    const depth = ctx.autoDepth ?? 0;
    if (depth >= MAX_AUTO_DEPTH || !ctx.tenantId) return;
    const spec = ENTITIES[entity];
    if (!spec) return;

    for (const id of ids) {
      const bound = (await tx.execute(sql`
        select flow_id from workflow_record_state
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
          and entity_type = ${entity} and entity_id = ${id}::uuid limit 1`))[0] as
        { flow_id: string } | undefined;
      if (!bound) continue; // not executing a flow — nothing to carry it forward

      const [cur] = (await tx.execute(sql`
        select status_id from ${sql.raw(spec.table)} where id = ${id}::uuid`)) as Array<
        { status_id: string | null }
      >;
      if (!cur?.status_id) continue;

      const candidates = (await tx.execute(sql`
        select t.condition, t.gates, t.auto_once,
               coalesce(fi.code, fv.code) as from_code,
               coalesce(ti.code, tv.code) as to_code
        from workflow_transitions t
        join workflow_steps fs on fs.id = t.from_step_id
        join workflow_steps ts on ts.id = t.to_step_id
        left join item_statuses fi on fi.id = fs.item_status_id
        left join vendor_statuses fv on fv.id = fs.vendor_status_id
        left join item_statuses ti on ti.id = ts.item_status_id
        left join vendor_statuses tv on tv.id = ts.vendor_status_id
        where t.flow_id = ${bound.flow_id}::uuid and t.auto_advance
          and coalesce(fs.item_status_id, fs.vendor_status_id) = ${cur.status_id}::uuid
        order by t.priority desc, t.created_at asc`)) as Array<{
        condition: Condition | null; gates: GateConfig[] | null; auto_once: boolean;
        from_code: string; to_code: string;
      }>;
      if (!candidates.length) continue;

      const facts = await gatherFacts(tx, entity, id);
      for (const c of candidates) {
        if (!evaluate(c.condition, facts)) continue;
        const key = `${c.from_code}>${c.to_code}`;

        if (c.auto_once) {
          // Scoped to the flow the arrow belongs to — 0066, the other half of the transition_key
          // collision. `transition_key` carries no flow, so without this an `auto_once` that fired
          // for `priced>confirmed` on the standard flow would permanently suppress the identically
          // named arrow inside the insurance flow: the sub-flow's automation would simply never run
          // for any record that had already taken that step at home, and nothing would say why.
          //
          // `or flow_id is null` covers every row written before 0066, which is what those rows have
          // always meant: fired for this record on the only flow there was.
          const already = (await tx.execute(sql`
            select 1 from workflow_auto_fired
            where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
              and entity_type = ${entity} and entity_id = ${id}::uuid and transition_key = ${key}
              and (flow_id = ${bound.flow_id}::uuid or flow_id is null)
            limit 1`))[0];
          if (already) continue;
        }

        const failures = await runGates(tx, entity, id, (c.gates ?? []) as GateConfig[]);
        // an automatic move never overrides anything: nobody is there to give a reason
        if (failures.length) continue;

        try {
          if (c.auto_once) {
            // flow_id is the flow the arrow was READ from (bound.flow_id) — the rules under which
            // this automatic move is being judged — not wherever the move may hand the record next.
            await tx.execute(sql`
              insert into workflow_auto_fired
                (tenant_id, environment, entity_type, entity_id, transition_key, flow_id)
              values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${entity}, ${id}::uuid, ${key},
                      ${bound.flow_id}::uuid)
              on conflict do nothing`);
          }
          await this.transitionMany(
            tx,
            { ...ctx, autoDepth: depth + 1 },
            { entity, ids: [id], toCode: c.to_code },
          );
        } catch {
          // The human's move already succeeded. An automatic follow-on that cannot happen — an
          // approval it needs, a role it cannot satisfy — is not something to fail their click over.
          // It stays where it is and a person picks it up.
        }
        break; // one automatic step per pass; the recursion handles the next one
      }
    }
  }

  /**
   * SOMETHING CHANGED AROUND THIS RECORD — look again (QNEW-90 item 7, the child events).
   *
   * The guard only ever ran when a human tried to move something, which meant the facts the gates
   * read could become satisfied and nothing would notice. A vendor submits the third quote and
   * min_quotes_per_item is now met; a delivery is recorded and every line is finally `delivered`.
   * Before this, the record sat there until somebody happened to open it and press the button.
   *
   * It is a DOOR, not an engine. All it does is hand the record to the same autoAdvance the status
   * gateway already uses after every move, so there is exactly one piece of code in this system that
   * decides a record may carry itself forward. A second one would be the beginning of two answers to
   * "why did this order move".
   *
   * ── THE REFUSAL: SYSTEM-ACTOR WRITES NEVER RE-TRIGGER RULES (QNEW-90 item 5, third lever) ──────
   * A caller already inside an automatic chain — most concretely, a `set_field` action, which runs
   * at depth+1 by construction (see the ctx handed to runActions) — gets nothing. That refusal is
   * what closes the one loop the depth cap cannot see: this method does not increment the depth, it
   * starts a pass at whatever depth it is given, so a re-evaluation reachable from inside an action
   * run would hand the engine a fresh budget on every lap and MAX_AUTO_DEPTH would never bite.
   * "Only a real-world event reopens the rules" is the invariant; an action writing a field is the
   * engine talking to itself.
   *
   * Failures inside are swallowed by autoAdvance itself: the quote WAS submitted and the delivery
   * WAS recorded, and a follow-on move that cannot happen is not a reason to fail either.
   */
  async reevaluate(
    tx: Tx,
    ctx: StatusContext,
    entity: StatusEntity,
    ids: string[],
  ): Promise<void> {
    if ((ctx.autoDepth ?? 0) > 0) return;
    if (ids.length === 0) return;
    await this.autoAdvance(tx, ctx, entity, ids);
  }

  /**
   * Where a record stands right now, read from its own table.
   *
   * A READ, not a second write path — this file's rule is that status_id is WRITTEN in exactly one
   * place, and this writes nothing. It exists so that callers who need to reason about the record's
   * current step (the break-glass return in workflow.service.ts) do not have to keep their own copy
   * of the entity→table map: that map is the thing ENTITIES exists to be the only copy of, and a
   * second one would drift the first time an entity is added.
   */
  async currentStatusId(tx: Tx, entity: StatusEntity, id: string): Promise<string | null> {
    const spec = ENTITIES[entity];
    if (!spec) throw new BadRequestException(`statuses are not tracked for '${entity}'`);
    const row = (await tx.execute(
      sql`select status_id from ${sql.raw(spec.table)} where id = ${id}::uuid limit 1`,
    ))[0] as { status_id: string | null } | undefined;
    return row?.status_id ?? null;
  }

  /** The status a record was at before its most recent move — what "reject and restore" needs
   *  (QNEW-77 AC2). Returns null when the record has no recorded history. */
  async previousStatusId(tx: Tx, entity: StatusEntity, id: string): Promise<string | null> {
    const row = (await tx.execute(sql`
      select from_status_id from status_logs
      where entity_type = ${entity} and entity_id = ${id}::uuid
      order by created_at desc limit 1`))[0] as { from_status_id: string | null } | undefined;
    return row?.from_status_id ?? null;
  }

  /** Full movement history of one record, oldest first — the data behind time-in-status. */
  async history(tx: Tx, entity: StatusEntity, id: string) {
    return tx.execute(sql`
      select l.created_at, l.status_domain, l.changed_by, u.full_name as changed_by_name,
             fi.code as from_code, ti.code as to_code
      from status_logs l
      left join users u on u.id = l.changed_by
      left join item_statuses fi on fi.id = l.from_status_id and l.status_domain = 'item'
      left join item_statuses ti on ti.id = l.to_status_id   and l.status_domain = 'item'
      where l.entity_type = ${entity} and l.entity_id = ${id}::uuid
      order by l.created_at asc`);
  }
}
