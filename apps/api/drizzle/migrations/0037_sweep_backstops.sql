-- 0037_sweep_backstops — DB backstops from the final module sweep.
-- (1) approvals: at most ONE pending request per (tenant, entity) — stops an entity being "decided"
--     twice via duplicate submits (the service check-then-inserts).
-- (2) pricing determinism: natural-key uniqueness so the margin/basis lookups can't hit duplicates.
--     NULLS NOT DISTINCT (PG15+) treats the nullable FK columns as equal, matching the app's upsert
--     conflict targets and the `is null` fallbacks.
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_pending_uq"
  ON "approval_requests" ("tenant_id", "entity_type", "entity_id") WHERE "overall_status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profit_categories_natural_uq"
  ON "profit_categories" ("tenant_id", "part_category_id", "brand_class_id") NULLS NOT DISTINCT;
