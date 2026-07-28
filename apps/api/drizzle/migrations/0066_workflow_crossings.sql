-- 0066_workflow_crossings.sql — A STEP HANDS THE RECORD TO ANOTHER FLOW, AND TAKES IT BACK.
--
-- 0065 gave a workspace more than one flow and decided which one a record STARTS in. This decides
-- where it goes MID-LIFE: an order on the standard flow reaches "send to insurance", crosses into
-- the insurance flow, is worked there by insurance's own people under insurance's own rules, and
-- comes back to the standard flow at whichever status the outcome calls for.
--
-- THE CROSSING IS AN ARROW, not a property of a step and not a call stack. That single decision is
-- what every column below is in service of, and it is worth stating why it was taken:
--
--   • VISIBLE. A border somebody drew is on the canvas at both ends, validatable from both ends, and
--     frozen by workflow_child_freeze() while records are executing it. A step-level "door" property
--     would live inside an inspector dropdown and the way home would be a stored pointer that
--     nothing renders.
--   • ONE MOVE. A crossing is one status change: one status_logs row, one custody write, one
--     workflow_record_state upsert. A design that re-enters the write path to "call" the sub-flow
--     produces two log rows per crossing, and then needs extra columns to stop the run log rendering
--     the second one as an order going backwards.
--   • MORE THAN ONE ENDING. The real return tail is
--     return_request → return → claim_sent → rn_sign_pending → pending_credit_note →
--     credit_note_issued → settled, with cancelled branching off it. A sub-flow draws one return
--     arrow per outcome, each landing on a different status in the parent. A single stored return
--     address can only ever land them all in the same place.
--
-- WHAT IS DELIBERATELY NOT HERE: no frame table, no depth cap, no second depth constant, no
-- per-record return-address stack. Every one of those is a mechanism whose failure mode is a record
-- sitting somewhere nobody drew. A crossing is bounded by exactly what bounds any other arrow —
-- MAX_AUTO_DEPTH for automatic chains, and a person's decision otherwise.
--
-- ON PING-PONG. `workflow_transitions_no_self_loop` already makes the dangerous case
-- unrepresentable: a border is an arrow, an arrow cannot start and end on the same step, so a
-- crossing ALWAYS changes status. The zero-status-change livelock — the one no status_logs write, no
-- auto_once and no MAX_AUTO_DEPTH would ever see — cannot be drawn here. A status-CHANGING loop
-- across the border is still possible and is bounded by exactly what bounds a same-flow 2-cycle
-- today, so it is not a new class of thing and gets no new instrument.
--
-- NO NEW TABLE, so no `apply_tenant_rls` call: every column added below sits on a table that already
-- has RLS attached.

-- ── 1. THE CROSSING ──────────────────────────────────────────────────────────────────────────────
--
-- Null on every existing row and on almost every new one: an arrow without it moves the record
-- inside its own flow exactly as it always has.
ALTER TABLE "workflow_transitions" ADD COLUMN IF NOT EXISTS "to_flow_key" text;--> statement-breakpoint

