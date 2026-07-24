-- 0038_service_providers — QNEW-71 AC11: the third counterparty family, mirroring vendors/workshops.
-- Global directory entity (individual|company, same dedup keys, same directory/tenant RLS split).

DO $$ BEGIN CREATE TYPE "provider_scope" AS ENUM ('internal', 'external'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "service_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "legal_name" text NOT NULL,
  "counterparty_type" "counterparty_type" DEFAULT 'company' NOT NULL,
  "activation_status" "activation_status" DEFAULT 'active' NOT NULL,
  "scope" "provider_scope" DEFAULT 'external' NOT NULL,
  "service_type" text,
  "commercial_registration_number" text,
  "tax_number" text,
  "primary_email" text,
  "primary_phone" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_providers_company_tax_uq" ON "service_providers" ("tax_number")
  WHERE ("counterparty_type" = 'company' AND "tax_number" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_providers_individual_mobile_uq" ON "service_providers" ("primary_phone")
  WHERE ("counterparty_type" = 'individual' AND "primary_phone" IS NOT NULL);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "service_provider_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_provider_id" uuid NOT NULL REFERENCES "service_providers"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id"),
  "is_provider_admin" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_provider_users_sp_user_uq" ON "service_provider_users" ("service_provider_id", "user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_provider_users_user_idx" ON "service_provider_users" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_service_providers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "service_provider_id" uuid NOT NULL REFERENCES "service_providers"("id"),
  "status" "tenant_vendor_status" DEFAULT 'active' NOT NULL,
  "classification" text,
  "agreement" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "linked_by" uuid REFERENCES "users"("id"),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  "created_by" uuid,
  "updated_by" uuid
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_service_providers_uq" ON "tenant_service_providers" ("tenant_id", "service_provider_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_service_providers_tenant_idx" ON "tenant_service_providers" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_service_providers_sp_idx" ON "tenant_service_providers" ("service_provider_id");--> statement-breakpoint

-- RLS: directory tables global (internal-write), the link table tenant-scoped. Then the same
-- individual-read privacy as vendors/workshops (0032): individuals visible only to linked workspaces.
SELECT public.apply_global_rls('service_providers');--> statement-breakpoint
SELECT public.apply_global_rls('service_provider_users');--> statement-breakpoint
SELECT public.apply_tenant_rls('tenant_service_providers');--> statement-breakpoint
DROP POLICY IF EXISTS "global_read" ON "service_providers";--> statement-breakpoint
DO $$ BEGIN
CREATE POLICY "directory_read" ON "service_providers" FOR SELECT USING (
  counterparty_type = 'company'
  OR public.app_is_internal()
  OR EXISTS (SELECT 1 FROM tenant_service_providers tsp
             WHERE tsp.service_provider_id = service_providers.id AND tsp.tenant_id = public.current_tenant_id())
);
EXCEPTION WHEN duplicate_object THEN null; END $$;
