-- 0068_drop_duplicate_indexes.sql — four indexes that index exactly what a UNIQUE already indexes.
--
-- Found by auditing the deployed database, which is the only way this class of thing is ever found:
-- each was added in a different migration, months apart, by someone who could see their own file and
-- not the constraint already standing on the same columns.
--
-- A duplicate index is not free. Every INSERT and every UPDATE of those columns writes both, both
-- occupy cache, both are rebuilt by a REINDEX, and the planner costs both on every query. It buys
-- nothing: a UNIQUE constraint IS a btree index, and that index serves every read the plain one
-- could. Each pair was compared column for column before anything was dropped:
--
--   invoices_order_idx                  = invoices_order_uq                  (order_id)
--   pricing_basis_scope_idx             = pricing_basis_scope_uq             (tenant_id, payer_scenario, insurance_company_id)
--   vendor_pricing_scope_idx            = vendor_pricing_scope_uq            (tenant_id, vendor_id, scope_type, region_id, workshop_branch_id)
--   workflow_failure_digests_latest_idx = workflow_failure_digests_window_uq (tenant_id, environment, window_end)
--
-- THE LAST ONE LOOKS DIFFERENT AND IS NOT: same columns, but the last one DESC. A btree is walked in
-- either direction, so `order by window_end desc` is served from the ascending index by scanning
-- backwards at the same cost. The two NULLS NOT DISTINCT uniques are no obstacle either — that
-- clause changes what the constraint REFUSES, not what the index CONTAINS.
--
-- Only the plain index is dropped in each pair, never the unique: the unique enforces a rule
-- somebody wrote down, and the plain one is a copy of its shape.
--
-- THE FIRST THREE ARE DECLARED IN THE DRIZZLE SCHEMA and were removed from it in the same change,
-- which is why this file is generated rather than hand-written — dropping them in SQL alone would
-- have had `db:generate` propose recreating them, reopening the drift 0067 had just closed. The
-- fourth was created by raw SQL and is invisible to drizzle, so it is added here by hand.

DROP INDEX IF EXISTS "invoices_order_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "pricing_basis_scope_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "vendor_pricing_scope_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "workflow_failure_digests_latest_idx";
