CREATE TYPE "public"."tenant_workshop_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_workshops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workshop_id" uuid NOT NULL,
	"status" "tenant_workshop_status" DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "workshop_branches" DROP CONSTRAINT "workshop_branches_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "workshops" DROP CONSTRAINT "workshops_tenant_id_tenants_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "workshop_branches_tenant_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "workshops_tenant_idx";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_workshops" ADD CONSTRAINT "tenant_workshops_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_workshops" ADD CONSTRAINT "tenant_workshops_workshop_id_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_workshops" ADD CONSTRAINT "tenant_workshops_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_workshops_tenant_workshop_uq" ON "tenant_workshops" USING btree ("tenant_id","workshop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_workshops_tenant_idx" ON "tenant_workshops" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_workshops_workshop_idx" ON "tenant_workshops" USING btree ("workshop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_workshops_linked_by_idx" ON "tenant_workshops" USING btree ("linked_by");--> statement-breakpoint
ALTER TABLE "workshop_branches" DROP COLUMN IF EXISTS "tenant_id" CASCADE;--> statement-breakpoint
ALTER TABLE "workshops" DROP COLUMN IF EXISTS "tenant_id" CASCADE;--> statement-breakpoint
-- workshops/branches are now GLOBAL (shared across workspaces); the link table carries tenant RLS.
-- CASCADE above dropped their old tenant_isolation policies; re-apply the correct policies.
SELECT public.apply_global_rls('workshops');--> statement-breakpoint
SELECT public.apply_global_rls('workshop_branches');--> statement-breakpoint
SELECT public.apply_tenant_rls('tenant_workshops');