CREATE TYPE "public"."platform_role" AS ENUM('super_admin', 'staff', 'account_manager', 'purchasing', 'part_extractor', 'finance_manager', 'pricing_supervisor');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "platform_role" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_members_user_uq" ON "platform_members" USING btree ("user_id");