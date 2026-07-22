CREATE TYPE "public"."pricing_scope_type" AS ENUM('global', 'region', 'client_branch');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_pricing_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"scope_type" "pricing_scope_type" DEFAULT 'global' NOT NULL,
	"region_id" uuid,
	"workshop_branch_id" uuid,
	"adjustment_type" "adjustment_type" DEFAULT 'discount' NOT NULL,
	"adjustment_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_stock_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"raw_part_number" text,
	"cleaned_part_number" text NOT NULL,
	"name_en" text,
	"name_ar" text,
	"part_type" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"wholesale_price" numeric(14, 2),
	"retail_price" numeric(14, 2),
	"price_before_discount" numeric(14, 2),
	"upload_source" text DEFAULT 'excel_upload' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_pricing_policies" ADD CONSTRAINT "vendor_pricing_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_pricing_policies" ADD CONSTRAINT "vendor_pricing_policies_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_pricing_policies" ADD CONSTRAINT "vendor_pricing_policies_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_pricing_policies" ADD CONSTRAINT "vendor_pricing_policies_workshop_branch_id_workshop_branches_id_fk" FOREIGN KEY ("workshop_branch_id") REFERENCES "public"."workshop_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_stock_items" ADD CONSTRAINT "vendor_stock_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_stock_items" ADD CONSTRAINT "vendor_stock_items_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_pricing_tenant_idx" ON "vendor_pricing_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_pricing_vendor_idx" ON "vendor_pricing_policies" USING btree ("tenant_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_pricing_region_idx" ON "vendor_pricing_policies" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_pricing_branch_idx" ON "vendor_pricing_policies" USING btree ("workshop_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_stock_uq" ON "vendor_stock_items" USING btree ("tenant_id","vendor_id","cleaned_part_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_stock_tenant_idx" ON "vendor_stock_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_stock_vendor_idx" ON "vendor_stock_items" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_stock_part_idx" ON "vendor_stock_items" USING btree ("tenant_id","cleaned_part_number");