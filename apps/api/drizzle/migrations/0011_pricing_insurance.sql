CREATE TYPE "public"."adjustment_type" AS ENUM('discount', 'markup');--> statement-breakpoint
CREATE TYPE "public"."payer_type" AS ENUM('cash_client', 'credit_client', 'insurance');--> statement-breakpoint
CREATE TYPE "public"."price_basis" AS ENUM('agency_price', 'vendor_price', 'calculated_margin');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "insurance_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"suggested_discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"file_format" text DEFAULT 'separate' NOT NULL,
	"contact_info" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agency_price_reference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"part_number" text NOT NULL,
	"price" numeric(14, 2) NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"price_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pricing_basis_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payer_scenario" "payer_type" NOT NULL,
	"insurance_company_id" uuid,
	"price_basis" "price_basis" DEFAULT 'calculated_margin' NOT NULL,
	"adjustment_type" "adjustment_type" DEFAULT 'markup' NOT NULL,
	"adjustment_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "payer_type" "payer_type" DEFAULT 'cash_client' NOT NULL;--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "insurance_company_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "insurance_companies" ADD CONSTRAINT "insurance_companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_price_reference" ADD CONSTRAINT "agency_price_reference_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_basis_settings" ADD CONSTRAINT "pricing_basis_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_basis_settings" ADD CONSTRAINT "pricing_basis_settings_insurance_company_id_insurance_companies_id_fk" FOREIGN KEY ("insurance_company_id") REFERENCES "public"."insurance_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "insurance_companies_tenant_name_uq" ON "insurance_companies" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "insurance_companies_tenant_idx" ON "insurance_companies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agency_price_ref_uq" ON "agency_price_reference" USING btree ("tenant_id","part_number","source");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agency_price_ref_tenant_idx" ON "agency_price_reference" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_basis_uq" ON "pricing_basis_settings" USING btree ("tenant_id","payer_scenario","insurance_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_basis_tenant_idx" ON "pricing_basis_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_basis_insurance_idx" ON "pricing_basis_settings" USING btree ("insurance_company_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_insurance_company_id_insurance_companies_id_fk" FOREIGN KEY ("insurance_company_id") REFERENCES "public"."insurance_companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_insurance_company_idx" ON "rfqs" USING btree ("insurance_company_id");