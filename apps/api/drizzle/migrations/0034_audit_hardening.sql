-- 0034_audit_hardening — fixes from the full backend/DB audit.
-- (1) platform_audit was created (0029) WITHOUT RLS: the one-shot policy loop in 0001 only covered
--     tables existing at that time, so qvm_app had unrestricted cross-tenant read/write/delete on
--     the admin/impersonation audit ledger. Lock it down: reads internal-only; inserts internal OR
--     the acting tenant's own row; NO update/delete policy at all → the ledger is append-only for
--     the app role even in internal context.
-- (2) DB-level idempotency backstops the services assume (they check-then-insert): one client
--     invoice per order; one purchase order per (order, vendor).
-- (3) Rename the manually-created FK on counterparty_submissions to drizzle's conventional name so
--     schema.ts ↔ DB stay in lockstep.
-- All statements idempotent (safe to re-run).

-- ── (1) platform_audit RLS ───────────────────────────────────────────────────
ALTER TABLE "platform_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
CREATE POLICY "pa_read" ON "platform_audit" FOR SELECT USING (public.app_is_internal());
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
CREATE POLICY "pa_insert" ON "platform_audit" FOR INSERT
  WITH CHECK (public.app_is_internal() OR tenant_id = public.current_tenant_id());
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ── (2) idempotency backstops ────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_order_uq" ON "invoices" ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "purchase_orders_order_vendor_uq" ON "purchase_orders" ("order_id", "vendor_id");--> statement-breakpoint

-- ── (3) FK name alignment (manual 0031 name → drizzle convention) ────────────
DO $$ BEGIN
ALTER TABLE "counterparty_submissions"
  RENAME CONSTRAINT "counterparty_submissions_import_batch_id_fk"
  TO "counterparty_submissions_import_batch_id_import_batches_id_fk";
EXCEPTION WHEN undefined_object THEN null; END $$;
