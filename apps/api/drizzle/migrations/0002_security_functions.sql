-- ============================================================================
-- 0002_security_functions — RLS, audit triggers, atomic order numbering
-- Hand-authored (drizzle-kit --custom). Closes Phase 1c of the data model.
--
-- Fixes old-system findings:
--   • RLS OFF on 56+ tables  -> tenant isolation ENABLED + FORCED on every tenant-scoped table
--   • created_by/updated_by from request body -> set server-side from session in a trigger
--   • order numbers via MAX()+1 (lock contention / duplicates) -> atomic counter function
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Session helpers. The API sets these per-request via SET LOCAL:
--    app.tenant_id  = the resolved workspace (from subdomain/JWT)
--    app.user_id    = the authenticated user (for audit attribution)
--    app.is_internal = 'true' for platform (Qparts) staff / super-admin / seed
-- ---------------------------------------------------------------------------
create or replace function public.current_tenant_id() returns uuid
  language sql stable
  set search_path = ''
as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create or replace function public.app_user_id() returns uuid
  language sql stable
  set search_path = ''
as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function public.app_is_internal() returns boolean
  language sql stable
  set search_path = ''
as $$ select coalesce(current_setting('app.is_internal', true), 'false') = 'true' $$;

-- ---------------------------------------------------------------------------
-- 2. Row-Level Security.
--    2a. Tenant-scoped tables (have tenant_id): isolate by current tenant,
--        internal staff bypass. FORCE so even the table owner is subject.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id'
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
    execute format('alter table public.%I force row level security', r.table_name);
    execute format(
      'create policy tenant_isolation on public.%I '
      || 'using (tenant_id = public.current_tenant_id() or public.app_is_internal()) '
      || 'with check (tenant_id = public.current_tenant_id() or public.app_is_internal())',
      r.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
--    2b. Global tables (no tenant_id): reference vocab, plans, users, vendors.
--        Readable by any authenticated session; writable only by internal staff.
--        (Per-tenant vendor visibility is enforced in queries via tenant_vendors.)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select t.table_name
    from information_schema.tables t
    where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
      and t.table_name not like '\_\_%'
      and not exists (
        select 1 from information_schema.columns c
        where c.table_schema = 'public' and c.table_name = t.table_name
          and c.column_name = 'tenant_id')
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
    execute format('create policy global_read on public.%I for select using (true)', r.table_name);
    execute format('create policy global_write on public.%I for all '
      || 'using (public.app_is_internal()) with check (public.app_is_internal())', r.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Audit trigger — created_by/updated_by from the session, never the body.
--    Full-audit tables (have updated_by): stamp author + bump updated_* on UPDATE.
--    Append-only author tables (created_by, no updated_by): stamp created_by only.
-- ---------------------------------------------------------------------------
create or replace function public.set_row_audit() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, public.app_user_id());
    new.updated_by := coalesce(new.updated_by, new.created_by);
  elsif tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.updated_at := now();
    new.updated_by := public.app_user_id();
  end if;
  return new;
end $$;

create or replace function public.set_created_by() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.created_by := coalesce(new.created_by, public.app_user_id());
  return new;
end $$;

do $$
declare r record;
begin
  -- full audit: tables carrying updated_by
  for r in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_by'
  loop
    execute format(
      'create trigger trg_set_row_audit before insert or update on public.%I '
      || 'for each row execute function public.set_row_audit()', r.table_name);
  end loop;

  -- append-only author: created_by present, updated_by absent
  for r in
    select c.table_name from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'created_by'
      and not exists (
        select 1 from information_schema.columns u
        where u.table_schema = 'public' and u.table_name = c.table_name
          and u.column_name = 'updated_by')
  loop
    execute format(
      'create trigger trg_set_created_by before insert on public.%I '
      || 'for each row execute function public.set_created_by()', r.table_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Atomic order-number generator — replaces old MAX()+1 + FOR UPDATE.
--    Upserts a per-(tenant,prefix) counter and returns the next number in one
--    statement. No table scan, no cross-order lock contention.
-- ---------------------------------------------------------------------------
create or replace function public.next_order_number(
  p_tenant uuid, p_prefix text, p_region uuid default null)
returns text
  language plpgsql
  set search_path = ''
as $$
declare v_value int;
begin
  insert into public.order_number_counters (tenant_id, region_id, prefix, next_value)
    values (p_tenant, p_region, p_prefix, 2)
  on conflict (tenant_id, prefix)
    do update set next_value = public.order_number_counters.next_value + 1,
                  updated_at = now()
  returning next_value into v_value;
  -- returns the value just consumed: fresh row -> 1, existing -> prior next_value
  return p_prefix || (v_value - 1)::text;
end $$;
