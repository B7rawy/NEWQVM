-- 0042_retire_sandbox_workspace — one sandbox mechanism, not two.
--
-- Before 0040/0041 there were TWO unrelated things both called "sandbox":
--   1. tenants.is_sandbox — a whole separate WORKSPACE marked as fake. Its only real effect was
--      suppressing notification dispatch. Its rows were still written with environment='live',
--      which is precisely how a "sandbox" RFQ ended up in a real vendor's live portal.
--   2. the Live/Sandbox toggle — a per-request environment, which after 0040/0041 is a real,
--      DB-enforced boundary that every workspace has.
--
-- (2) strictly subsumes (1): the toggle suppresses dispatch the same way, isolates data (which the
-- workspace flag never did), and does not require standing up a parallel workspace with its own
-- members, vendors and workshops just to run a test. Keeping both leaves a weaker second mechanism
-- that looks like isolation and is not — the worst kind of safety feature.

-- Remove the flag itself. The environment column (0040) is now the single source of truth.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "is_sandbox";--> statement-breakpoint

-- Retire the demo workspace ONLY if it is genuinely empty. If any deployment ever put real work in
-- it, it survives as an ordinary workspace (it has just lost a flag that did nothing for it).
DELETE FROM tenants t
WHERE t.slug = 'sandbox'
  AND NOT EXISTS (SELECT 1 FROM rfqs               WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM orders             WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_vendors     WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_workshops   WHERE tenant_id = t.id);
