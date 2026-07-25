-- 0041_environment_rls — enforce the Live/Sandbox boundary in the DATABASE, not just in code.
--
-- 0040 gave every operational row an `environment`. This makes the database itself refuse to cross
-- it, so a query that forgets the predicate returns nothing rather than the wrong environment's data.
--
-- Why RESTRICTIVE and not another permissive policy: `tenant_isolation` is
--   using (tenant_id = current_tenant_id() OR app_is_internal())
-- and the cross-workspace portals (vendor / workshop / provider) legitimately run as internal.
-- Permissive policies are OR-ed, so an environment predicate added that way would be bypassed by the
-- very `app_is_internal()` escape those portals rely on — exactly where the boundary matters most.
-- RESTRICTIVE policies are AND-ed with the permissive set, so this holds unconditionally.

CREATE OR REPLACE FUNCTION public.current_environment() RETURNS public.environment_type
LANGUAGE sql STABLE SET search_path = '' AS $$
  -- unset GUC → 'live': a forgotten header can never widen access, only land you where you were
  select coalesce(nullif(current_setting('app.environment', true), ''), 'live')::public.environment_type
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.apply_environment_rls(p_table text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = p_table and policyname = 'environment_isolation'
  ) then
    execute format(
      'create policy environment_isolation on public.%I as restrictive '
      || 'using (environment = public.current_environment()) '
      || 'with check (environment = public.current_environment())', p_table);
  end if;
end $$;--> statement-breakpoint

-- Any table that carries `environment` gets the policy automatically from here on, so a future
-- table cannot be added to the operational set and silently miss the boundary.
CREATE OR REPLACE FUNCTION public.apply_tenant_rls(p_table text) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('alter table public.%I force row level security', p_table);
  if not exists (select 1 from pg_policies where schemaname='public' and tablename=p_table and policyname='tenant_isolation') then
    execute format('create policy tenant_isolation on public.%I '
      || 'using (tenant_id = public.current_tenant_id() or public.app_is_internal()) '
      || 'with check (tenant_id = public.current_tenant_id() or public.app_is_internal())', p_table);
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name=p_table and column_name='environment') then
    perform public.apply_environment_rls(p_table);
  end if;
  execute format('drop trigger if exists trg_set_row_audit on public.%I', p_table);
  execute format('create trigger trg_set_row_audit before insert or update on public.%I '
    || 'for each row execute function public.set_row_audit()', p_table);
  execute format('grant select, insert, update, delete on public.%I to qvm_app', p_table);
end $$;--> statement-breakpoint

-- Apply to every table that already carries `environment`.
--
-- order_number_counters is deliberately EXCLUDED: it holds no business data, its unique key already
-- separates the two environments, and next_order_number() must be able to read the counter row it is
-- about to bump. A restrictive policy there would buy nothing and risk breaking document numbering.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'environment'
      AND table_name <> 'order_number_counters'
  LOOP
    PERFORM public.apply_environment_rls(t);
  END LOOP;
END $$;