-- flow_key, not flow_id. A key names the flow ACROSS versions, and that is the whole point: the
-- insurance flow republishes on its own schedule and the standard flow must not need a new version
-- every time it does. An id would pin the border to one version and quietly aim it at a retired
-- graph the day insurance published v2.
--
-- The shape CHECK is the same slug grammar flow_key itself uses. It is not decoration: the run-time
-- resolver looks this string up in a unique index, so a value that could never match is a border
-- that refuses every record that reaches it, discovered in production rather than at save time.
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_flow_key_shape"
  CHECK ("to_flow_key" IS NULL OR "to_flow_key" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$');--> statement-breakpoint

COMMENT ON COLUMN "workflow_transitions"."to_flow_key" IS
  'When set, taking this arrow also hands the record to the ACTIVE version of the named flow, landing '
  'on that flow''s step for the destination status. Null means an ordinary move inside this flow. '
  'Named by key rather than id so the target can republish without re-versioning every flow that '
  'crosses into it.';--> statement-breakpoint

-- ── 2. HOW A SUB-FLOW IS ENTERED (honest routing) ────────────────────────────────────────────────
--
-- THIS IS THE COLUMN THAT STOPS A LIE BEING STORED. `workflow_flows_default_uq` permits exactly one
-- active default per (tenant, environment, status_domain) and the provisioned 'standard' flow
-- already holds it, so a sub-flow must be active-and-non-default. But
-- `workflow_flows_selection_complete` then FORCES a non-default active flow to carry a non-null
-- selection_condition — and a sub-flow has no selection condition, because nothing SELECTS it. It is
-- reached by being handed a record, never by a record being born into it.
--
-- Satisfying that CHECK with `{}` would be the cheap way out and it would be a falsehood: the zod
-- boundary defines `{}` as "matches every record", so the workspace would be storing "this flow
-- accepts everything" about a flow that must accept nothing at birth — sitting there waiting for the
-- day selection_condition is finally evaluated, at which point every new record would race between
-- two flows. `entry_mode` says the true thing instead, and becomes a third valid answer to the
-- routing-is-not-set check at activation.
--
-- 'selected' by default so every existing flow keeps exactly the meaning it has today.
ALTER TABLE "workflow_flows" ADD COLUMN IF NOT EXISTS "entry_mode" text NOT NULL DEFAULT 'selected';--> statement-breakpoint
ALTER TABLE "workflow_flows" ADD CONSTRAINT "workflow_flows_entry_mode_shape"
  CHECK ("entry_mode" IN ('selected', 'handoff'));--> statement-breakpoint

COMMENT ON COLUMN "workflow_flows"."entry_mode" IS
  'How records get into this flow. ''selected'' — a record entering the domain is matched against '
  'selection_condition (or lands here as the default). ''handoff'' — records only ever arrive by '
  'crossing an arrow with to_flow_key pointing here, so no selection condition is required or wanted.';--> statement-breakpoint

ALTER TABLE "workflow_flows" DROP CONSTRAINT "workflow_flows_selection_complete";--> statement-breakpoint
ALTER TABLE "workflow_flows" ADD CONSTRAINT "workflow_flows_selection_complete" CHECK (
  "status" <> 'active' OR "is_default" OR "selection_condition" IS NOT NULL OR "entry_mode" = 'handoff'
);--> statement-breakpoint

-- ── 3. THE VERSION HINT — A HINT, NOT A POINTER ──────────────────────────────────────────────────
--
-- Where the record came from, written on the outbound crossing and cleared on the return. It exists
-- so a record comes home to the version it left, which is the invariant status.service.ts states
-- twice: "quietly rewriting the flow binding of a record already mid-flight is exactly the
-- strand-an-order-mid-version failure the binding exists to prevent".
--
-- THE WORD "HINT" IS LOAD-BEARING AND IT IS THE ENTIRE DIFFERENCE FROM A CALL STACK. Nothing depends
-- on this column existing. On the way home the resolver PREFERS it — if that flow is non-draft and
-- still has a step for the landing status — and otherwise falls back to the active version of the
-- named key. So if it is null, stale, or points at a version that has since dropped the landing
-- status, the crossing still completes against the live graph. A stored return address that MUST
-- resolve is the thing that strands the record on the day it cannot; this one cannot strand anything
-- because the crossing never needs it.
ALTER TABLE "workflow_record_state" ADD COLUMN IF NOT EXISTS "origin_flow_id" uuid;--> statement-breakpoint

-- Mirrors workflow_record_state_flow_scope_fk and rides workflow_flows_id_scope_domain_uq. MATCH
-- SIMPLE, so a null origin_flow_id leaves the whole constraint unchecked — which is exactly the
-- wanted behaviour (a record that is not away has no origin) and the same trick the existing flow FK
-- relies on. No ON DELETE: a flow a record can still return to must not be deletable out from under
-- it, for the same reason the flow it is executing is not.
ALTER TABLE "workflow_record_state" ADD CONSTRAINT "workflow_record_state_origin_flow_fk"
  FOREIGN KEY ("origin_flow_id", "tenant_id", "environment", "status_domain")
  REFERENCES "workflow_flows" ("id", "tenant_id", "environment", "status_domain")
  ON UPDATE CASCADE;--> statement-breakpoint

-- Partial, because "which records are currently away in a sub-flow" is a small set inside a table
-- that holds every live record, and it is the question both the break-glass endpoint and any
-- operator worrying about a stuck order asks.
CREATE INDEX IF NOT EXISTS "workflow_record_state_away_idx"
  ON "workflow_record_state" ("tenant_id", "environment") WHERE "origin_flow_id" IS NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "workflow_record_state"."origin_flow_id" IS
  'Set while the record is AWAY in a sub-flow: the flow version it crossed out of. A hint used to '
  'prefer the original version on the way home, never a requirement — a return with this null, stale '
  'or unusable still completes against the active version of the flow the return arrow names.';--> statement-breakpoint

-- ── 4. WHICH RULEBOOK WAS IN FORCE ───────────────────────────────────────────────────────────────
--
-- Nullable, no backfill. Once a record can execute two flows in one lifetime, "the rules said this
-- move was allowed" stops being answerable from the record's current binding — by the time anybody
-- reads the history, the record is home and workflow_record_state says 'standard' for a move that
-- was judged under 'insurance'. Every row carries the flow it was judged under instead, so the
-- question stays answerable months and three republishes later.
--
-- Useful on EVERY row, not only on crossings, which is why it is one general column rather than a
-- pair of crossing-specific ones. Rows written before this migration keep null and read as "the
-- binding at the time", which is what they have always meant.
ALTER TABLE "status_logs" ADD COLUMN IF NOT EXISTS "flow_id" uuid;--> statement-breakpoint

COMMENT ON COLUMN "status_logs"."flow_id" IS
  'The flow version this move was JUDGED under — for a crossing, the flow the record landed in. Null '
  'on rows written before 0066 and on moves made with no flow governing the record.';--> statement-breakpoint

-- ── 5. THE COLLISION — the sharpest defect this feature would otherwise introduce ────────────────
--
-- `transition_key` is `${from_code}>${to_code}` with NO FLOW IN IT, and it keys all three of
-- workflow_auto_fired_uq, approval_requests_open_uq and approval_requests_granted_idx. That was
-- sound while one record could only ever execute one flow. The moment a record executes TWO — which
-- is what this migration makes possible — an approval granted for `priced>confirmed` under the
-- standard flow is spendable by an identically-named arrow under the insurance flow, and an
-- `auto_once` that fired under the first flow suppresses the same-named arrow under the second. An
-- approval crossing a governance boundary is a correctness bug, not a nuisance.
--
-- THE FIX IS A COLUMN, NOT A CHANGE TO THE STRING. Qualifying the key as `${flow_key}:${from}>${to}`
-- looks tidier and is not: actions.ts destructures `transitionKey.split(">")` and puts `from` into
-- the OUTBOUND WEBHOOK PAYLOAD, approvals.service.ts derives toCode from it, and StatusLogs.tsx and
-- Approvals.tsx render it with `.replace(">", " → ")`. Changing the string changes an external
-- contract and three screens. A separate flow_id column gives the same guarantee with none of that,
-- and existing rows keep working unchanged.
ALTER TABLE "workflow_auto_fired" ADD COLUMN IF NOT EXISTS "flow_id" uuid;--> statement-breakpoint

-- NULLS NOT DISTINCT (PG 15+; this server is 16.14) so the pre-0066 rows, which all carry flow_id
-- null, keep colliding with each other exactly as they did — without it every historical row would
-- become unique against every other and auto_once would stop suppressing anything for records that
-- predate this migration.
-- DROP CONSTRAINT, not DROP INDEX. Verified on the live database: workflow_auto_fired_uq is a UNIQUE
-- CONSTRAINT (pg_constraint.contype = 'u') whose index Postgres owns, so `drop index` is refused with
-- "constraint ... requires it". Its two approval siblings below ARE plain indexes — a partial index
-- cannot back a constraint — which is why they are dropped the other way. Replacing it with a bare
-- unique index is deliberate and safe: the only writer uses `ON CONFLICT DO NOTHING` with no conflict
-- target, which arbitrates against any unique index just as it did against the constraint, and the
-- new definition needs NULLS NOT DISTINCT, which a table constraint cannot express before PG 18.
ALTER TABLE "workflow_auto_fired" DROP CONSTRAINT "workflow_auto_fired_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_auto_fired_uq" ON "workflow_auto_fired"
  ("tenant_id", "environment", "entity_type", "entity_id", "flow_id", "transition_key")
  NULLS NOT DISTINCT;--> statement-breakpoint

COMMENT ON COLUMN "workflow_auto_fired"."flow_id" IS
  'The flow the automatic move fired under. Part of the uniqueness key since 0066: the same '
  'from>to arrow can exist in two flows one record executes, and one flow''s firing must not '
  'suppress the other''s.';--> statement-breakpoint

ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "flow_id" uuid;--> statement-breakpoint

DROP INDEX IF EXISTS "approval_requests_open_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_uq" ON "approval_requests"
  ("tenant_id", "environment", "entity_type", "entity_id", "flow_id", "transition_key")
  NULLS NOT DISTINCT
  WHERE ("overall_status" = 'pending' AND "transition_key" IS NOT NULL);--> statement-breakpoint

DROP INDEX IF EXISTS "approval_requests_granted_idx";--> statement-breakpoint
CREATE INDEX "approval_requests_granted_idx" ON "approval_requests"
  ("tenant_id", "environment", "entity_id", "flow_id", "transition_key")
  WHERE ("overall_status" = 'approved' AND "consumed_at" IS NULL);--> statement-breakpoint

COMMENT ON COLUMN "approval_requests"."flow_id" IS
  'The flow the move needing sign-off was judged under. Part of the open-request key and the granted '
  'lookup since 0066, so a signature given for priced>confirmed under one flow cannot be spent on '
  'the identically-named arrow of another.';--> statement-breakpoint

-- ── 6. THE FREEZE ────────────────────────────────────────────────────────────────────────────────
--
-- to_flow_key joins the frozen transition tuple. It must: it is the most semantic thing an arrow can
-- carry — it decides which RULEBOOK governs the order after the move — and an admin able to re-aim a
-- live border would send orders already crossing it into a different flow with no version change and
-- no audit trail anywhere.
--
-- CREATE OR REPLACE REPLACES THE WHOLE FUNCTION BODY. Every column already frozen is restated below
-- verbatim on BOTH sides of the IS DISTINCT FROM: the step tuple stays at exactly six
-- (item_status_id, vendor_status_id, status_domain, is_entry, is_terminal, owner_roles) and the
-- transition tuple goes from eleven to twelve. Omitting one would not raise an error anywhere — it
-- would silently un-freeze that column on every active flow in the system.
CREATE OR REPLACE FUNCTION public.workflow_child_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
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
        NEW.priority, NEW.handoff, NEW.gates, NEW.auto_advance, NEW.auto_once, NEW.actions,
        NEW.to_flow_key)
       IS DISTINCT FROM
       (OLD.from_step_id, OLD.to_step_id, OLD.condition, OLD.requires_approval, OLD.allowed_roles,
        OLD.priority, OLD.handoff, OLD.gates, OLD.auto_advance, OLD.auto_once, OLD.actions,
        OLD.to_flow_key)
    THEN
      RAISE EXCEPTION 'flow is % — a transition''s rule cannot change; publish a new version', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

