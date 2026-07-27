import { sql } from "drizzle-orm";
import type { Tx } from "../../db/db.service.js";

/**
 * WHAT A MOVE DOES — QNEW-90 items 3 and 4.
 *
 * A rules engine that can only permit and refuse is half an engine: it can decide, but it cannot
 * have a consequence. An action is that consequence — something the engine does for you the moment
 * a record arrives somewhere, so a person does not have to remember to.
 *
 * CODE-DEFINED, like the gates and for the same reason: an admin picking "put it on hold" from a
 * list cannot write something that is wrong, slow, or reaches into another tenant's data.
 *
 * ONLY THREE SHIP, AND THE OMISSIONS ARE THE POINT.
 * `notify` and `webhook` are deliberately absent. NotificationsService records an attempt and
 * dispatches nothing — there is no provider behind it — so a "send an email" action would give you
 * a catalog that records intentions and delivers none of them. That is precisely the defect the
 * previous ticket identified in `requires_approval` being drawn as a padlock that enforced nothing,
 * and repeating it knowingly would be worse. A webhook has the mirror problem: firing outbound HTTP
 * from inside the business transaction means a rollback leaves the receiver believing something
 * happened. Both wait for real delivery rather than shipping as theatre.
 */

/**
 * `capped` is the fourth because it is a different fact from the other three: the action applied and
 * would have changed the record, and it was refused for volume rather than for fit. 0058 has the
 * full argument for why it is not 'skipped' with a note in `detail`.
 */
export type ActionOutcome = "ok" | "failed" | "skipped" | "capped";

export interface ActionResult {
  outcome: ActionOutcome;
  /** One sentence, written for the run log a human will read when something looks wrong. */
  detail: string;
}

export interface ActionParam {
  key: string;
  labelEn: string;
  type: "text" | "number" | "enum";
  options?: string[];
  default?: unknown;
}

