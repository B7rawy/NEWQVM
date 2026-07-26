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

export type ActionOutcome = "ok" | "failed" | "skipped";

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
  run(
    tx: Tx,
    ctx: { tenantId: string | null; userId: string | null; environment: string },
    entity: string,
    id: string,
    params: Record<string, unknown>,
  ): Promise<ActionResult>;
}

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
    let result: ActionResult;

    if (!def) {
      result = { outcome: "failed", detail: `this server does not know the action '${cfg.action}'` };
    } else if (!def.entities.includes(entity as "rfq")) {
      result = { outcome: "skipped", detail: `does not apply to a ${entity.replace(/_/g, " ")}` };
    } else {
      try {
        result = await def.run(tx, ctx, entity, id, cfg.params ?? {});
      } catch (e) {
        result = { outcome: "failed", detail: (e as Error).message.slice(0, 300) };
      }
    }

    await tx.execute(sql`
      insert into workflow_action_runs
        (tenant_id, environment, entity_type, entity_id, transition_key, action, params,
         outcome, detail, actor_user_id)
      values (${ctx.tenantId}::uuid, ${ctx.environment}::environment_type, ${entity}::entity_type,
              ${id}::uuid, ${transitionKey}, ${cfg.action}, ${JSON.stringify(cfg.params ?? {})}::jsonb,
              ${result.outcome}, ${result.detail},
              ${ctx.automatic ? null : ctx.userId}::uuid)`);
  }
}
