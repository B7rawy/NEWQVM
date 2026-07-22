-- 0002_app_role — runtime role the API connects as (non-superuser, subject to RLS).
-- CRITICAL: superusers/owner bypass RLS; the API must NOT use the owner role. Migrations/seed only.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qvm_app') then
    create role qvm_app login password 'qvm_app_local_dev';
  end if;
end $$;
grant usage on schema public to qvm_app;
grant select, insert, update, delete on all tables in schema public to qvm_app;
grant usage, select on all sequences in schema public to qvm_app;
grant execute on all functions in schema public to qvm_app;
alter default privileges in schema public grant select, insert, update, delete on tables to qvm_app;
alter default privileges in schema public grant usage, select on sequences to qvm_app;
alter default privileges in schema public grant execute on functions to qvm_app;
