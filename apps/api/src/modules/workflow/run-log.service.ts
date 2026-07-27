import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { envOf } from "../../common/env-guards.js";

/**
 * THE RUN LOG — QNEW-90 item 6.
 *
 * ONE TIMELINE, NOT TWO LISTS, and the choice is the whole design of this file.
 *
 * There are two tables behind this screen and they answer two halves of one question. `status_logs`
 * says WHAT MOVED — this order left `priced` and arrived at `confirmed`, at this time, because of
 * this person. `workflow_action_runs` says WHAT THE ENGINE DID ABOUT IT — and, crucially, whether
 * that worked. Neither is legible without the other: an action run on its own is a verb with no
 * subject ("put it on hold" — after what?), and a move on its own hides the consequence the flow
 * was configured to have. Handing the reader two separate lists would make them interleave the two
 * by eye, comparing timestamps, at exactly the moment they are already worried about something.
 *
 * So the two are unioned into one chronological stream. The columns that do not apply to a row are
 * NULL rather than invented, which is why this is not "conflating" them: a MOVE has no outcome,
 * because a move that failed was never written — the transaction rolled back and there is nothing
 * to log. An ACTION has no from/to status, because it did not move anything. `kind` says which one
 * a row is, and every consumer branches on it.
 *
 * A union also gives one honest LIMIT. Two lists limited separately and merged client-side produce
 * a tail that silently lies: 200 moves and 200 actions merged is not "the newest 200 events".
 *
 * WHERE THE DAILY DIGEST WENT. It was withheld from this ticket's first pass because
 * NotificationsService.send() records an attempt in `notification_log` and dispatches nothing —
 * there is no provider behind it — so a digest built on that would have told an operator "you will
 * be emailed when a rule breaks" and then no email would have arrived. Migration 0061 changed the
 * fact rather than the argument: in-app delivery needs no provider, so the digest now exists and is
 * delivered there, by WorkflowDigestService. It links here, because a message saying something broke
 * without saying where to look is an alarm with no map — which is why the failure count is still
 * returned separately from the page window below.
 */

