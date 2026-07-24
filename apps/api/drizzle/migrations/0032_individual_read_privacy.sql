-- 0032_individual_read_privacy — QNEW-71 decision #4.
-- An INDIVIDUAL counterparty's directory row carries a personal mobile, so it must NOT be globally
-- readable. Restrict SELECT on individual rows to: internal staff, OR a workspace that is LINKED to
-- that individual (via tenant_vendors / tenant_workshops). COMPANY rows stay globally readable
-- (business data), preserving cross-workspace master-data + the internal match engine.
--
-- Replaces the blanket `global_read (using true)` (from apply_global_rls) with a conditional
-- `directory_read` on vendors + workshops. global_write (internal-only) + the audit trigger + grants
-- are untouched. NOTE: do not re-run apply_global_rls() on these tables afterwards — it would
-- re-create the permissive global_read policy and re-open the hole.

-- ── vendors ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "global_read" ON "vendors";--> statement-breakpoint
CREATE POLICY "directory_read" ON "vendors" FOR SELECT USING (
  counterparty_type = 'company'
  OR public.app_is_internal()
  OR EXISTS (
    SELECT 1 FROM tenant_vendors tv
    WHERE tv.vendor_id = vendors.id AND tv.tenant_id = public.current_tenant_id()
  )
);--> statement-breakpoint

-- ── workshops ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "global_read" ON "workshops";--> statement-breakpoint
CREATE POLICY "directory_read" ON "workshops" FOR SELECT USING (
  counterparty_type = 'company'
  OR public.app_is_internal()
  OR EXISTS (
    SELECT 1 FROM tenant_workshops tw
    WHERE tw.workshop_id = workshops.id AND tw.tenant_id = public.current_tenant_id()
  )
);