export interface ActionDef {
  key: string;
  labelEn: string;
  labelAr: string;
  helpEn: string;
  params: ActionParam[];
  entities: Array<"rfq" | "rfq_item" | "order" | "order_item">;
  /**
   * How many of THIS kind of action one workspace may run in a day before the engine starts refusing
   * them. Per kind rather than one shared number because the kinds do not cost the same thing — see
   * DEFAULT_DAILY_CAP below for what the ceiling is actually measuring.
   */
  dailyCap?: number;
  run(
    tx: Tx,
    ctx: { tenantId: string | null; userId: string | null; environment: string },
    entity: string,
    id: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult>;
}

/**
 * THE DAILY CEILING — QNEW-90 item 9.
 *
 * A cap is containment, not metering: nothing here is billed or sold, and no workspace is meant to
 * feel it in normal trading. It is here so that a flow which has started running away — a loop
 * somebody drew, a condition that matches every record, an action wired onto an arrow every order
 * crosses — hits a wall inside one day instead of writing until a person happens to notice.
 *
 * WHAT THE NUMBERS MEASURE: who pays for the action. The benchmark this came from gives its cheap
 * channels 10,000 a day and email 500, and the reason is not that email is slow — it is that each
 * email lands on somebody. Our three kinds split the same way:
 *
 *   set_field      10,000 — one UPDATE on one row of one record. Nothing outside the database ever
 *                           learns it happened, so the only thing a runaway costs is writes.
 *   unlock_record   2,000 — writes to the queue a person works from, but only ever REMOVES from it,
 *                           so a runaway is noise rather than a flood. Still an order of magnitude
 *                           below set_field, because it resolves something a reviewer may be
 *                           part-way through deciding.
 *   lock_record       500 — every success puts an item in front of a human being and stops a record
 *                           moving until they clear it. 500 unexplained holds in one day is already
 *                           a crisis; 10,000 would be the engine mounting a denial of service
 *                           against the workspace's own staff. Human-scaled, like email, and for
 *                           exactly the same reason: the scarce resource is attention.
 *
 * NOT CONFIGURABLE PER WORKSPACE, deliberately. A ceiling somebody can raise needs a screen, a rule
 * about who may raise it and an audit trail of who did — none of which the ticket asks for, all of
 * which would be governance built on top of containment. When a workspace legitimately outgrows a
 * number, the number changes here and ships, which is a code review rather than a click.
 */
export const DEFAULT_DAILY_CAP = 500;

/**
 * The ceiling in force for one kind of action.
 *
 * The default is the LOWEST of the three on purpose. An action added later that forgets to declare a
 * cap should fail toward containment: being told "this workspace has used its allowance" is a
 * conversation, whereas inheriting 10,000 silently is the runaway the cap exists to prevent.
 */
export const dailyCapOf = (def: ActionDef): number => def.dailyCap ?? DEFAULT_DAILY_CAP;

/** The columns an action may write, per entity. A curated list, not "any column". */
const WRITABLE: Record<string, Array<{ key: string; labelEn: string; column: string; table: string }>> = {
  rfq: [
    { key: "shipping_type", labelEn: "Shipping type", column: "shipping_type", table: "rfqs" },
    { key: "model", labelEn: "Vehicle model", column: "model", table: "rfqs" },
  ],
  order: [
    { key: "client_po", labelEn: "Customer PO number", column: "client_po", table: "orders" },
  ],
};

export const ACTIONS: ActionDef[] = [
  {
    key: "set_field",
    labelEn: "Fill in a field",
    labelAr: "املأ حقلاً",
    helpEn:
      "Writes a value on the record when it gets here, so nobody has to remember to type it. Only " +
      "fields on this list can be written.",
    params: [
      { key: "field", labelEn: "Field", type: "enum", options: ["shipping_type", "model", "client_po"] },
      { key: "value", labelEn: "Value", type: "text" },
    ],
    entities: ["rfq", "order"],
    dailyCap: 10_000,
    async run(tx, _ctx, entity, id, params) {
      const spec = (WRITABLE[entity] ?? []).find((w) => w.key === String(params.field ?? ""));
      // An unknown field is a configuration error, not a runtime one — say which, and do nothing.
      if (!spec)
        return { outcome: "failed", detail: `'${String(params.field)}' is not a field this action may write` };
      await tx.execute(sql`
        update ${sql.raw(spec.table)} set ${sql.raw(spec.column)} = ${String(params.value ?? "")},
               updated_at = now()
        where id = ${id}::uuid`);
      return { outcome: "ok", detail: `set ${spec.labelEn} to “${String(params.value ?? "")}”` };
    },
  },

  {
    key: "lock_record",
    labelEn: "Put it on hold",
    labelAr: "علّقه",
    helpEn:
      "Stops the record moving any further until somebody releases it. Use it where work must pause " +
      "for a person to look, rather than for a rule that can be written down.",
    params: [{ key: "reason", labelEn: "Why it is on hold", type: "text", default: "held by the workflow" }],
    entities: ["rfq", "rfq_item", "order", "order_item"],
    dailyCap: 500,
    async run(tx, ctx, entity, id, params) {
      // Reuses the exception FREEZE rather than inventing a second kind of hold — one mechanism
      // means one place to look when something will not move. It does NOT reuse the cancellation
      // KIND: the inbox renders an open exception with a "Cancel it" button, so a hold filed as a
      // cancellation would be a request nobody made, one click from ending a live order (0057).
      const open = (await tx.execute(sql`
        select kind from workflow_exceptions
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${ctx.environment}::environment_type
          and entity_type = ${entity}::entity_type and entity_id = ${id}::uuid and status = 'open'
        limit 1`))[0] as { kind: string } | undefined;
      // Already frozen either way, so adding a second row would only give a reviewer two things to
      // clear — but say WHICH, because "a decision is pending" and "on hold" need different actions.
      if (open)
        return {
          outcome: "skipped",
          detail: open.kind === "hold" ? "it is already on hold" : `a ${open.kind} decision is already pending on it`,
        };

      const [cur] = (await tx.execute(sql`
        select status_id from ${sql.raw(
          entity === "rfq" ? "rfqs" : entity === "rfq_item" ? "rfq_items"
          : entity === "order" ? "orders" : "order_items",
        )} where id = ${id}::uuid`)) as Array<{ status_id: string | null }>;

      await tx.execute(sql`
        insert into workflow_exceptions
          (tenant_id, environment, entity_type, entity_id, kind, status, reason,
           requested_by, requested_by_name, restore_status_id)
        values (${ctx.tenantId}::uuid, ${ctx.environment}::environment_type, ${entity}::entity_type,
                ${id}::uuid, 'hold', 'open', ${String(params.reason ?? "held by the workflow")},
                ${ctx.userId}::uuid, 'the workflow',
                ${cur?.status_id ?? null}::uuid)`);
      return { outcome: "ok", detail: "put on hold — it will not move until somebody decides" };
    },
  },

  {
    key: "unlock_record",
    labelEn: "Take it off hold",
    labelAr: "ارفع التعليق",
    helpEn:
      "Releases a record the workflow put on hold earlier, so it can carry on. It will not touch a " +
      "cancellation or a return — those are somebody's request, and only a person may answer them.",
    params: [],
    entities: ["rfq", "rfq_item", "order", "order_item"],
    dailyCap: 2_000,
    async run(tx, ctx, entity, id) {
      // `and kind = 'hold'` is the whole point of this clause. Without it the action released
      // whatever exception was open, so an automatic release could quietly refuse a customer's real
      // cancellation request and file the engine as the reason it was turned down.
      const done = (await tx.execute(sql`
        update workflow_exceptions
           set status = 'released', resolved_at = now(), resolved_by = ${ctx.userId}::uuid,
               resolved_by_name = 'the workflow',
               resolution_note = 'released by the workflow', updated_at = now()
         where tenant_id = ${ctx.tenantId}::uuid and environment = ${ctx.environment}::environment_type
           and entity_type = ${entity}::entity_type and entity_id = ${id}::uuid
           and status = 'open' and kind = 'hold'
        returning id`)) as Array<{ id: string }>;
      return done.length
        ? { outcome: "ok", detail: "taken off hold" }
        : { outcome: "skipped", detail: "it was not on hold" };
    },
  },
];

const BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));
export const actionByKey = (k: string) => BY_KEY.get(k);

