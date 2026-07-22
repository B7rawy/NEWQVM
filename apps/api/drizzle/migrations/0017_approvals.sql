CREATE TYPE "public"."approval_action_type" AS ENUM('approve', 'reject', 'reassign');--> statement-breakpoint
CREATE TYPE "public"."approval_level_mode" AS ENUM('sequential', 'parallel');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action" "approval_action_type" NOT NULL,
	"reassigned_to_user_id" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"level_order" integer NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"level_mode" "approval_level_mode" DEFAULT 'sequential' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"requested_by" uuid,
	"current_level" integer DEFAULT 1 NOT NULL,
	"overall_status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_reassigned_to_user_id_users_id_fk" FOREIGN KEY ("reassigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_levels" ADD CONSTRAINT "approval_levels_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_policy_id_approval_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."approval_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_actions_tenant_idx" ON "approval_actions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_actions_request_idx" ON "approval_actions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_actions_actor_idx" ON "approval_actions" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_actions_reassigned_idx" ON "approval_actions" USING btree ("reassigned_to_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_levels_uq" ON "approval_levels" USING btree ("policy_id","level_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_levels_tenant_idx" ON "approval_levels" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_levels_policy_idx" ON "approval_levels" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_levels_approver_idx" ON "approval_levels" USING btree ("approver_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_policies_tenant_idx" ON "approval_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_policies_entity_idx" ON "approval_policies" USING btree ("tenant_id","entity_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_tenant_idx" ON "approval_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_policy_idx" ON "approval_requests" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_entity_idx" ON "approval_requests" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_requested_by_idx" ON "approval_requests" USING btree ("requested_by");