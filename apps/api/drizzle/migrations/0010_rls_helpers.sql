-- 0010_rls_helpers — idempotent helpers so each new module applies standard RLS in one line.
-- Tenant-scoped tables MUST have the full audit block (created_by + updated_by) so set_row_audit fits.

create or replace function public.apply_tenant_rls(p_table text) returns void
  language plpgsql set search_path = '' as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('alter table public.%I force row level security', p_table);
  if not exists (select 1 from pg_policies where schemaname='public' and tablename=p_table and policyname='tenant_isolation') then
    execute format('create policy tenant_isolation on public.%I '
      || 'using (tenant_id = public.current_tenant_id() or public.app_is_internal()) '
      || 'with check (tenant_id = public.current_tenant_id() or public.app_is_internal())', p_table);
  end if;
  execute format('drop trigger if exists trg_set_row_audit on public.%I', p_table);
  execute format('create trigger trg_set_row_audit before insert or update on public.%I '
    || 'for each row execute function public.set_row_audit()', p_table);
  execute format('grant select, insert, update, delete on public.%I to qvm_app', p_table);
end $$;

create or replace function public.apply_global_rls(p_table text) returns void
  language plpgsql set search_path = '' as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  if not exists (select 1 from pg_policies where schemaname='public' and tablename=p_table and policyname='global_read') then
    execute format('create policy global_read on public.%I for select using (true)', p_table);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename=p_table and policyname='global_write') then
    execute format('create policy global_write on public.%I for all '
      || 'using (public.app_is_internal()) with check (public.app_is_internal())', p_table);
  end if;
  execute format('drop trigger if exists trg_set_row_audit on public.%I', p_table);
  execute format('create trigger trg_set_row_audit before insert or update on public.%I '
    || 'for each row execute function public.set_row_audit()', p_table);
  execute format('grant select, insert, update, delete on public.%I to qvm_app', p_table);
end $$;
