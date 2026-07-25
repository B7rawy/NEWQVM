-- 0049_workflow_custody.sql — phase 2 of workflow governance (QNEW-64): WHO HOLDS IT NOW.
--
-- Phase 1 said who MAY act at a step. It said nothing about who is holding a given record right
-- now, so "who hands off to whom" had no answer and there was no way to build a personal queue:
-- every user still had to scan a global list and guess which rows were theirs.
--
-- Custody is per-RECORD runtime state, which is why it lives on workflow_record_state (already one
-- row per record per flow) rather than on the flow definition. The flow says what SHOULD happen on
-- a move; these columns record what DID.
--
--   assignee_user_id — the one person responsible right now. NULL means the pool: nobody has
--                      claimed it and anyone holding the step's owner_roles may.
--   assignee_role    — which role they hold it AS. A user with two roles must not make the queue
--                      ambiguous, and the audit trail should say which hat they wore.
--   step_entered_at  — when the record arrived at its current step. Time-in-status was previously
--                      only derivable by replaying status_logs.
--   due_at           — precomputed from the destination step's sla_hours. Stored rather than
--                      computed on read so "overdue" is one indexed comparison, not a join per row.
--
-- workflow_transitions.handoff says what a move does to custody. Three modes cover the real cases
-- without inventing a rules language:
--   'pool'  (default) — release it; the destination step's owners can pick it up
--   'keep'            — whoever holds it keeps it (a move that does not change hands)
--   'actor'           — the person who just made the move takes it
-- FROZEN, because it is a rule about who becomes responsible, and in-flight records are bound to
-- this version. See the classification rule in 0048.

alter table workflow_record_state
  add column if not exists assignee_user_id uuid references users(id) on delete set null,
  add column if not exists assignee_role    text,
  add column if not exists step_entered_at  timestamptz not null default now(),
  add column if not exists due_at           timestamptz;

alter table workflow_transitions
  add column if not exists handoff text not null default 'pool';
alter table workflow_transitions
  drop constraint if exists workflow_transitions_handoff_mode,
  add  constraint workflow_transitions_handoff_mode check (handoff in ('pool', 'keep', 'actor'));

-- "my work" and "my team's unclaimed pool" are the two queries the whole feature exists to serve;
-- both filter on tenant + environment + assignee, and the overdue view sorts on due_at.
create index if not exists workflow_record_state_assignee_idx
  on workflow_record_state (tenant_id, environment, assignee_user_id)
  where assignee_user_id is not null;
create index if not exists workflow_record_state_pool_idx
  on workflow_record_state (tenant_id, environment, assignee_role)
  where assignee_user_id is null;
create index if not exists workflow_record_state_due_idx
  on workflow_record_state (tenant_id, environment, due_at)
  where due_at is not null;

comment on column workflow_record_state.assignee_user_id is
  'Who holds this record right now. NULL = unclaimed pool, open to the step''s owner_roles.';
comment on column workflow_transitions.handoff is
  'What this move does to custody: pool (release), keep (unchanged), actor (mover takes it). FROZEN.';

-- ── the freeze trigger must learn about handoff ──────────────────────────────────────────────────
-- Same reasoning as 0048: a semantic column absent from this tuple is silently editable on an ACTIVE
-- flow, which would re-route custody for orders already in flight.
create or replace function public.workflow_child_freeze()
returns trigger
language plpgsql
set search_path to ''
as $function$
DECLARE v_status public.workflow_flow_status;
BEGIN
  SELECT status INTO v_status FROM public.workflow_flows
  WHERE id = COALESCE(NEW.flow_id, OLD.flow_id);
  -- missing parent passes: a CASCADE delete of a draft flow removes children after the parent
  IF v_status IS NULL OR v_status = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP IN ('INSERT', 'DELETE') THEN
    RAISE EXCEPTION 'flow is % — publish a new version to change its steps or transitions', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  -- UPDATE: layout, cosmetics and ROUTING stay editable; the semantics do not
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
        NEW.priority, NEW.handoff)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles,
        OLD.priority, OLD.handoff)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
