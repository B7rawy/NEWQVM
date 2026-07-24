-- 0033_activation_status — QNEW-71 activation gate (Slice 6a).
-- A self-registered counterparty is created 'pending' and can log in immediately; it activates once
-- it provides its identifier (individual→mobile) with no conflict. Existing/admin-created rows are
-- 'active'. Additive + safe (default 'active').
DO $$ BEGIN CREATE TYPE "public"."activation_status" AS ENUM('pending','active','suspended','rejected'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TABLE "vendors"   ADD COLUMN IF NOT EXISTS "activation_status" "public"."activation_status" NOT NULL DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "workshops" ADD COLUMN IF NOT EXISTS "activation_status" "public"."activation_status" NOT NULL DEFAULT 'active';
