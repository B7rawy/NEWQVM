import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "../../db/db.service.js";
import type { Environment } from "../../common/env-guards.js";
import type { NotificationsService } from "../notifications/notifications.service.js";
import { validateWebhookUrl } from "./webhook-url.js";

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
 * `notify` WAITED FOR A CHANNEL THAT REALLY DELIVERS, AND NOW HAS ONE.
 * It was withheld from the first three because NotificationsService.send() records an attempt and
 * dispatches nothing — there is no SMTP client and no WhatsApp app behind it — so a "send an email"
 * action would have given the catalog an entry that records intentions and delivers none of them.
 * Migration 0061 changed the fact rather than the story: in-app delivery has no provider to be
 * missing, so the row this action writes is read back by this same application on a screen the
 * recipient already has open. That is why it ships now and did not ship then.
 *
 * `webhook` WAITED FOR AN ANSWER TO TWO OBJECTIONS, AND NOW HAS BOTH.
 *
 * THE FIRST WAS ORDERING. Firing outbound HTTP from inside the business transaction tells the
 * receiver something happened and then lets the transaction roll back — the receiver has booked a
 * shipment against an order that does not exist, and nothing here knows. Migration 0064 answers it
 * by construction rather than by care: the action WRITES A ROW to workflow_webhook_outbox in the
 * caller's own transaction and sends nothing, so a rollback takes the row with it and there is
 * nothing left to deliver. A separate dispatcher sends what committed.
 *
 * THE SECOND WAS THAT THIS IS THE FIRST OUTBOUND REQUEST IN THE SYSTEM WHOSE DESTINATION A USER
 * CHOOSES. There is exactly one other outbound call in the whole codebase (common/ai.service.ts, to
 * a hostname written in the source). A webhook whose URL comes from a workflow definition, issued
 * from a process that can reach the database, the other services on the box and the cloud metadata
 * endpoint, is a "fetch any URL for me" primitive handed to whoever can edit a flow. webhook-url.ts
 * is the answer, and it is deliberately a separate file with a separate test: https only, a public
 * address only, judged at SEND time against what the name actually resolves to, connected to that
 * same address, and no redirects.
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

/**
 * Everything an action needs from the outside world that is not the database.
 *
 * ONE MEMBER TODAY, AND IT IS A BOUNDARY RATHER THAN A CONVENIENCE. `notify` must not write
 * in_app_notifications itself: NotificationsService is the single side-effect boundary (ADR-0004 /
 * CONVENTIONS §BE-3), and it is what also writes the notification_log row, so "what was this
 * workspace told, and when" keeps ONE answer instead of two half-answers. An action reaching past it
 * would deliver a notification that the communications audit trail has never heard of.
 *
 * Passed as its own argument rather than folded into `ctx` because ctx is data about the run — it is
 * logged, compared and reasoned about — and a live service handle is neither.
 */
export interface ActionDeps {
  notifications: NotificationsService;
}

