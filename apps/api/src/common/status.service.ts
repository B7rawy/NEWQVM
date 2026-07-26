import { BadRequestException, ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/db.service.js";
import { envOf, type Environment } from "./env-guards.js";
import { runGates, type GateConfig, type GateFailure } from "../modules/workflow/gates.js";
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
            frozenBy.kind === "cancellation"
              ? "a cancellation is being reviewed for this order, so it cannot move until that is decided"
              : "a return is being reviewed for this line, so it cannot move until that is decided",
          frozenBy: frozenBy.kind,
          reason: frozenBy.reason,
        });
    }

    const moving = before.filter((b) => b.status_id !== toStatusId);

    // ── the guard: is this move one the workspace's workflow actually permits? ──
    /** Gates that were waived on this move, so the log can say what was let through and why. */
    const overridden = await this.assertTransitionAllowed(
      tx, ctx, spec, input.entity, moving, toStatusId, input.toCode,
    );

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
                                   override_reason, overridden_gates, auto_advanced)
          values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${input.entity}, ${m.id}::uuid, ${spec.domain},
                  ${m.status_id}::uuid, ${toStatusId}::uuid,
                  ${(ctx.autoDepth ?? 0) > 0 ? null : ctx.userId}::uuid,
                  ${overridden.length ? (ctx.overrideReason ?? null) : null},
                  ${overridden.length ? JSON.stringify(overridden.map((f) => f.gate)) : null}::jsonb,
                  ${(ctx.autoDepth ?? 0) > 0})`);
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
   * Is this record frozen by an open cancellation or return?
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
        and (
          (entity_type = ${entity} and entity_id = ${id}::uuid)
          ${parent && parentType
            ? sql`or (entity_type = ${parentType} and entity_id = (${parent}))`
            : sql``}
        )
      limit 1`))[0] as { kind: string; reason: string } | undefined;
    return row ?? null;
  }

  private async assertTransitionAllowed(
    tx: Tx,
    ctx: StatusContext,
    spec: { table: string; domain: "item" | "vendor" },
    entity: StatusEntity,
    moving: Array<{ id: string; status_id: string | null }>,
    toStatusId: string,
    toCode: string,
  ): Promise<GateFailure[]> {
    const waived: GateFailure[] = [];
    if (moving.length === 0 || !ctx.tenantId) return waived;

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
        select allowed_roles, handoff, gates, condition, priority, requires_approval
        from workflow_transitions
        where flow_id = ${flowId}::uuid and from_step_id = ${fromStep.id}::uuid and to_step_id = ${toStep.id}::uuid
        order by priority desc, created_at asc`)) as Array<{
        allowed_roles: string[] | null; handoff: string;
        gates: GateConfig[] | null; condition: Condition | null; priority: number;
        requires_approval: boolean;
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
        const granted = (await tx.execute(sql`
          select id from approval_requests
          where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
            and entity_type = ${entity} and entity_id = ${m.id}::uuid
            and transition_key = ${key}
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
              and transition_key = ${key} and overall_status = 'pending'
            limit 1`))[0] as { id: string } | undefined;

          throw new ApprovalRequiredException(
            key,
            pending?.id ?? null,
            pending ? "already waiting for sign-off" : "this move needs sign-off before it can happen",
          );
        }
      }

      // ── custody: who is holding this record now that it has moved ────────────────────────
      // The flow says what SHOULD happen to responsibility on this arrow; this records what did.
      //   pool  — release it to the destination step's owners (the default: a move usually means
      //           the work has left your desk)
      //   keep  — the current holder keeps it
      //   actor — whoever just made the move takes it on
      // A pooled record with exactly ONE possible owner is auto-assigned: leaving it "unclaimed"
      // when there is only one candidate is busywork, not governance.
      const toOwners = ((toStep.owner_roles ?? []) as string[]);
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
      const due = toStep.sla_hours
        ? sql`now() + ${`${toStep.sla_hours} hours`}::interval`
        : sql`null::timestamptz`;

      // ON CONFLICT DO UPDATE, not DO NOTHING: the row is now living state that must follow the
      // record, not a write-once pin. flow_id is deliberately NOT updated — a record stays bound to
      // the version it entered, which is the guarantee that publishing a new version cannot strand it.
      await tx.execute(sql`
        insert into workflow_record_state (tenant_id, environment, entity_type, entity_id, status_domain,
                                           flow_id, assignee_user_id, assignee_role, step_entered_at, due_at)
        values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${entity}, ${m.id}::uuid, ${spec.domain},
                ${flowId}::uuid, ${assignee}::uuid, ${assigneeRole}, now(), ${due})
        on conflict (tenant_id, environment, entity_type, entity_id) do update
          set assignee_user_id = excluded.assignee_user_id,
              assignee_role    = excluded.assignee_role,
              step_entered_at  = excluded.step_entered_at,
              due_at           = excluded.due_at,
              updated_at       = now()`);
    }

    return waived;
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
          const already = (await tx.execute(sql`
            select 1 from workflow_auto_fired
            where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
              and entity_type = ${entity} and entity_id = ${id}::uuid and transition_key = ${key}
            limit 1`))[0];
          if (already) continue;
        }

        const failures = await runGates(tx, entity, id, (c.gates ?? []) as GateConfig[]);
        // an automatic move never overrides anything: nobody is there to give a reason
        if (failures.length) continue;

        try {
          if (c.auto_once) {
            await tx.execute(sql`
              insert into workflow_auto_fired
                (tenant_id, environment, entity_type, entity_id, transition_key)
              values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${entity}, ${id}::uuid, ${key})
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
