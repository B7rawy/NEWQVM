CREATE TYPE "public"."automation_mode" AS ENUM('suggest', 'auto');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_selection_rule_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_selection_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workshop_branch_id" uuid,
	"part_category_id" uuid,
	"city_id" uuid,
	"automation_mode" "automation_mode" DEFAULT 'suggest' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rule_vendors" ADD CONSTRAINT "vendor_selection_rule_vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rule_vendors" ADD CONSTRAINT "vendor_selection_rule_vendors_rule_id_vendor_selection_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."vendor_selection_rules"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rule_vendors" ADD CONSTRAINT "vendor_selection_rule_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rules" ADD CONSTRAINT "vendor_selection_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rules" ADD CONSTRAINT "vendor_selection_rules_workshop_branch_id_workshop_branches_id_fk" FOREIGN KEY ("workshop_branch_id") REFERENCES "public"."workshop_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rules" ADD CONSTRAINT "vendor_selection_rules_part_category_id_part_categories_id_fk" FOREIGN KEY ("part_category_id") REFERENCES "public"."part_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_selection_rules" ADD CONSTRAINT "vendor_selection_rules_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vsr_vendors_uq" ON "vendor_selection_rule_vendors" USING btree ("rule_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsr_vendors_tenant_idx" ON "vendor_selection_rule_vendors" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsr_vendors_rule_idx" ON "vendor_selection_rule_vendors" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vsr_vendors_vendor_idx" ON "vendor_selection_rule_vendors" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_selection_rules_scope_uq" ON "vendor_selection_rules" USING btree ("tenant_id","workshop_branch_id","part_category_id","city_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_selection_rules_tenant_idx" ON "vendor_selection_rules" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_selection_rules_branch_idx" ON "vendor_selection_rules" USING btree ("workshop_branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_selection_rules_category_idx" ON "vendor_selection_rules" USING btree ("part_category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_selection_rules_city_idx" ON "vendor_selection_rules" USING btree ("city_id");