CREATE TABLE IF NOT EXISTS "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text,
	"template" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_log_tenant_idx" ON "notification_log" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_log_created_by_idx" ON "notification_log" USING btree ("created_by");