-- ── 7. A REMOVED RECORD IS NOT "AWAY" ────────────────────────────────────────────────────────────
--
-- 0062's audit trigger records a deleted RFQ or order into workflow_record_removals and deliberately
-- leaves workflow_record_state alone. That was harmless while the row said only "which flow is this
-- executing"; with origin_flow_id it also says "this record is currently away in a sub-flow and owes
-- a return", which a record that no longer exists does not. Left set, the row counts forever in
-- workflow_record_state_away_idx, appears in any list of records to chase, and — if the id is ever
-- reused — hands a re-entering record a stale origin to be sent home to.
--
-- Clearing the one column rather than deleting the row: the row is what My Work and the run log join
-- to, and 0062's whole thesis is that a deleted record's history must still resolve.
--
-- The whole function is restated because CREATE OR REPLACE replaces the whole body.
CREATE OR REPLACE FUNCTION public.record_removal_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
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

  -- The record has left the system, so it is not away in a sub-flow and owes nobody a return.
  UPDATE public.workflow_record_state
     SET origin_flow_id = NULL, updated_at = now()
   WHERE tenant_id = (j->>'tenant_id')::uuid
     AND environment = coalesce(j->>'environment', 'live')::public.environment_type
     AND entity_type = v_entity
     AND entity_id = (j->>'id')::uuid
     AND origin_flow_id IS NOT NULL;

  RETURN OLD;
END $function$;
