-- 0056_workflow_actions.sql — QNEW-90 items 3, 4 and 6: the engine gets to DO something.
--
-- Until now the workflow could only permit or refuse a move. Zoho's benchmark called out the gap
-- correctly: a rules engine that cannot act is half an engine. What is missing is not the ability to
-- decide, it is the ability to have a consequence.
--
-- WHAT SHIPS, AND WHY THESE THREE:
--   set_field      — write a value on the record when it arrives somewhere. Full effect today.
--   lock_record    — freeze it, using the same mechanism the exception flow uses (0054). Item 4 of
--                    the benchmark, which is industry validation for a primitive we already had.
--   unlock_record  — release it.
--
-- WHAT DELIBERATELY DOES NOT SHIP: `notify` and `webhook`.
-- NotificationsService.send() records an attempt and dispatches nothing — there is no provider
-- behind it. Shipping a "send an email" action would produce a catalog that records intentions and
-- delivers none of them, which is exactly the defect the previous ticket identified in
-- `requires_approval` being drawn as a padlock that enforced nothing. A webhook has the same
-- problem from the other end: firing outbound HTTP from inside the business transaction means a
-- rollback leaves the receiver believing something happened. Both wait for real delivery.
--
-- ACTIONS ARE FROZEN with the rest of a transition's semantics: what a move DOES is as much a rule
-- as who may make it.

alter table workflow_transitions
  add column if not exists actions jsonb not null default '[]'::jsonb;

alter table workflow_transitions
  drop constraint if exists workflow_transitions_actions_shape,
  add  constraint workflow_transitions_actions_shape check (
    jsonb_typeof(actions) = 'array'
    and jsonb_array_length(actions) = jsonb_array_length(
      jsonb_path_query_array(actions, '$[*] ? (@.action != null)'))
  );

comment on column workflow_transitions.actions is
  'What happens AFTER this move succeeds: [{action, params}] from the code-defined catalog in '
  'modules/workflow/actions.ts. FROZEN — what a move does is as much a rule as who may make it.';

-- ── the run log (item 6) ────────────────────────────────────────────────────────────────────────
-- status_logs answers "what moved". It cannot answer "what did the engine DO about it, and did that
-- work" — and an action whose failure is invisible is worse than no action, because the flow looks
-- configured and quietly is not.
create table if not exists workflow_action_runs (
  id            uuid primary key default gen_random_uuid() not null,
  tenant_id     uuid not null references tenants(id),
  environment   environment_type not null default 'live',
  entity_type   entity_type not null,
  entity_id     uuid not null,
  /** "fromCode>toCode" — the move that triggered it. */
  transition_key text,
  action        text not null,
  params        jsonb not null default '{}'::jsonb,
  -- 'ok' | 'failed' | 'skipped'. `skipped` is a first-class outcome, not an absence: an action that
  -- did not apply to this record is a different thing from one that broke.
  outcome       text not null,
  detail        text,
  /** NULL when the engine acted by itself, matching status_logs.changed_by. */
  actor_user_id uuid references users(id),
  ran_at        timestamptz default now() not null,
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null,
  created_by    uuid,
  updated_by    uuid,
  constraint workflow_action_runs_outcome_ck check (outcome in ('ok', 'failed', 'skipped'))
);--> statement-breakpoint

-- "show me what went wrong" is the query this table exists for, so failures must not scan
create index if not exists workflow_action_runs_recent_idx
  on workflow_action_runs (tenant_id, environment, ran_at desc);--> statement-breakpoint
create index if not exists workflow_action_runs_failed_idx
  on workflow_action_runs (tenant_id, environment, ran_at desc)
  where outcome = 'failed';--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_action_runs');--> statement-breakpoint

comment on table workflow_action_runs is
  'One row per action the engine attempted, with its outcome. status_logs says what moved; this '
  'says what the engine did about it and whether that worked.';

-- ── freeze tuple, fifth growth (0048, 0049, 0051, 0055, now) ────────────────────────────────────
create or replace function public.workflow_child_freeze()
returns trigger
language plpgsql
set search_path to ''
as $function$
DECLARE v_status public.workflow_flow_status;
BEGIN
  SELECT status INTO v_status FROM public.workflow_flows
  WHERE id = COALESCE(NEW.flow_id, OLD.flow_id);
  IF v_status IS NULL OR v_status = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'flow is % — publish a new version to change its steps or transitions', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_TABLE_NAME = 'workflow_steps' THEN
    IF (NEW.item_status_id, NEW.vendor_status_id, NEW.status_domain, NEW.is_entry, NEW.is_terminal,
        NEW.owner_roles)
       IS DISTINCT FROM
       (OLD.item_status_id, OLD.vendor_status_id, OLD.status_domain, OLD.is_entry, OLD.is_terminal,
        OLD.owner_roles)
    THEN
      RAISE EXCEPTION 'flow is % — a step''s status or owners cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (NEW.from_step_id, NEW.to_step_id, NEW.condition, NEW.requires_approval, NEW.allowed_roles,
        NEW.priority, NEW.handoff, NEW.gates, NEW.auto_advance, NEW.auto_once, NEW.actions)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles,
        OLD.priority, OLD.handoff, OLD.gates, OLD.auto_advance, OLD.auto_once, OLD.actions)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
