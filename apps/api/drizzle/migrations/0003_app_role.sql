-- ============================================================================
-- 0003_app_role — the runtime role the API connects as.
-- CRITICAL: RLS is bypassed by superusers and by the table OWNER. The migration/owner
-- role (qvm) must NOT be used at runtime. The API connects as `qvm_app`, a plain
-- non-superuser role that IS subject to RLS. This is what makes tenant isolation real.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qvm_app') then
    -- password is overridden per-environment; local dev value only.
    create role qvm_app login password 'qvm_app_local_dev';
  end if;
end $$;

grant usage on schema public to qvm_app;
grant select, insert, update, delete on all tables in schema public to qvm_app;
grant usage, select on all sequences in schema public to qvm_app;
grant execute on all functions in schema public to qvm_app;

-- future tables/functions created by the owner are auto-granted to the app role.
alter default privileges in schema public
  grant select, insert, update, delete on tables to qvm_app;
alter default privileges in schema public
  grant usage, select on sequences to qvm_app;
alter default privileges in schema public
  grant execute on functions to qvm_app;
