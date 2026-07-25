-- 0046_environment_operational_logs — close a gap left by 0040.
--
-- 0040 enumerated the operational tables by walking the ones that HAD DATA and the ones the leak
-- tests could reach. Nine tenant-scoped tables were missed because they are written by nothing yet,
-- so no test could observe them leaking: every one is empty on local AND prod (verified 2026-07-25).
--
-- They are genuinely operational — they describe what happened to a specific RFQ/order/item — so a
-- sandbox record's history must not appear in the live history, and vice versa. The moment the status
-- gateway starts writing status_logs (QNEW-64/QNEW-75), the gap becomes a real leak. Fixing it now,
-- while every table is empty, is free; fixing it later is a backfill.
--
-- Deliberately NOT included (correctly SHARED across environments, same reasoning as 0040):
--   approval_policies / approval_levels, pricing + margin + calendar settings, insurance_companies,
--   drivers, entity_carrier_settings, the tenant_* link tables, counterparty_submissions,
--   import_batches, platform_audit. Those are configuration and governance, not transactions.

ALTER TABLE "status_logs"   ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_logs"     ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "pricing_logs"  ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments"   ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "signatures"    ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "notes"         ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_issues" ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_files"       ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_stock_items" ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint

-- apply_environment_rls() is idempotent (0041); this attaches the RESTRICTIVE policy to each.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['status_logs','cost_logs','pricing_logs','attachments','signatures',
                           'notes','return_issues','stock_files','vendor_stock_items']
  LOOP
    PERFORM public.apply_environment_rls(t);
  END LOOP;
END $$;
