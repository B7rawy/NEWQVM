-- 0012 — RLS for the new tenant-scoped tables (via 0010 helpers).
select public.apply_tenant_rls('insurance_companies');
select public.apply_tenant_rls('agency_price_reference');
select public.apply_tenant_rls('pricing_basis_settings');
