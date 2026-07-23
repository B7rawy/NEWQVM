-- Workshop portal identity: which global user belongs to which global workshop (mirrors vendor_users).
-- Global table (no tenant_id); a workshop user reaches a workspace via tenant_workshops (see AuthGuard).
CREATE TABLE IF NOT EXISTS "workshop_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workshop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_workshop_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_users" ADD CONSTRAINT "workshop_users_workshop_id_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_users" ADD CONSTRAINT "workshop_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workshop_users_workshop_user_uq" ON "workshop_users" USING btree ("workshop_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_users_user_idx" ON "workshop_users" USING btree ("user_id");--> statement-breakpoint
-- global RLS (global_read + is_internal global_write) + audit trigger + qvm_app grants, same as vendor_users
SELECT public.apply_global_rls('workshop_users');
