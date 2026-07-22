-- UNIQUE ... NULLS NOT DISTINCT (correct PG16 syntax; drizzle 0.36 can't emit it). So the null
-- insurer (cash/credit) and null scope ids (global policy) dedupe -> service ON CONFLICT upserts.
create unique index if not exists pricing_basis_scope_uq
  on public.pricing_basis_settings (tenant_id, payer_scenario, insurance_company_id) nulls not distinct;
create unique index if not exists vendor_pricing_scope_uq
  on public.vendor_pricing_policies (tenant_id, vendor_id, scope_type, region_id, workshop_branch_id) nulls not distinct;
