-- 0047_workflow_engine — flows, steps, transitions, and per-record flow binding (QNEW-64).
--
-- Reviewed adversarially before application (51 objections raised, 37 upheld). Everything below the
-- generated DDL exists because `drizzle-kit generate` cannot know about it, and without it the
-- one-way migration would land broken on production:
--
--   * apply_tenant_rls — without it verify-rls.ts fails the deploy AFTER these tables are committed,
--     and they are born readable/writable by qvm_app across every workspace and both environments.
--     It also attaches trg_set_row_audit, which is why all four tables use `audit` not `timestamps`.
--   * table CHECK constraints — the repo's FIRST real table checks (every `check (` in migrations
--     today is an RLS `with check` clause). Deliberate deviation, flagged here.
--   * freeze triggers — "activating a flow freezes it" was prose. Without these, the natural canvas
--     save (delete children, reinsert) silently rewrites the rules that in-flight orders are being
--     judged by, which is the exact failure the versioning design exists to prevent.
--
-- Composite FKs (also a first here) pin every child to its parent's flow + tenant + environment +
-- domain: RI triggers bypass RLS, and the only actor managing flows is internal, so the tenant
-- policy constrains nothing on this path.

CREATE TYPE "public"."workflow_flow_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "environment_type" DEFAULT 'live' NOT NULL,
	"flow_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text NOT NULL,
	"status" "workflow_flow_status" DEFAULT 'draft' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status_domain" "status_domain" DEFAULT 'item' NOT NULL,
	"selection_condition" jsonb,
	"canvas" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "workflow_flows_key_version_uq" UNIQUE("tenant_id","environment","flow_key","version"),
	CONSTRAINT "workflow_flows_id_scope_uq" UNIQUE("id","tenant_id","environment"),
	CONSTRAINT "workflow_flows_id_scope_domain_uq" UNIQUE("id","tenant_id","environment","status_domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_record_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "environment_type" DEFAULT 'live' NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"status_domain" "status_domain" NOT NULL,
	"flow_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "workflow_record_state_entity_uq" UNIQUE("tenant_id","environment","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "environment_type" DEFAULT 'live' NOT NULL,
	"flow_id" uuid NOT NULL,
	"status_domain" "status_domain" NOT NULL,
	"item_status_id" uuid,
	"vendor_status_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_entry" boolean DEFAULT false NOT NULL,
	"is_terminal" boolean DEFAULT false NOT NULL,
	"sla_hours" integer,
	"canvas_x" double precision DEFAULT 0 NOT NULL,
	"canvas_y" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "workflow_steps_id_flow_uq" UNIQUE("id","flow_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"environment" "environment_type" DEFAULT 'live' NOT NULL,
	"flow_id" uuid NOT NULL,
	"from_step_id" uuid NOT NULL,
	"to_step_id" uuid NOT NULL,
	"label_en" text,
	"label_ar" text,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"allowed_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "workflow_transitions_edge_uq" UNIQUE("flow_id","from_step_id","to_step_id","priority")
);
--> statement-breakpoint
-- (0046 added `environment` to 9 operational tables by hand, so drizzle's snapshot did not know
--  about them and re-emitted the same ALTERs here. Removed: they are already applied.)
DO $$ BEGIN
 ALTER TABLE "workflow_flows" ADD CONSTRAINT "workflow_flows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_record_state" ADD CONSTRAINT "workflow_record_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_record_state" ADD CONSTRAINT "workflow_record_state_flow_scope_fk" FOREIGN KEY ("flow_id","tenant_id","environment","status_domain") REFERENCES "public"."workflow_flows"("id","tenant_id","environment","status_domain") ON DELETE no action ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_item_status_id_item_statuses_id_fk" FOREIGN KEY ("item_status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_vendor_status_id_vendor_statuses_id_fk" FOREIGN KEY ("vendor_status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_flow_scope_fk" FOREIGN KEY ("flow_id","tenant_id","environment","status_domain") REFERENCES "public"."workflow_flows"("id","tenant_id","environment","status_domain") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_flow_scope_fk" FOREIGN KEY ("flow_id","tenant_id","environment") REFERENCES "public"."workflow_flows"("id","tenant_id","environment") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_from_step_fk" FOREIGN KEY ("from_step_id","flow_id") REFERENCES "public"."workflow_steps"("id","flow_id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_to_step_fk" FOREIGN KEY ("to_step_id","flow_id") REFERENCES "public"."workflow_steps"("id","flow_id") ON DELETE cascade ON UPDATE cascade;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_flows_active_uq" ON "workflow_flows" USING btree ("tenant_id","environment","flow_key") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_flows_default_uq" ON "workflow_flows" USING btree ("tenant_id","environment","status_domain") WHERE is_default and status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_flows_tenant_idx" ON "workflow_flows" USING btree ("tenant_id","environment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_flows_status_idx" ON "workflow_flows" USING btree ("tenant_id","environment","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_record_state_flow_idx" ON "workflow_record_state" USING btree ("flow_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_flow_item_status_uq" ON "workflow_steps" USING btree ("flow_id","item_status_id") WHERE item_status_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_flow_vendor_status_uq" ON "workflow_steps" USING btree ("flow_id","vendor_status_id") WHERE vendor_status_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_entry_uq" ON "workflow_steps" USING btree ("flow_id") WHERE is_entry;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_steps_flow_idx" ON "workflow_steps" USING btree ("flow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_steps_tenant_idx" ON "workflow_steps" USING btree ("tenant_id","environment");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transitions_eval_idx" ON "workflow_transitions" USING btree ("flow_id","from_step_id","priority");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transitions_from_step_idx" ON "workflow_transitions" USING btree ("from_step_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transitions_to_step_idx" ON "workflow_transitions" USING btree ("to_step_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_transitions_tenant_idx" ON "workflow_transitions" USING btree ("tenant_id","environment");

--> statement-breakpoint
-- ── RLS, audit trigger, grants ───────────────────────────────────────────────
SELECT public.apply_tenant_rls('workflow_flows');--> statement-breakpoint
SELECT public.apply_tenant_rls('workflow_steps');--> statement-breakpoint
SELECT public.apply_tenant_rls('workflow_transitions');--> statement-breakpoint
SELECT public.apply_tenant_rls('workflow_record_state');--> statement-breakpoint

-- ── CHECK constraints ────────────────────────────────────────────────────────
-- exactly one status id, and it must match the step's declared vocabulary
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_status_one_of" CHECK (
  num_nonnulls(item_status_id, vendor_status_id) = 1
  AND (status_domain = 'item') = (item_status_id IS NOT NULL)
);--> statement-breakpoint
-- a non-default flow may not go live without routing decided (NULL = never auto-selected)
ALTER TABLE "workflow_flows" ADD CONSTRAINT "workflow_flows_selection_complete" CHECK (
  status <> 'active' OR is_default OR selection_condition IS NOT NULL
);--> statement-breakpoint
-- a self-loop is inert: StatusService treats X→X as a no-op, so the rule could never fire
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_no_self_loop"
  CHECK (from_step_id <> to_step_id);--> statement-breakpoint

-- ── freeze: a flow that is no longer a draft is immutable in the ways that matter ─────
CREATE OR REPLACE FUNCTION public.workflow_child_freeze() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
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

  -- UPDATE: layout and cosmetics stay editable; the semantics do not
  IF TG_TABLE_NAME = 'workflow_steps' THEN
    IF (NEW.item_status_id, NEW.vendor_status_id, NEW.status_domain, NEW.is_entry, NEW.is_terminal)
       IS DISTINCT FROM
       (OLD.item_status_id, OLD.vendor_status_id, OLD.status_domain, OLD.is_entry, OLD.is_terminal)
    THEN
      RAISE EXCEPTION 'flow is % — a step''s status or role cannot change; publish a new version', v_status
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
END $$;--> statement-breakpoint

CREATE TRIGGER trg_workflow_steps_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_steps
  FOR EACH ROW EXECUTE FUNCTION public.workflow_child_freeze();--> statement-breakpoint
CREATE TRIGGER trg_workflow_transitions_freeze BEFORE INSERT OR UPDATE OR DELETE ON public.workflow_transitions
  FOR EACH ROW EXECUTE FUNCTION public.workflow_child_freeze();--> statement-breakpoint

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
    IF (NEW.flow_key, NEW.version, NEW.environment, NEW.status_domain, NEW.selection_condition)
       IS DISTINCT FROM
       (OLD.flow_key, OLD.version, OLD.environment, OLD.status_domain, OLD.selection_condition)
    THEN
      RAISE EXCEPTION 'flow is % — identity and routing are frozen; publish a new version', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

CREATE TRIGGER trg_workflow_flows_freeze BEFORE UPDATE OR DELETE ON public.workflow_flows
  FOR EACH ROW EXECUTE FUNCTION public.workflow_flow_freeze();
