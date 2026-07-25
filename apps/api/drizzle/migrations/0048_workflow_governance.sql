-- 0048_workflow_governance.sql — phase 1 of workflow governance (QNEW-64).
--
-- The engine could already say WHAT a record may become. It could not say WHO owns it while it sits
-- somewhere, or WHERE it should surface for them. Two columns close both gaps:
--
--   workflow_steps.pages       — which screens a record at this step appears on
--   workflow_steps.owner_roles — which roles are responsible for it while it is here
--
-- FROZEN vs TUNABLE — the rule for classifying every future column on these tables:
--   SEMANTICS ARE FROZEN, VIEW AND TIMING ARE TUNABLE.
-- An active flow version is immutable because in-flight records are bound to it; changing a rule
-- underneath them would rewrite history. But routing is not a rule — it decides which list a record
-- shows up in. If an admin routes a status to the wrong page, live work goes missing from a queue,
-- and forcing them to publish a whole new version to fix a typo would be the wrong trade. So:
--   owner_roles → FROZEN (added to the freeze tuple below)   — it governs who may act
--   pages       → TUNABLE (deliberately NOT in the tuple)    — it governs where they look
--
-- PERMISSIVE UNTIL CONFIGURED: both default to an empty array, and empty means "no opinion".
-- owner_roles = [] grants nobody and restricts nobody. pages = [] means the record keeps appearing
-- everywhere it appears today. A workspace that never opens this screen sees no behaviour change.

alter table workflow_steps
  add column if not exists pages       jsonb not null default '[]'::jsonb,
  add column if not exists owner_roles jsonb not null default '[]'::jsonb;

-- Arrays, not objects. Without this a stray object silently becomes an un-iterable value that every
-- consumer has to defend against; failing at the boundary keeps the readers simple.
alter table workflow_steps
  drop constraint if exists workflow_steps_pages_is_array,
  add  constraint workflow_steps_pages_is_array check (jsonb_typeof(pages) = 'array');
alter table workflow_steps
  drop constraint if exists workflow_steps_owner_roles_is_array,
  add  constraint workflow_steps_owner_roles_is_array check (jsonb_typeof(owner_roles) = 'array');

comment on column workflow_steps.pages is
  'Page keys this step''s records surface on. [] = every page that shows them today. TUNABLE on an active flow.';
comment on column workflow_steps.owner_roles is
  'Roles responsible for a record while it sits at this step. [] = unrestricted. FROZEN on an active flow.';

-- ── the freeze trigger has to learn about owner_roles ────────────────────────────────────────────
-- This function is a hardcoded tuple of column names. A new semantic column that is not listed here
-- is silently editable on an ACTIVE flow, which would let someone rewrite the rules under orders
-- already executing them — the exact failure this feature exists to prevent. Any future column must
-- be classified into one of the two lists above at the moment it is added.
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
    IF (NEW.from_step_id, NEW.to_step_id, NEW.condition, NEW.requires_approval, NEW.allowed_roles, NEW.priority)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles, OLD.priority)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $function$;
