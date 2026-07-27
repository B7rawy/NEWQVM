-- 0062_record_removals.sql — QNEW-90 item 7, the `deleted` corner of the trigger taxonomy.
--
-- The benchmark offers four trigger kinds: created / edited / created-or-edited / deleted. The
-- verdict on it was ADOPT MINIMALLY — `created` and the child events (a quote submitted, a delivery
-- recorded) are what our gates actually read, and `deleted` is worth having FOR AUDIT ONLY.
--
-- WHY DELETED IS AUDIT AND NOTHING ELSE. A rule that fires on a delete has nothing left to act on:
-- the record it would move, hold, or fill a field on is gone. Every consequence this engine can have
-- is a consequence ON A RECORD (see modules/workflow/actions.ts), so wiring a delete to the rule
-- engine would be a trigger kind that can only ever run actions that skip. What a reader genuinely
-- needs is the opposite of a rule: an answer to "there is a status_logs history here for an RFQ that
-- no longer exists — what happened to it".
--
-- SO THIS IS A TRIGGER, NOT A SERVICE METHOD. There is no delete endpoint for an RFQ or an order in
-- this API and there is not meant to be one; the way rows actually leave this system is a hand-run
-- statement on the database during a support fix or a test teardown. A method in the API would
-- therefore record exactly the deletions that never happen and miss every one that does. A trigger
-- sits under all of them.
--
-- IT IS DELIBERATELY WIRED TO NOTHING. No screen reads this table, no rule consults it, no
-- notification comes out of it. That is the ticket's instruction and it is also the honest shape:
-- the moment a delete could move something, a support engineer clearing test data would be running
-- the workflow engine without knowing it.

create table if not exists workflow_record_removals (
  id             uuid primary key default gen_random_uuid() not null,
  tenant_id      uuid not null references tenants(id),
  environment    environment_type not null default 'live',
  entity_type    entity_type not null,
  -- NO FOREIGN KEY, and that is the entire point of the table: it names a row that no longer
  -- exists. entity_id is the same polymorphic (entity_type, entity_id) pair status_logs and
  -- workflow_record_state use, so a reader can join this to the history the deleted record left.
  entity_id      uuid not null,
  /** Order number, or part number for a line — so the row identifies the thing a person knew, not
   *  just a uuid that now resolves to nothing anywhere. */
  reference      text,
  /** Where the record stood when it left. Kept as an id rather than a code so it reads the same way
   *  as status_logs, and with no FK for the same reason entity_id has none. */
  last_status_id uuid,
  created_at     timestamptz default now() not null,
  updated_at     timestamptz default now() not null,
  created_by     uuid,
  updated_by     uuid
);--> statement-breakpoint

-- There is deliberately no removed_at / removed_by pair. apply_tenant_rls() installs the house audit
-- trigger, which fills created_at and created_by from the session on insert — and on a table whose
-- only row-creating event IS a removal, those two columns already hold precisely when it happened
-- and who did it. A second pair carrying the same two facts is a second place for them to disagree.
SELECT public.apply_tenant_rls('workflow_record_removals');--> statement-breakpoint

create index if not exists workflow_record_removals_entity_idx
  on workflow_record_removals (tenant_id, environment, entity_type, entity_id);--> statement-breakpoint

comment on table workflow_record_removals is
  'One row per business record that left the system, so the status_logs history of a deleted RFQ or '
  'order still resolves to something a reader can identify. AUDIT ONLY (QNEW-90 item 7): a delete '
  'triggers no workflow rule, because every action this engine has acts on a record that by then '
  'does not exist.';--> statement-breakpoint

-- SECURITY INVOKER, not DEFINER. The insert runs under the policies of whoever is deleting, which is
-- what we want: the row being deleted had to satisfy tenant_isolation and environment_isolation to
-- be visible at all, so the audit row carrying the same tenant_id and environment satisfies them
-- too. Failing closed here is also correct — a delete that cannot be recorded should not proceed.
-- The old system's 156 SECURITY DEFINER functions are the sin this rebuild exists to undo, and an
-- audit table is the last place to start reopening that door.
create or replace function public.record_removal_audit()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
DECLARE
  -- to_jsonb(OLD) rather than four near-identical trigger functions: the four tables agree on
  -- tenant_id / environment / status_id and disagree only on which column a human would recognise
  -- the record by, so one function reading the row generically is less to keep in step than four.
  j jsonb := to_jsonb(OLD);
  v_entity public.entity_type;
BEGIN
  v_entity := (case tg_table_name
                 when 'rfqs'        then 'rfq'
                 when 'rfq_items'   then 'rfq_item'
                 when 'orders'      then 'order'
                 when 'order_items' then 'order_item'
               end)::public.entity_type;
  -- An unmapped table would insert NULL into a NOT NULL column and fail the delete. Return early
  -- instead: this trigger must never be the reason a row cannot be removed.
  IF v_entity IS NULL THEN RETURN OLD; END IF;

  INSERT INTO public.workflow_record_removals
    (tenant_id, environment, entity_type, entity_id, reference, last_status_id)
  VALUES (
    (j->>'tenant_id')::uuid,
    coalesce(j->>'environment', 'live')::public.environment_type,
    v_entity,
    (j->>'id')::uuid,
    -- headers carry the order number; lines carry the part number they were bought as
    coalesce(j->>'order_number', j->>'final_part_number', j->>'part_number'),
    (j->>'status_id')::uuid);
  RETURN OLD;
END $function$;--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_record_removal_audit ON rfqs;--> statement-breakpoint
CREATE TRIGGER trg_record_removal_audit AFTER DELETE ON rfqs
  FOR EACH ROW EXECUTE FUNCTION public.record_removal_audit();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_record_removal_audit ON rfq_items;--> statement-breakpoint
CREATE TRIGGER trg_record_removal_audit AFTER DELETE ON rfq_items
  FOR EACH ROW EXECUTE FUNCTION public.record_removal_audit();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_record_removal_audit ON orders;--> statement-breakpoint
CREATE TRIGGER trg_record_removal_audit AFTER DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION public.record_removal_audit();--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_record_removal_audit ON order_items;--> statement-breakpoint
CREATE TRIGGER trg_record_removal_audit AFTER DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION public.record_removal_audit();--> statement-breakpoint

-- There is no drizzle/schema entry for this table, matching workflow_auto_fired and
-- workflow_action_runs: nothing reads it through the query builder, and a schema object with no
-- reader is one more thing to keep in step for no benefit.
comment on column workflow_record_removals.reference is
  'The order number, or the part number for a line — what a person would have called the record '
  'before it was deleted.';