export interface ActionConfig { action: string; params?: Record<string, unknown> }

/**
 * Has this workspace used up today's allowance for this kind of action? Returns the row to record if
 * it has, and null if there is room.
 *
 * COUNTED OFF THE RUN LOG, NOT OFF A COUNTER ROW. `order_number_counters` plus next_order_number()
 * is the house precedent for a per-tenant counter, and it was the wrong model to copy here:
 *
 *   - An order number MUST be exact and gapless, so paying for a serialised counter is the price of
 *     correctness. A containment ceiling does not need to be exact to the row; it needs to stop a
 *     runaway inside a day.
 *   - That price is a lock convoy. An upsert on one counter row takes a row lock held until the
 *     surrounding BUSINESS transaction commits — so every automated action of the same kind in the
 *     workspace would queue behind the slowest status move in it. Order numbers are minted once per
 *     order; actions fire on every arrow of every record, which is exactly where that hurts.
 *   - A counter is a second place the same truth lives. The log is what a person reads when they ask
 *     "what has the engine been doing"; if the number that enforced the cap came from somewhere else,
 *     the two could disagree, and the log would be the one that looked wrong.
 *
 * WHAT IT COSTS INSTEAD: the count is exact only up to concurrency. Two transactions can each see
 * 499 of 500 and both proceed, because neither sees the other's uncommitted row, so a busy workspace
 * may overshoot by roughly the number of moves in flight. For a ceiling whose job is containment
 * that is the right trade — overshooting by a handful is invisible, whereas serialising the engine
 * behind one row would be felt on every click. The index from 0058 keeps the count bounded to today's
 * rows of one kind, and capped rows are excluded from it, so a flow that keeps hammering the wall
 * does not make the next check more expensive.
 *
 * WHICH ROWS SPEND ALLOWANCE: 'ok' and 'failed'. Not 'skipped' — the action declined itself, nothing
 * happened, and a flow whose records are all already on hold would otherwise burn its budget on
 * refusals and then start capping the real holds. Not 'capped' either, or a refusal would consume the
 * thing it was refused for, and the log could no longer reconstruct the number that was enforced. A
 * failure DOES spend: it connected, it tried, it may well have written something before it broke, and
 * a rule failing ten thousand times a day is precisely the runaway this ceiling exists to contain.
 *
 * WHERE THE DAY STARTS: midnight in the workspace's own business-calendar timezone
 * (business_calendar_settings, one row per tenant), falling back to 'Asia/Riyadh' — which is both the
 * column's default and the same fallback InfraService.load() already uses when a workspace has never
 * saved a calendar, and no workspace has. So in practice today the boundary is midnight in Riyadh,
 * for a Saudi product, rather than 3am local from a UTC day.
 *
 * The join to pg_timezone_names is not decoration: `at time zone` raises on a name postgres does not
 * know, and this statement runs inside a person's status move. Nothing in the API can write that
 * column today — InfraService.setSettings() only writes working_days — but a hand-fix on a live
 * database is exactly how such a value arrives, and the join makes an unrecognised one fall back to
 * the default instead of aborting the move. There is deliberately no try/catch around the call: after
 * a failed statement postgres refuses the rest of the transaction, so a catch could not deliver what
 * it appeared to promise ("never mind, run the action anyway"). The statement is written so that it
 * cannot raise instead.
 *
 * `now()` is the transaction timestamp, and so is the `ran_at` default on the row inserted below —
 * which means a move that straddles midnight is measured against, and counted into, the same day.
 */
