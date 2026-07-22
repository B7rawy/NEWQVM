-- 0009_master_data_rls — global-table security for the master-data tables (created in 0008,
-- after the 0001 loop). Global (no tenant_id): readable by all authenticated, writable by
-- platform staff only; audited.

do $$
declare r text;
begin
  foreach r in array array['parts_master','part_synonyms','part_category_mapping']
  loop
    execute format('alter table public.%I enable row level security', r);
    execute format('create policy global_read on public.%I for select using (true)', r);
    execute format('create policy global_write on public.%I for all '
      || 'using (public.app_is_internal()) with check (public.app_is_internal())', r);
    execute format('create trigger trg_set_row_audit before insert or update on public.%I '
      || 'for each row execute function public.set_row_audit()', r);
    execute format('grant select, insert, update, delete on public.%I to qvm_app', r);
  end loop;
end $$;
