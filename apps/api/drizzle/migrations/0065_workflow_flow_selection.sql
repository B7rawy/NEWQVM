-- 0065_workflow_flow_selection.sql — MORE THAN ONE WORKFLOW PER WORKSPACE.
--
-- `workflow_flows.selection_condition` has been stored, validated at activation and returned to the
-- builder since the engine was written (0047), and read by NOTHING: the guard resolved the flow with
-- `status = 'active' and is_default limit 1`, so a workspace effectively had one flow per status
-- domain and a second one could be drawn, activated, and would never govern a single record. The
-- owner's case is two flows side by side — an insurance flow and a cash flow — with the right one
-- chosen per record. Evaluating the condition is a code change (status.service.ts). This migration
-- adds the ONE thing the data model was missing for it: an order between flows that both match.
--
-- WHY A COLUMN AND NOT "whichever the planner returns". Two flows may legitimately match the same
-- record — "Who pays is insurance" and "Delivery or pickup is pickup" both hold for an insurance
-- pickup. Something has to decide, and it has to decide the SAME WAY on every run, or the rulebook a
-- record executes depends on a row order Postgres never promised. `workflow_transitions` already
-- solved exactly this problem for two arrows joining the same pair of steps, with
-- `order by priority desc, created_at asc`. This is that rule, applied one level up, rather than a
-- second ordering rule an admin would have to learn separately.
--
-- DEFAULT 0 SO NOTHING MOVES. Every existing flow gets the same priority, which leaves the order
-- exactly what it was implicitly: oldest first. The provisioned default flow keeps governing every
-- record, because the default is not ranked at all — it is the FALLBACK, consulted only when no
-- conditional flow matched (see bindOnEntry).
ALTER TABLE "workflow_flows"
  ADD COLUMN IF NOT EXISTS "selection_priority" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

COMMENT ON COLUMN "workflow_flows"."selection_priority" IS
  'Tie-break between flows whose selection_condition both match a record entering: highest first, then oldest. Ignored on the is_default flow, which is the fallback rather than a candidate.';--> statement-breakpoint

-- ── the freeze has to cover it, or the rules change under records already executing them ─────────
--
-- CREATE OR REPLACE REPLACES THE WHOLE FUNCTION, so every column already in the frozen tuple is
-- carried over here verbatim; dropping one would silently un-freeze it. The only change is
-- selection_priority joining flow_key, version, environment, status_domain and selection_condition.
--
-- It belongs there for the same reason selection_condition does, and the reason is not symmetry:
-- these two columns together ARE the routing decision, and routing decides which rulebook a record
-- picks up when it is born. An active flow whose priority could still be edited would let somebody
-- reorder live flows in place — and the workspace would then have two flows live whose relative
-- order is not the one any of its published versions describes. Publishing a new version is the
-- supported way to change it, exactly as with the condition itself.
CREATE OR REPLACE FUNCTION public.workflow_flow_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft flow can be deleted — retire it instead'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- status moves forward only: draft → active → retired
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'draft'  AND NEW.status IN ('active', 'retired'))
         OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'illegal flow status change % → %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status <> 'draft' THEN
    IF (NEW.flow_key, NEW.version, NEW.environment, NEW.status_domain, NEW.selection_condition,
        NEW.selection_priority)
       IS DISTINCT FROM
       (OLD.flow_key, OLD.version, OLD.environment, OLD.status_domain, OLD.selection_condition,
        OLD.selection_priority)
    THEN
      RAISE EXCEPTION 'flow is % — identity and routing are frozen; publish a new version', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