async function refuseOverDailyCap(
  tx: Tx,
  ctx: { tenantId: string | null; environment: string },
  def: ActionDef,
): Promise<ActionResult | null> {
  const cap = dailyCapOf(def);
  const [row] = (await tx.execute(sql`
    with zone as (
      select coalesce(
        (select n.name from business_calendar_settings b
           join pg_timezone_names n on n.name = b.timezone
          where b.tenant_id = ${ctx.tenantId}::uuid),
        'Asia/Riyadh') as name
    )
    select count(*)::int as used
      from workflow_action_runs r, zone z
     where r.tenant_id = ${ctx.tenantId}::uuid
       and r.environment = ${ctx.environment}::environment_type
       and r.action = ${def.key}
       and r.outcome in ('ok', 'failed')
       and r.ran_at >= (date_trunc('day', now() at time zone z.name) at time zone z.name)`)) as
    Array<{ used: number }>;
  const used = row?.used ?? 0;
  if (used < cap) return null;
  // Says the number, the ceiling and what it means for THIS record, because the reader of this line
  // is somebody wondering why a rule they configured stopped having an effect halfway through a day.
  return {
    outcome: "capped",
    detail:
      `daily limit reached — this workspace has already run ${used} of its ${cap} “${def.labelEn}” ` +
      `actions today, so this one did not run. The record still moved.`,
  };
}

/**
 * Run every action configured on a move, and record what each one did.
 *
 * NOTHING HERE MAY THROW. The move has already happened and been judged legitimate; an action that
 * cannot complete is a problem with the action, not with the business event that triggered it.
 * Failing the caller's request because a follow-up did not work would mean a person's correct click
 * gets an error, and the order does not move — the worst of both.
 *
 * So every failure is caught and written to the run log instead, which is the whole reason the run
 * log exists: an action whose failure is invisible is worse than no action, because the flow looks
 * configured and quietly is not.
 */
export async function runActions(
  tx: Tx,
  ctx: { tenantId: string | null; userId: string | null; environment: string; automatic: boolean },
  entity: string,
  id: string,
  transitionKey: string,
  configs: ActionConfig[],
): Promise<void> {
  for (const cfg of configs) {
    const def = actionByKey(cfg.action);
    const applies = def?.entities.includes(entity as "rfq") ?? false;
    // Asked only of an action that was actually going to do something. An action that does not apply
    // to this record would have changed nothing anyway, so refusing it for volume would report a
    // ceiling problem where there is a configuration one — and would spend a check on nothing.
    const refusal = def && applies ? await refuseOverDailyCap(tx, ctx, def) : null;
    let result: ActionResult;

    if (!def) {
      result = { outcome: "failed", detail: `this server does not know the action '${cfg.action}'` };
    } else if (!applies) {
      result = { outcome: "skipped", detail: `does not apply to a ${entity.replace(/_/g, " ")}` };
    } else if (refusal) {
      // Blocked, and recorded — the row below is the whole point. An action the engine silently
      // declined to run would leave a flow that has stopped having its configured effect with nothing
      // anywhere saying why. It does NOT fail the caller: the move has already happened and been
      // judged legitimate, and a ceiling on follow-up work is not a reason to refuse a correct click.
      result = refusal;
    } else {
      try {
        result = await def.run(tx, ctx, entity, id, cfg.params ?? {});
      } catch (e) {
        result = { outcome: "failed", detail: (e as Error).message.slice(0, 300) };
      }
    }

    // `auto_advanced` is recorded rather than inferred from the null actor. The inference held —
    // only an automatic move writes a null here — but it made the run log unable to say the engine
    // did something: an action fired by an automatic move rendered as "no signed-in user" one line
    // under the move that rendered correctly as "the workflow". One act, named two ways, and the
    // wrong name meaning nobody was logged in (0059).
    await tx.execute(sql`
      insert into workflow_action_runs
        (tenant_id, environment, entity_type, entity_id, transition_key, action, params,
         outcome, detail, actor_user_id, auto_advanced)
      values (${ctx.tenantId}::uuid, ${ctx.environment}::environment_type, ${entity}::entity_type,
              ${id}::uuid, ${transitionKey}, ${cfg.action}, ${JSON.stringify(cfg.params ?? {})}::jsonb,
              ${result.outcome}, ${result.detail},
              ${ctx.automatic ? null : ctx.userId}::uuid, ${ctx.automatic})`);
  }
}
