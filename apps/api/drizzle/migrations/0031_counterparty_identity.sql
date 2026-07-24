-- 0031_counterparty_identity — Counterparty Identity & Governed Onboarding (QNEW-71 + onboarding pipeline).
-- Slice 1 (schema foundation): identity classification + scoped dedup keys on the directory
-- (vendors, workshops) + the submission/review queue + Excel-import staging tables.
--
-- Locked design decisions (see QNEW-71 reconciliation):
--   • Company key  = tax_number (unique among companies).   Individual key = mobile (unique among individuals).
--   • "entity_type" in QNEW-71 is modelled as the column `counterparty_type` here, to avoid colliding
--     with the pre-existing polymorphic enum type `entity_type` (attachments/status_logs/notes).
--   • Writes to the global directory stay internal-only (global_write). The workspace writes only to the
--     tenant-scoped submission/import tables (its own data). Approval promotes a submission → directory
--     via an internal service (Slice 2).
-- Additive & safe: existing rows become 'company' and keep working; the dedup keys are PARTIAL, so they
-- only bite when the identifier is actually present (all seeded rows have NULL tax/mobile → untouched).

-- ── enums ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "public"."counterparty_type" AS ENUM('individual','company'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."submission_kind" AS ENUM('vendor','workshop','service_provider'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."submission_source" AS ENUM('manual','excel_import'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."submission_status" AS ENUM('pending','approved','merged','rejected'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."import_batch_status" AS ENUM('uploaded','validated','submitted','completed','failed'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ── directory: classification + parity contact columns ───────────────────────
ALTER TABLE "vendors"   ADD COLUMN IF NOT EXISTS "counterparty_type" "public"."counterparty_type" NOT NULL DEFAULT 'company';--> statement-breakpoint
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "counterparty_type" "public"."counterparty_type" NOT NULL DEFAULT 'company';--> statement-breakpoint
-- workshops lacked contact columns vendors already have; add them for parity + as dedup match signals.
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "primary_phone" text;--> statement-breakpoint
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "primary_email" text;--> statement-breakpoint
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "commercial_registration_number" text;--> statement-breakpoint

-- ── scoped dedup keys (partial unique): company→tax_number, individual→mobile ─
-- The same mobile may be an individual's identifier AND a company's contact with no conflict:
-- the individual index only covers counterparty_type='individual' rows.
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_company_tax_uq" ON "vendors" ("tax_number")
  WHERE "counterparty_type" = 'company' AND "tax_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendors_individual_mobile_uq" ON "vendors" ("primary_phone")
  WHERE "counterparty_type" = 'individual' AND "primary_phone" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workshops_company_tax_uq" ON "workshops" ("tax_number")
  WHERE "counterparty_type" = 'company' AND "tax_number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workshops_individual_mobile_uq" ON "workshops" ("primary_phone")
  WHERE "counterparty_type" = 'individual' AND "primary_phone" IS NOT NULL;--> statement-breakpoint

-- ── import batches (tenant-scoped Excel jobs) ────────────────────────────────
CREATE TABLE IF NOT EXISTS "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "public"."submission_kind" NOT NULL,
	"filename" text,
	"status" "public"."import_batch_status" NOT NULL DEFAULT 'uploaded',
	"total_rows" integer NOT NULL DEFAULT 0,
	"valid_rows" integer NOT NULL DEFAULT 0,
	"error_rows" integer NOT NULL DEFAULT 0,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_batches_tenant_idx" ON "import_batches" ("tenant_id");--> statement-breakpoint

-- ── counterparty submissions (tenant-scoped review queue) ────────────────────
CREATE TABLE IF NOT EXISTS "counterparty_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "public"."submission_kind" NOT NULL,
	"counterparty_type" "public"."counterparty_type" NOT NULL DEFAULT 'company',
	"legal_name" text,
	"tax_number" text,
	"commercial_registration_number" text,
	"mobile" text,
	"email" text,
	"classification" text,
	"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"source" "public"."submission_source" NOT NULL DEFAULT 'manual',
	"import_batch_id" uuid,
	"status" "public"."submission_status" NOT NULL DEFAULT 'pending',
	"match_candidates" jsonb NOT NULL DEFAULT '[]'::jsonb,
	"resolved_entity_id" uuid,
	"review_notes" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"submitted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "counterparty_submissions" ADD CONSTRAINT "counterparty_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "counterparty_submissions" ADD CONSTRAINT "counterparty_submissions_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "counterparty_submissions" ADD CONSTRAINT "counterparty_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "counterparty_submissions" ADD CONSTRAINT "counterparty_submissions_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "counterparty_submissions_tenant_idx" ON "counterparty_submissions" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "counterparty_submissions_status_idx" ON "counterparty_submissions" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "counterparty_submissions_kind_idx" ON "counterparty_submissions" ("kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "counterparty_submissions_batch_idx" ON "counterparty_submissions" ("import_batch_id");--> statement-breakpoint

-- ── RLS + audit trigger + qvm_app grants (tenant-scoped) ─────────────────────
SELECT public.apply_tenant_rls('import_batches');--> statement-breakpoint
SELECT public.apply_tenant_rls('counterparty_submissions');
