-- 0004_platform_members_rls — apply the global-table security pattern to platform_members
-- (created in 0003, after the 0001 RLS loop already ran). Global table (no tenant_id):
-- readable by authenticated sessions, writable by internal staff only; audited.

alter table public.platform_members enable row level security;
create policy global_read on public.platform_members for select using (true);
create policy global_write on public.platform_members for all
  using (public.app_is_internal()) with check (public.app_is_internal());

create trigger trg_set_row_audit before insert or update on public.platform_members
  for each row execute function public.set_row_audit();

-- grant to the runtime app role (default privileges cover future tables, but be explicit).
grant select, insert, update, delete on public.platform_members to qvm_app;
