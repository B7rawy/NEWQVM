-- 0082_fk_indexes_and_column_docs.sql — findings of the full-schema audit, applied.
--
-- THE AUDIT SWEPT: duplicate indexes (0 — 0068 holds), orphan enums (0), orphan functions (0 of
-- 15), unused views (none exist), tables unreferenced in code (0 of 53 empty tables — empty means
-- not-yet-exercised, not unused), drizzle drift (0 — "No schema changes"), and 30 FK columns with
-- no covering index. This file fixes the last one where it matters and writes down why the rest
-- are deliberate.
--
-- INDEXED — columns joined or filtered on every operational read:
--   rfqs.workshop_branch_id      every workshop-scoped list starts here
--   {rfqs,rfq_items,orders,order_items}.status_id   status joins on every dashboard
--   workflow_record_state.origin_flow_id            the crossing's way home; away_idx does not lead with it
--   vendor_{payments,pricing_policies,financing_requests}.vendor_id   vendor-portal reads when those build
--
-- DELIBERATELY NOT INDEXED, so the next audit does not re-litigate them:
--   * people columns (submitted_by, reviewed_by, uploaded_by, linked_by, requested_by, resolved_by,
--     actor_user_id, impersonator_id, changed_by): display-only; the FK-cascade case never fires
--     because users are deactivated (is_active=false), never deleted.
--   * environment / status_domain members of composite FKs: 2-3 distinct values — a btree on them
--     selects nothing.
--   * tiny tables (app_pages.parent_key ~131 rows, workflow_steps.*_status_id ~26 rows,
--     workflow_exceptions.restore_status_id): a scan is already one page.
--   * assignee_user_id and in_app_notifications.tenant_id: covered by composite indexes whose
--     leading column every real query names (tenant+environment / recipient).
--
-- COLUMN DOCS — the audit flagged these as "all NULL, possibly dead"; they are neither, and the
-- comments make that answer permanent instead of re-derived:
--   * legacy_id on the eight reference catalogs is the import key for migrating the OLD system's
--     list_data rows; it is empty until that import runs and must not be dropped before it.
--   * entity_id columns are polymorphic (entity_type says which table) — they CANNOT carry a FK.
--   * status_logs.flow_id / workflow_auto_fired.flow_id / approval_requests.flow_id carry no FK so
--     history survives a flow version being deleted.

create index if not exists rfqs_workshop_branch_idx on rfqs (workshop_branch_id);--> statement-breakpoint
create index if not exists rfqs_status_idx on rfqs (status_id);--> statement-breakpoint
create index if not exists rfq_items_status_idx on rfq_items (status_id);--> statement-breakpoint
create index if not exists orders_status_idx on orders (status_id);--> statement-breakpoint
create index if not exists order_items_status_idx on order_items (status_id);--> statement-breakpoint
create index if not exists workflow_record_state_origin_idx on workflow_record_state (origin_flow_id) where origin_flow_id is not null;--> statement-breakpoint
create index if not exists vendor_payments_vendor_idx on vendor_payments (vendor_id);--> statement-breakpoint
create index if not exists vendor_pricing_policies_vendor_idx on vendor_pricing_policies (vendor_id);--> statement-breakpoint
create index if not exists vendor_financing_requests_vendor_idx on vendor_financing_requests (vendor_id);--> statement-breakpoint

comment on column brand_classes.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column car_brands.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column cities.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column cost_ranges.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column part_categories.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column payment_accounts.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column regions.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column return_reasons.legacy_id is 'import key from the legacy platform''s list_data; empty until that migration runs — do not drop';--> statement-breakpoint
comment on column status_logs.flow_id is 'no FK on purpose: the log outlives deleted flow versions';--> statement-breakpoint
comment on column workflow_record_state.entity_id is 'polymorphic with entity_type — cannot carry a FK by design';
