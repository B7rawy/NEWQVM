-- 0058_action_daily_cap.sql — QNEW-90 item 9: a ceiling on how much the engine may do in one day.
--
-- The benchmark caps automated work per day per channel (functions 10k, webhooks 10k, email 500) and
-- the verdict on it was to adopt the shape SIMPLY: containment, not metering. Nothing is being sold
-- or billed here. The cap exists so that a flow which has started running away — a loop somebody
-- drew, a condition that matches every record, an action wired onto an arrow every order crosses —
-- hits a wall inside one day instead of writing until a person happens to notice.
--
-- "PER CHANNEL" HERE MEANS PER ACTION KIND. There is no email channel and no webhook channel: both
-- were deliberately not built (0056), because NotificationsService dispatches nothing and outbound
-- HTTP inside the business transaction would tell a receiver about a move that then rolled back.
-- What we have is three kinds of action, and the part of the benchmark's shape worth copying is that
-- they do not cost the same thing, so they must not share one ceiling. The numbers themselves live
-- in the catalog next to the code they govern (modules/workflow/actions.ts), with the reasoning for
-- each one; a ceiling kept in a table nobody can see is a rule nobody can find.
--
-- ── WHY 'capped' IS A FOURTH OUTCOME AND NOT A FLAVOUR OF 'skipped' ─────────────────────────────
-- The cheaper change was to reuse 'skipped' and put "daily cap reached" in `detail`. It is wrong,
-- because the two words answer different questions:
--
--   'skipped' is a statement about FIT. This action does not apply to this record, it never would
--   have done anything, and there is nothing for anybody to do about it. The run log badges it grey
--   for precisely that reason.
--
--   'capped' is a statement about VOLUME. The action DID apply and WOULD have changed the record; it
--   was refused. Either something is misconfigured or the workspace is genuinely busier than the
--   ceiling allows, and a person has to decide which. That is not grey.
--
-- Folding the second into the first would leave the difference legible only to whoever thought to
-- read a free-text column, and every later question of the form "what did the engine refuse to do
-- yesterday" would be answered by matching strings — the kind of query that rots silently the first
-- time somebody rewords a message. So the CHECK widens by one value, and the run log can filter on
-- it like any other outcome.
--
-- A capped action still writes its row. The whole instruction was to block the excess AND log it:
-- blocking without logging would make a flow stop having its configured effect with nothing anywhere
-- saying why, which is the same invisible-failure defect the run log was created to end.
alter table workflow_action_runs
  drop constraint if exists workflow_action_runs_outcome_ck,
  add  constraint workflow_action_runs_outcome_ck
    check (outcome in ('ok', 'failed', 'skipped', 'capped'));--> statement-breakpoint

comment on column workflow_action_runs.outcome is
  'ok — it ran. failed — it broke. skipped — it did not apply to this record and never would have. '
  'capped — it applied and was refused, because this workspace had already used its allowance for '
  'that kind of action today. The record still moved either way.';--> statement-breakpoint

-- ── how the allowance is counted ────────────────────────────────────────────────────────────────
-- Off this table, not off a counter row, so this index is the entire performance story of the cap:
-- (tenant, environment, action, ran_at desc) over the rows that CONSUME allowance. The existing
-- recent_idx from 0056 would have served the range, but it would have had to walk every action kind
-- and every outcome in the day to count one kind.
--
-- The partial predicate is what keeps the check cheap under exactly the conditions it exists for. A
-- capped row does not consume allowance, so it is not in this index: once a runaway flow has hit the
-- ceiling, the rows it keeps generating do not make the next count any more expensive. The scan
-- stays bounded by the ceiling itself rather than growing with the size of the wreckage.
create index if not exists workflow_action_runs_quota_idx
  on workflow_action_runs (tenant_id, environment, action, ran_at desc)
  where outcome in ('ok', 'failed');--> statement-breakpoint

-- There is no apply_tenant_rls() call in this migration and that is not an omission: it creates no
-- table. workflow_action_runs got its tenant and environment policies when it was created in 0056,
-- the count runs inside the caller's own transaction, and it filters tenant_id explicitly anyway
-- because the tenant policy ends in "OR app_is_internal()".