export const runLogQuerySchema = z.object({
  /**
   * Only ACTION rows carry an outcome, so filtering by one necessarily narrows the stream to
   * actions. That is the "show me what broke" view and it is the point of the filter — the moves
   * are dropped rather than kept, because a move with a blank outcome column sitting between two
   * failures reads as a third failure whose detail is missing.
   */
  /**
   * `capped` is in the list because the cap (0058) would otherwise be enforceable but not
   * answerable: "what did the engine refuse to do today" is the one question a workspace asks after
   * it hits a ceiling, and leaving it out would push whoever asked into matching `detail` strings.
   */
  outcome: z.enum(["ok", "failed", "skipped", "capped"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export type RunLogQuery = z.infer<typeof runLogQuerySchema>;

@Injectable()
export class WorkflowRunLogService {
  constructor(private readonly dbService: DbService) {}

  async list(ctx: RlsContext, q: RunLogQuery) {
    const outcome = q.outcome ?? null;
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = await tx.execute(sql`
        select e.kind,
               -- Rendered as real ISO-8601 rather than left as postgres' "2026-07-26 23:05:03+00".
               -- That form only parses because engines are lenient about it, and this is the one
               -- column of this screen that also leaves the app in a CSV somebody opens elsewhere.
               to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
               e.entity_type, e.entity_id, e.transition_key,
               e.action, e.outcome, e.detail, e.auto_advanced, e.override_reason,
               coalesce(fi.label_en, fv.label_en) as from_status,
               coalesce(ti.label_en, tv.label_en) as to_status,
               -- What ties a move to the actions it caused. An action row carries the key already;
               -- a move has to have it derived, because status_logs stores the two status ids and
               -- not the arrow. Without this the ordering below cannot group them, and the first
               -- version of the fix silently did not: every action still sorted above its own move
               -- because only actions had a key to sort by.
               coalesce(e.transition_key,
                        coalesce(fi.code, fv.code) || '>' || coalesce(ti.code, tv.code)) as group_key,
               -- NOT u.full_name from a join: 0045's policy on "users" is self-or-internal, so
               -- for a workspace reader that join resolved only their own row and every colleague
               -- came back null — which the screen then rendered as "no signed-in user", asserting
               -- an unauthenticated vendor had done work a named employee did. 0059's function
               -- answers for people this caller may legitimately see.
               public.workflow_actor_label(e.actor_user_id) as actor_name,
               -- Travels separately from the label, because "somebody did this and you may not see
               -- who" and "nobody was signed in" are different facts and were being collapsed.
               (e.actor_user_id is not null) as has_actor,
               coalesce(r.order_number, o.order_number, ir.order_number, io.order_number) as reference,
               coalesce(ii.part_number, oi.final_part_number) as part
        from (
          -- Each branch is limited and ordered on its own so both can ride an index — 0056's for
          -- workflow_action_runs and 0059's for status_logs. That second one did not exist when this
          -- comment first claimed it did: measured at 40,000 rows, the move branch was sequentially
          -- scanning the workspace's entire history and top-N sorting it on every page load, and
          -- status_logs is append-only, so the cost of opening this screen grew with the tenant
          -- forever. The outer order/limit then trims the merged stream.
          --
          -- The tenant_id predicate is written out even though RLS is on, because the tenant policy
          -- reads "tenant_id = current_tenant_id() OR app_is_internal()". Platform staff are internal, so
          -- for them RLS restricts nothing — and a screen headed "this workspace" that quietly
          -- listed every workspace's orders to a Qparts admin would be a leak the reader cannot
          -- see. The environment predicate is belt-and-braces over the RESTRICTIVE policy.
          (select 'action'::text as kind, a.ran_at as occurred_at, a.entity_type::text as entity_type,
                  a.entity_id, a.transition_key, a.action, a.outcome, a.detail,
                  a.auto_advanced, null::text as override_reason,
                  null::uuid as from_status_id, null::uuid as to_status_id,
                  null::text as status_domain, a.actor_user_id
             from workflow_action_runs a
            where a.tenant_id = ${ctx.tenantId}::uuid and a.environment = ${envOf(ctx)}
              and (${outcome}::text is null or a.outcome = ${outcome}::text)
            order by a.ran_at desc
            limit ${q.limit})
          union all
          (select 'move'::text, l.created_at, l.entity_type::text, l.entity_id,
                  null::text, null::text, null::text, null::text,
                  l.auto_advanced, l.override_reason,
                  l.from_status_id, l.to_status_id, l.status_domain::text, l.changed_by
             from status_logs l
            where l.tenant_id = ${ctx.tenantId}::uuid and l.environment = ${envOf(ctx)}
              and ${outcome}::text is null
            order by l.created_at desc
            limit ${q.limit})
        ) e
        -- Two status vocabularies, and only one of them is the item one. Resolving item_statuses
        -- alone (as history() does) leaves every rfq_vendor move rendering as an empty arrow.
        left join item_statuses   fi on fi.id = e.from_status_id and e.status_domain = 'item'
        left join item_statuses   ti on ti.id = e.to_status_id   and e.status_domain = 'item'
        left join vendor_statuses fv on fv.id = e.from_status_id and e.status_domain = 'vendor'
        left join vendor_statuses tv on tv.id = e.to_status_id   and e.status_domain = 'vendor'
        left join rfqs        r  on e.entity_type = 'rfq'        and r.id  = e.entity_id
        left join orders      o  on e.entity_type = 'order'      and o.id  = e.entity_id
        left join rfq_items   ii on e.entity_type = 'rfq_item'   and ii.id = e.entity_id
        left join order_items oi on e.entity_type = 'order_item' and oi.id = e.entity_id
        left join rfqs   ir on ir.id = ii.rfq_id
        left join orders io on io.id = oi.order_id
        -- THE TIEBREAKERS ARE LOAD-BEARING. Both source tables default their timestamp to now(),
        -- which in postgres is the TRANSACTION timestamp — so a move, the actions it fired, and every
        -- other move in an auto-advance chain all carry the same instant to the microsecond. With
        -- occurred_at desc alone the rows came back in an order postgres never promised: two
        -- identical runs of the same scenario produced different sequences, actions sorted above the
        -- move that caused them, and a chain of moves rendered oldest-first under a header that says
        -- newest first. Ordering by transition_key groups a move with its own consequences, and
        -- kind then puts the move above them — subject before verb, which is the whole reason the
        -- two tables are unioned instead of listed side by side.
        order by e.occurred_at desc,
                 coalesce(e.transition_key,
                          coalesce(fi.code, fv.code) || '>' || coalesce(ti.code, tv.code)) nulls last,
                 case e.kind when 'move' then 0 else 1 end,
                 e.entity_id
        limit ${q.limit}`);

      // Counted over the whole environment rather than the page above, because the number answers
      // "is anything broken" and a count of the visible window says "nothing broken here" the moment
      // the log is longer than the limit.
      //
      // BOUNDED TO A WEEK, and that bound is the point. Unbounded, one failure a workspace had once
      // lit the banner for the rest of the product's life with no way to clear it — and a warning
      // that is always on is a warning nobody reads, which is the alarm fatigue this screen is
      // supposed to prevent rather than cause. A week is long enough to survive a weekend and short
      // enough that going quiet means something was actually fixed.
      const [f] = (await tx.execute(sql`
        select count(*)::int as n from workflow_action_runs
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
          and outcome = 'failed' and ran_at > now() - interval '7 days'`)) as Array<{ n: number }>;

      return { rows, failed: f?.n ?? 0, failedWindowDays: 7, limit: q.limit, outcome };
    });
  }
}
