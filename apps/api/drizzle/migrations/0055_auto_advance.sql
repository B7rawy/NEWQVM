-- 0055_auto_advance.sql — QNEW-89 §5.2 (move on its own when the rules are met)
--                          + QNEW-90 item 5 (loop prevention), which is its PREREQUISITE.
--
-- These ship together deliberately. Auto-advance without loop prevention is the classic automation
-- failure: a rule fires, its effect satisfies another rule, which fires, and the order marches to
-- the end of the flow — or round in a circle — in one transaction that nobody asked for. This
-- engine has a specific vector for it: the final approval performs the move (0052), so an auto
-- transition that raises an approval on a move that then auto-advances is a closed cycle.
--
-- THREE LEVERS, and each stops a different failure:
--
--   auto_advance   — opt IN, per transition. Nothing moves on its own unless somebody said it may.
--                    Off by default, which is why this migration changes no existing behaviour.
--
--   auto_once      — this transition fires automatically AT MOST ONCE for a given record. A flow
--                    that legitimately returns to an earlier status (rework, re-pricing) would
--                    otherwise re-fire the same automatic move every time it came back.
--
--   depth cap      — enforced in code, not here: an automatic move may trigger at most a short
--                    chain of further automatic moves. Belt and braces for the case where two
--                    transitions each satisfy the other's conditions.
--
-- FROZEN: both are rules about how a record behaves, so they belong in the freeze tuple with the
-- rest. Semantics frozen, view tunable — the rule since 0048.

alter table workflow_transitions
  add column if not exists auto_advance boolean not null default false,
  add column if not exists auto_once    boolean not null default true;

comment on column workflow_transitions.auto_advance is
  'Fire this move automatically once its conditions and gates are satisfied. Off by default.';
comment on column workflow_transitions.auto_once is
  'Fire automatically at most once per record — a flow that legitimately returns to an earlier '
  'status would otherwise re-fire the same automatic move each time it came back.';

-- ── the audit must never claim a person did what the system did ─────────────────────────────────
-- status_logs.changed_by is nullable, so an automatic move records NO actor rather than blaming
-- whoever happened to submit the quote that satisfied the gate. `auto_advanced` says so explicitly,
-- because a null actor alone is ambiguous.
alter table status_logs
  add column if not exists auto_advanced boolean not null default false;

comment on column status_logs.auto_advanced is
  'True when the engine moved this record itself. changed_by is NULL for these: attributing an '
  'automatic move to the person whose action satisfied the rule would be a false audit record.';

-- ── what has already fired, so auto_once can be honoured ────────────────────────────────────────
create table if not exists workflow_auto_fired (
  id             uuid primary key default gen_random_uuid() not null,
  tenant_id      uuid not null references tenants(id),
  environment    environment_type not null default 'live',
  entity_type    entity_type not null,
  entity_id      uuid not null,
  /** "fromCode>toCode" — the same key shape the approvals engine uses. */
  transition_key text not null,
  fired_at       timestamptz default now() not null,
  created_at     timestamptz default now() not null,
  updated_at     timestamptz default now() not null,
  created_by     uuid,
  updated_by     uuid,
  constraint workflow_auto_fired_uq unique (tenant_id, environment, entity_type, entity_id, transition_key)
);--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_auto_fired');--> statement-breakpoint

comment on table workflow_auto_fired is
  'One row per automatic move already made for a record, so auto_once can refuse to repeat it.';

-- ── the freeze tuple grows again (fourth time: 0048, 0049, 0051, now) ───────────────────────────
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
        NEW.priority, NEW.handoff, NEW.gates, NEW.auto_advance, NEW.auto_once)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles,
        OLD.priority, OLD.handoff, OLD.gates, OLD.auto_advance, OLD.auto_once)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
