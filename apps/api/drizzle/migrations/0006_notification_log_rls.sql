-- 0006_notification_log_rls — RLS + audit for notification_log (tenant-scoped, created in 0005
-- after the 0001 RLS loop). enable+FORCE + tenant isolation; append-only author trigger.

alter table public.notification_log enable row level security;
alter table public.notification_log force row level security;
create policy tenant_isolation on public.notification_log
  using (tenant_id = public.current_tenant_id() or public.app_is_internal())
  with check (tenant_id = public.current_tenant_id() or public.app_is_internal());

create trigger trg_set_created_by before insert on public.notification_log
  for each row execute function public.set_created_by();

grant select, insert, update, delete on public.notification_log to qvm_app;
