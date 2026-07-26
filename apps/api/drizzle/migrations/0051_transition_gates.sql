-- 0051_transition_gates.sql — QNEW-89 §4: a transition can be guarded by conditions.
--
-- Until now the engine could say WHO may move a record and WHERE it goes. It could not say WHEN the
-- business is actually ready for it to go. "Confirm" was available the moment someone had permission,
-- whether or not every line had been priced.
--
-- Two kinds of guard, stored separately because they answer different questions:
--
--   condition (already existed, never evaluated) — a fact about THIS record.
--       {"all":[{"field":"payer_type","op":"eq","value":"insurance"}]}
--
--   gates (new) — a fact about the record's CHILDREN, computed by code.
--       [{"gate":"all_items_at_status","params":{"status":"priced"},"enforcement":"block"}]
--
-- WHY GATES ARE A CURATED CATALOG AND NOT AN EXPRESSION LANGUAGE: an admin choosing "every line must
-- be priced" from a list can never write a query that is wrong, slow, or a way into another tenant's
-- data. The cost is that a new kind of gate needs code — which is the right trade for a no-code
-- builder aimed at people who run a parts business, not people who write SQL.
--
-- ENFORCEMENT is per gate. `block` refuses. `warn_override` refuses unless the caller supplies a
-- written reason, which is recorded. Margin and quorum rules ship as warn_override on purpose: the
-- first time a gate stops an urgent order because a margin came in at 4.8%, trust in the whole engine
-- goes, and it does not come back.
--
-- FROZEN: a gate is a rule, and records in flight are bound to the version they entered. Changing
-- "confirm needs all lines priced" underneath an order that already passed it would rewrite history.

alter table workflow_transitions
  add column if not exists gates jsonb not null default '[]'::jsonb;

alter table workflow_transitions
  drop constraint if exists workflow_transitions_gates_shape,
  add  constraint workflow_transitions_gates_shape check (
    jsonb_typeof(gates) = 'array'
    and jsonb_array_length(gates) = jsonb_array_length(
      jsonb_path_query_array(
        gates,
        '$[*] ? (@.gate != null && (@.enforcement == "block" || @.enforcement == "warn_override"))'
      ))
  );

comment on column workflow_transitions.gates is
  'Exit gates: [{gate, params, enforcement}]. Code-defined catalog (see modules/workflow/gates.ts). '
  'FROZEN on an active flow — a gate is a rule, not a view.';

-- ── the freeze trigger must learn about gates ────────────────────────────────────────────────────
-- Third time this tuple has grown (0048 owner_roles, 0049 handoff, now gates). A semantic column
-- missing from it is silently editable on an ACTIVE flow, which is exactly the hole the whole
-- versioning design exists to close. Classification rule, unchanged since 0048:
-- SEMANTICS ARE FROZEN, VIEW AND TIMING ARE TUNABLE.
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
        NEW.priority, NEW.handoff, NEW.gates)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles,
        OLD.priority, OLD.handoff, OLD.gates)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- ── the override trail ──────────────────────────────────────────────────────────────────────────
-- A warn_override that leaves no record is not governance, it is a suggestion. The reason lands on
-- the status_logs row for the move it permitted, so "who let this through and why" is one query.
alter table status_logs
  add column if not exists override_reason text,
  add column if not exists overridden_gates jsonb;

comment on column status_logs.override_reason is
  'Written justification when a warn_override gate was bypassed. NULL for an ordinary move.';
