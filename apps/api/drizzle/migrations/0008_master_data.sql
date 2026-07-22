CREATE TYPE "public"."part_source" AS ENUM('manual_purchasing', 'vendor_portal', 'excel_upload', 'invoice_ocr', 'direct_admin', 'dictionary_migration');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_category_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_variant" text NOT NULL,
	"part_category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"synonym" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "parts_master" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name_ar" text,
	"name_en" text,
	"part_category_id" uuid,
	"source" "part_source" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_category_mapping" ADD CONSTRAINT "part_category_mapping_part_category_id_part_categories_id_fk" FOREIGN KEY ("part_category_id") REFERENCES "public"."part_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "part_synonyms" ADD CONSTRAINT "part_synonyms_part_id_parts_master_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts_master"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "parts_master" ADD CONSTRAINT "parts_master_part_category_id_part_categories_id_fk" FOREIGN KEY ("part_category_id") REFERENCES "public"."part_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "part_category_mapping_variant_uq" ON "part_category_mapping" USING btree ("raw_variant");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_category_mapping_category_idx" ON "part_category_mapping" USING btree ("part_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "part_synonyms_synonym_uq" ON "part_synonyms" USING btree ("synonym");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "part_synonyms_part_idx" ON "part_synonyms" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parts_master_category_idx" ON "parts_master" USING btree ("part_category_id");