/** What the engine knows about the move that is causing this action. */
export interface ActionRunContext {
  tenantId: string | null;
  userId: string | null;
  environment: Environment;
  /**
   * Was there a person behind the move, or did the engine make it on its own? `notify` is the first
   * action that has to care: telling somebody what they have just done themselves is how an inbox
   * teaches people to ignore it, but an automatic move was not done by the actor at all, so the same
   * suppression there would silence a message nobody was ever told.
   */
  automatic: boolean;
  /**
   * The arrow that fired this action, as "from_code>to_code".
   *
   * IT IS THE ONLY WAY TO KNOW WHERE THE RECORD IS GOING. Actions run inside the guard, before the
   * status column is written — which is deliberate, and is what lets `lock_record` capture the
   * status to restore a record to. The cost is that reading status_id off the row gives the status
   * the record is LEAVING. `notify` needs the opposite: a message saying "it is now …" that named
   * the status it just left would be wrong in the one word the reader cares about.
   */
  transitionKey: string;
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
    ctx: ActionRunContext,
    entity: string,
    id: string,
    params: Record<string, unknown>,
    deps: ActionDeps,
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
 * email lands on somebody. Our five kinds split the same way:
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
 *   notify            500 — the benchmark's own email number, because it is the same expenditure:
 *                           a notification lands on a person and asks for a moment of their day.
 *                           Deliberately equal to lock_record rather than higher — an unread badge
 *                           that never empties is a queue nobody works, which costs the workspace
 *                           exactly what a pile of unexplained holds costs it.
 *   webhook        10,000 — the benchmark's cheap-channel number, and it belongs at that end for the
 *                           reason the whole scale is built on: A WEBHOOK LANDS ON A MACHINE. Ten
 *                           thousand HTTP requests spread over a day is a rounding error to a
 *                           receiver built to take them, whereas ten thousand notifications is a
 *                           person's inbox destroyed. It is not free — each one is a queued delivery
 *                           a dispatcher will attempt, and retry — which is why it is a ceiling at
 *                           all rather than no limit; but the scarce resource here is somebody
 *                           else's bandwidth, not somebody's attention, and those are three orders
 *                           of magnitude apart.
 *
 *                           WHAT THE CEILING COUNTS IS DELIVERIES QUEUED, NOT DELIVERIES MADE. A
 *                           delivery that fails and is retried five times is one action run against
 *                           the allowance, because the ceiling is measuring what a FLOW did and the
 *                           retries are the dispatcher's business. The dispatcher records its own
 *                           outcomes under a different key (`webhook_delivery`) precisely so a run
 *                           of failures cannot silently halve the cap a workspace configured.
 *
 * WHAT THE CEILING COUNTS IS ACTION RUNS, NOT PEOPLE TOLD. One `notify` addressed to a step owned by
 * six people is one run against the allowance. That is the right unit: the ceiling exists to stop a
 * FLOW running away, and a flow fires once per move however many desks the step happens to have.
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

/**
 * ── WHAT AN ACTION MAY SAY ABOUT A RECORD, AND HOW IT READS IT ───────────────────────────────────
 *
 * How to read one record well enough to describe it, per entity kind. A CURATED map, exactly like
 * WRITABLE above and for the same reason: the alternative is letting an admin name a column, and a
 * template that can name any column is a way to read any column — including the cost fields a
 * workshop user must never see — out through a channel that then persists it.
 *
 * TWO ACTIONS READ IT NOW, AND THE SECOND ONE IS WHY THE CURATION MATTERS MOST. `notify` puts these
 * facts on a screen inside this product, where the reader is at least somebody with an account.
 * `webhook` puts them in a POST body that leaves the building for an address a workspace admin
 * chose. Anything reachable through this map is therefore something we have decided is safe to hand
 * to a third party, which is exactly the decision a "name any column" design would be making by
 * accident, once, on somebody's behalf.
 *
 * The expressions are interpolated with sql.raw, so nothing in this map may ever come from a
 * request. Every value here is a literal written in this file.
 */
const RECORD_FACTS: Record<string, { table: string; reference: string; part: string; page: string }> = {
  rfq: { table: "rfqs", reference: "r.order_number", part: "null", page: "/rfqs" },
  rfq_item: {
    table: "rfq_items",
    reference: "(select order_number from rfqs where id = r.rfq_id)",
    part: "r.part_number",
    page: "/rfqs",
  },
  order: { table: "orders", reference: "r.order_number", part: "null", page: "/orders" },
  order_item: {
    table: "order_items",
    reference: "(select order_number from orders where id = r.order_id)",
    // The order line's part number is `final_part_number`; `part_number` is the REQUESTED one and
    // lives on rfq_items. Naming the wrong one here would put a part in the message that nobody is
    // actually sourcing.
    part: "r.final_part_number",
    page: "/orders",
  },
};

/**
 * The only placeholders a message may contain.
 *
 * NEVER ARBITRARY INTERPOLATION. The substitution below replaces exactly these three tokens and
 * leaves every other brace pair as literal text, so a template cannot be turned into an expression,
 * a column name, or a way to probe what the engine knows. An admin who types {cost} gets the word
 * "{cost}" in the notification — visibly wrong, which is the correct failure for a typo, rather
 * than quietly wrong or quietly dangerous.
 */
const NOTIFY_FIELDS = ["reference", "status", "part"] as const;
type NotifyFacts = Record<(typeof NOTIFY_FIELDS)[number], string | null>;

const fillPlaceholders = (text: string, facts: NotifyFacts): string =>
  text.replace(/\{(reference|status|part)\}/g, (_whole, key: string) => facts[key as keyof NotifyFacts] ?? "—");

/**
 * Who a `notify` may be addressed to, relative to the record rather than to a name.
 *
 * `assignee` and `step_owners` are the two facts the engine keeps about responsibility; the review
 * comment's "Owner" is the first and the desk behind it is the second.
 */
const NOTIFY_AUDIENCES = ["assignee", "step_owners", "assignee_and_step_owners"] as const;

/**
 * The review comment's other two relative recipients — "Created By / Modified By" — read straight
 * off the record's own audit columns, which set_row_audit() maintains on every tenant table.
 *
 * A SECOND PARAMETER RATHER THAN MORE OPTIONS ON THE FIRST, because these are additive: "tell the
 * desk, and also tell whoever raised it" is the sentence people actually say, and folding it into
 * one enum would need an option per combination. The param editor renders enums as a single select,
 * so two selects is what a union looks like in the UI this catalog already has.
 */
const NOTIFY_ORIGINATORS: Record<string, { column: string; why: string }> = {
  created_by: { column: "created_by", why: "raised it" },
  modified_by: { column: "updated_by", why: "last changed it" },
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

  {
    key: "notify",
    labelEn: "Tell somebody",
    labelAr: "أبلغ شخصاً",
    helpEn:
      "Puts a notification in somebody's inbox the moment the record gets here. Who gets it is " +
      "worked out from the record itself — whoever is holding it, or whoever is responsible for " +
      "this step — so it keeps being right after the people change.",
    params: [
      {
        key: "to",
        labelEn: "Who to tell",
        type: "enum",
        options: [...NOTIFY_AUDIENCES],
        default: "assignee_and_step_owners",
      },
      {
        key: "alsoTell",
        labelEn: "Also tell",
        type: "enum",
        options: ["nobody", ...Object.keys(NOTIFY_ORIGINATORS)],
        default: "nobody",
      },
      { key: "title", labelEn: "Headline", type: "text", default: "{reference} needs you" },
      { key: "message", labelEn: "Message", type: "text", default: "It is now {status}." },
    ],
    entities: ["rfq", "rfq_item", "order", "order_item"],
    dailyCap: 500,
    /**
     * RECIPIENTS ARE RESOLVED AT RUN TIME FROM THE RECORD, which is the whole point of the review
     * comment this implements. A flow that named user ids would be correct on the day it was drawn
     * and wrong the first time somebody changed desks — and, worse, would go on delivering to them
     * silently, so the message would look sent and be useless. The two relative audiences are the
     * two facts the engine already keeps about responsibility:
     *
     *   assignee     — workflow_record_state.assignee_user_id, the person actually holding it.
     *   step_owners  — everyone holding a role in the destination step's owner_roles. This is the
     *                  POOL: the record has arrived at a desk and nobody has picked it up yet, which
     *                  is precisely the moment a notification is worth sending.
     *
     * The step is looked up through the record's own flow binding rather than through today's
     * default flow, so a record executing an older version is described by the version it is on.
     *
     * The review comment's other two — Created By and Modified By — sit ALONGSIDE those, as the
     * `alsoTell` parameter, and come off the record's own audit columns.
     *
     * WHAT IS DELIBERATELY NOT OFFERED: a person named by email address. It cannot be built
     * honestly here. `users` carries a permissive policy of `app_is_internal() OR id =
     * app_user_id()`, so a workspace user's session can read exactly one row of it — their own —
     * and an email lookup would therefore resolve when platform staff happened to make the move and
     * silently resolve to nobody when a branch manager made the same move. A parameter that works
     * depending on who clicked is worse than an absent one: it looks configured, and is not. The
     * four relative recipients above need no `users` read at all, because every one of them is a
     * user id already sitting on a row this session may read.
     *
     * IT CANNOT THROW: runActions catches, but a message that fails to send must not be able to
     * unwind the move that caused it, so every miss below returns an outcome instead of raising.
     */
    async run(tx, ctx, entity, id, params, deps) {
      if (!ctx.tenantId)
        return { outcome: "failed", detail: "there is no workspace to deliver a notification in" };

      const audience = String(params.to ?? "assignee_and_step_owners");
      if (!(NOTIFY_AUDIENCES as readonly string[]).includes(audience))
        return { outcome: "failed", detail: `'${audience}' is not an audience this action understands` };
      const subject = RECORD_FACTS[entity];
      if (!subject) return { outcome: "failed", detail: `a ${entity.replace(/_/g, " ")} cannot be described` };

      const alsoTell = String(params.alsoTell ?? "nobody");
      if (alsoTell !== "nobody" && !NOTIFY_ORIGINATORS[alsoTell])
        return { outcome: "failed", detail: `'${alsoTell}' is not somebody this action can find` };

      // What the message is allowed to talk about, read once. created_by / updated_by ride along on
      // the same read because they are columns of the same row: the review comment's Created By and
      // Modified By are facts ABOUT THE RECORD rather than a lookup, which is exactly what makes
      // them resolvable under any actor's RLS session.
      const [record] = (await tx.execute(sql`
        select ${sql.raw(subject.reference)} as reference,
               ${sql.raw(subject.part)} as part,
               r.created_by, r.updated_by
        from ${sql.raw(subject.table)} r
        where r.id = ${id}::uuid`)) as Array<{
        reference: string | null; part: string | null;
        created_by: string | null; updated_by: string | null;
      }>;
      if (!record) return { outcome: "failed", detail: "the record was not there to describe" };

      // WHERE THE RECORD IS GOING, not where it has been. Taken from the arrow rather than from the
      // row, because the row's status column has not been written yet — see ActionRunContext. Both
      // the message and the owner lookup below depend on this being the DESTINATION: a message
      // naming the status just left is wrong in its only important word, and owner_roles read off
      // the origin step would notify the desk the work is leaving instead of the one taking it on.
      const toCode = ctx.transitionKey.split(">")[1] ?? "";
      const [destination] = (await tx.execute(sql`
        select id, label_en from item_statuses where code = ${toCode} limit 1`)) as Array<{
        id: string; label_en: string | null;
      }>;

      /** userId → why they were told, so the run log can say more than a number. */
      const recipients = new Map<string, string>();

      const wantsAssignee = audience === "assignee" || audience === "assignee_and_step_owners";
      const wantsOwners = audience === "step_owners" || audience === "assignee_and_step_owners";

      const [state] = (await tx.execute(sql`
        select assignee_user_id, flow_id from workflow_record_state
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${ctx.environment}::environment_type
          and entity_type = ${entity}::entity_type and entity_id = ${id}::uuid
        limit 1`)) as Array<{ assignee_user_id: string | null; flow_id: string }>;

      if (wantsAssignee && state?.assignee_user_id)
        recipients.set(state.assignee_user_id, "holding it");

      if (wantsOwners && state?.flow_id && destination) {
        const [step] = (await tx.execute(sql`
          select owner_roles from workflow_steps
          where flow_id = ${state.flow_id}::uuid
            and coalesce(item_status_id, vendor_status_id) = ${destination.id}::uuid
          limit 1`)) as Array<{ owner_roles: string[] | null }>;
        const roles = (step?.owner_roles ?? []) as string[];
        if (roles.length) {
          const holders = (await tx.execute(sql`
            select user_id from tenant_memberships
            where tenant_id = ${ctx.tenantId}::uuid and is_active
              and role::text in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})`)) as Array<{ user_id: string }>;
          for (const h of holders)
            if (!recipients.has(h.user_id)) recipients.set(h.user_id, "responsible for this step");
        }
      }

      if (alsoTell !== "nobody") {
        const origin = NOTIFY_ORIGINATORS[alsoTell];
        // NULL is an ordinary value here — a record written before the audit trigger existed, or by
        // a path with no signed-in user — and it is not a failure of this action. The rest of the
        // audience is still told; the run log says who was missing.
        const who = origin.column === "created_by" ? record.created_by : record.updated_by;
        if (who && !recipients.has(who)) recipients.set(who, origin.why);
      }

      if (recipients.size === 0)
        return {
          outcome: "skipped",
          detail: "there is nobody to tell — nothing is holding this record and the step names no roles",
        };

      // Somebody is never told what they have just done themselves. Only on a move a PERSON made:
      // an automatic move was not made by the actor, so suppressing there would silence the one
      // notification nobody could have known about. Same rule the approvals inbox applies, so the
      // product has one answer to "why did I not get told" rather than two.
      if (!ctx.automatic && ctx.userId && recipients.has(ctx.userId)) {
        recipients.delete(ctx.userId);
        if (recipients.size === 0)
          return { outcome: "skipped", detail: "the only person to tell is the one who made the move" };
      }

      const facts: NotifyFacts = {
        reference: record.reference,
        status: destination?.label_en ?? null,
        part: record.part,
      };
      // A blank headline is refused by the database (in_app_notifications_title_ck), and a refusal
      // here would read in the run log as a broken action rather than as an empty field somebody
      // left. Fall back instead, and let the message carry the detail.
      const title = fillPlaceholders(String(params.title ?? ""), facts).trim() || "A record needs your attention";
      const body = fillPlaceholders(String(params.message ?? ""), facts).trim() || undefined;

      for (const userId of recipients.keys()) {
        await deps.notifications.sendInApp(tx, {
          tenantId: ctx.tenantId,
          environment: ctx.environment,
          recipientUserId: userId,
          title,
          body,
          // The screen the record is actually on. A notification with no destination is a nag, and
          // /my-work would be a lie for anyone the message reached without holding the record.
          link: subject.page,
          kind: "workflow",
        });
      }

      const reasons = [...new Set(recipients.values())].join(" and ");
      return {
        outcome: "ok",
        detail: `told ${recipients.size} ${recipients.size === 1 ? "person" : "people"} (${reasons})`,
      };
    },
  },

  {
    key: "webhook",
    labelEn: "Call another system",
    labelAr: "أبلغ نظاماً آخر",
    helpEn:
      "Sends a signed message to another system when the record gets here, so it can react without " +
      "anybody re-typing anything. The address must be https. Nothing is sent until this move is " +
      "safely saved — if the move is refused, the other system is never told it happened.",
    params: [{ key: "url", labelEn: "Destination (https)", type: "text" }],
    entities: ["rfq", "rfq_item", "order", "order_item"],
    dailyCap: 10_000,
    /**
     * ITS ENTIRE JOB IS TO VALIDATE A DESTINATION AND WRITE ONE ROW. It does not open a socket, it
     * does not resolve a name, and it does not wait for anything — see the header of this file and
     * of migration 0064 for why sending from here would be wrong no matter how carefully it was
     * done. The row it writes lives or dies with the caller's transaction, which is the whole
     * guarantee: a receiver is only ever told about a move that really committed.
     *
     * IT CANNOT THROW. runActions catches, but a queued delivery must never be able to unwind the
     * move that caused it, so every miss below returns an outcome instead of raising. The INSERT is
     * the only statement here that could, and every value in it is either produced by this function
     * or already an enum-typed column of the row we just read — there is no user-supplied value in
     * it that has not been through validateWebhookUrl first. A try/catch would not help in any
     * case: after a failed statement postgres refuses the rest of the transaction, so a catch could
     * not deliver what it appeared to promise. The same reasoning refuseOverDailyCap sets out.
     *
     * THE DELIVERY ID IS MINTED HERE, NOT LEFT TO THE COLUMN DEFAULT, so that the same value can go
     * inside the payload as well as on the row. Only the body is covered by the signature, so a
     * delivery id that existed only as a header would be a value the receiver cannot trust — and
     * de-duplicating on an untrusted id is how a replayed request gets processed as a new one.
     */
    async run(tx, ctx, entity, id, params) {
      if (!ctx.tenantId) return { outcome: "failed", detail: "there is no workspace to send from" };

      const verdict = validateWebhookUrl(String(params.url ?? ""));
      // A bad destination is a configuration error rather than a runtime one, and it is refused
      // here — before a row exists — so the outbox never fills with deliveries that could not have
      // gone anywhere. The reason is quoted verbatim because the person reading the run log is the
      // person who typed the address.
      if (!verdict.ok) return { outcome: "failed", detail: `that destination was refused — ${verdict.reason}` };

      const subject = RECORD_FACTS[entity];
      if (!subject) return { outcome: "failed", detail: `a ${entity.replace(/_/g, " ")} cannot be described` };

      // One read for everything the payload says about the record, plus the workspace's own name and
      // the transaction timestamp. `now()` rather than a JavaScript clock so the `occurredAt` a
      // receiver sees is the SAME instant status_logs and workflow_action_runs recorded for this
      // move — three timestamps that disagree by milliseconds are three timestamps nobody can join.
      const [facts] = (await tx.execute(sql`
        select ${sql.raw(subject.reference)} as reference,
               ${sql.raw(subject.part)} as part,
               (select slug from tenants where id = ${ctx.tenantId}::uuid) as workspace,
               to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at
        from ${sql.raw(subject.table)} r
        where r.id = ${id}::uuid`)) as Array<{
        reference: string | null; part: string | null; workspace: string | null; occurred_at: string;
      }>;
      if (!facts) return { outcome: "failed", detail: "the record was not there to describe" };

      const [fromCode, toCode] = ctx.transitionKey.split(">");
      const deliveryId = randomUUID();
      // WHAT LEAVES THE BUILDING, in full. Everything here comes from RECORD_FACTS or from the move
      // itself; there is no way to widen it from a flow definition, which is the point — a payload
      // an admin could compose would be a way to post any column of any record to any address.
      const payload = {
        delivery: deliveryId,
        event: "workflow.transition",
        workspace: facts.workspace,
        environment: ctx.environment,
        occurredAt: facts.occurred_at,
        transition: { key: ctx.transitionKey, from: fromCode ?? null, to: toCode ?? null },
        // Whether a person made this move or the engine carried the record forward on its own. A
        // receiver that opens a ticket per event needs to know which, or an auto-advance chain
        // becomes three tickets nobody asked for.
        automatic: ctx.automatic,
        record: { type: entity, id, reference: facts.reference, part: facts.part },
      };

      await tx.execute(sql`
        insert into workflow_webhook_outbox
          (id, tenant_id, environment, entity_type, entity_id, transition_key, url, payload)
        values (${deliveryId}::uuid, ${ctx.tenantId}::uuid, ${ctx.environment}::environment_type,
                ${entity}::entity_type, ${id}::uuid, ${ctx.transitionKey},
                ${verdict.url.toString()}, ${JSON.stringify(payload)}::jsonb)`);

      // Says QUEUED, not sent, because that is what happened. A line claiming delivery here would be
      // wrong twice over: the move has not committed yet, and nothing has dialled anything. The
      // dispatcher writes its own line under `webhook_delivery` when the attempt actually resolves.
      return {
        outcome: "ok",
        detail:
          `queued a delivery to ${verdict.url.host} — it is sent once this move is saved, and ` +
          `logged again when it succeeds or gives up`,
      };
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
  ctx: Omit<ActionRunContext, "transitionKey"> & {
    /**
     * How deep in the engine's own work this run is. Always at least 1 — an action only ever exists
     * because a move happened — which is what makes StatusService.reevaluate() refuse anything an
     * action reaches for. Carried here rather than derived from `automatic` because the two answer
     * different questions: `automatic` is "was there a person behind the move", and this is "how
     * much of this has the engine already done to itself".
     */
    autoDepth: number;
  },
  entity: string,
  id: string,
  transitionKey: string,
  configs: ActionConfig[],
  deps: ActionDeps,
): Promise<void> {
  // The arrow travels with the run rather than beside it, so an action never has to be handed the
  // same fact twice or work out where the record is going from a row that has not moved yet.
  const actionCtx: ActionRunContext = { ...ctx, transitionKey };
  for (const cfg of configs) {
    const def = actionByKey(cfg.action);
    const applies = def?.entities.includes(entity as "rfq") ?? false;
    // Asked only of an action that was actually going to do something. An action that does not apply
    // to this record would have changed nothing anyway, so refusing it for volume would report a
    // ceiling problem where there is a configuration one — and would spend a check on nothing.
    const refusal = def && applies ? await refuseOverDailyCap(tx, actionCtx, def) : null;
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
        result = await def.run(tx, actionCtx, entity, id, cfg.params ?? {}, deps);
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
