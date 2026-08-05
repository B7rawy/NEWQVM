-- 0079_workspace_sees_counterparties.sql — the workspace menu finally shows provider and
-- back-office pages, which is what "link a service provider and their pages appear in the
-- workspace" asked for in the first place.
--
-- WHAT WAS WRONG. Linking a counterparty was made to switch pages on, and then only two families
-- had pages to switch on. The workspace menu held twelve workshop pages (the order chain) and four
-- vendor pages (pricing), but exactly ONE service-provider page and ONE internal page — and both of
-- those were the Directory row that LISTS them, not anything you do with them. So linking a provider
-- visibly changed nothing, and the feature looked broken because for those two families it was.
--
-- Their own PORTALS were built and correct. What was missing is that a workspace looking OUT at them
-- had nowhere to go.
--
-- SAME ROUTES, NOT NEW SCREENS. Each row points at the page its owning portal already uses:
-- /internal, /internal/extraction, /provider/assignments, /provider/invoices. Built state is copied
-- from those rows, so nothing claims to be finished when the screen behind it is a placeholder.
--
-- Labels stay as the owning portal names them — "Assignments", not "Provider Assignments" — because
-- one page has one name (0071's rule). The group heading supplies the context instead.
--
-- Every persona is renumbered from one generated layout, so the four inserts cannot collide with an
-- existing sort_order and no heading can end up split. The generator refuses to emit if a layout
-- drops a page, invents one, or leaves a non-Directory group with two owners.

insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('workspace.internal', 'internal', 'workspace', '/internal', 'Internal Dashboard', 'Boxes', 'tmp', 0, true),
  ('workspace.internal.extraction', 'internal', 'workspace', '/internal/extraction', 'Part Number Extraction', 'PackageSearch', 'tmp', 0, false),
  ('workspace.provider.assignments', 'service_provider', 'workspace', '/provider/assignments', 'Assignments', 'ClipboardList', 'tmp', 0, false),
  ('workspace.provider.invoices', 'service_provider', 'workspace', '/provider/invoices', 'Invoices', 'Receipt', 'tmp', 0, false),
  ('platform.internal', 'internal', 'platform', '/internal', 'Internal Dashboard', 'Boxes', 'tmp', 0, true),
  ('platform.internal.extraction', 'internal', 'platform', '/internal/extraction', 'Part Number Extraction', 'PackageSearch', 'tmp', 0, false),
  ('platform.provider.assignments', 'service_provider', 'platform', '/provider/assignments', 'Assignments', 'ClipboardList', 'tmp', 0, false),
  ('platform.provider.invoices', 'service_provider', 'platform', '/provider/invoices', 'Invoices', 'Receipt', 'tmp', 0, false)
on conflict (key) do nothing;--> statement-breakpoint

insert into app_page_roles (page_key, role) values
  ('workspace.internal', 'company_admin'),
  ('workspace.internal', 'branch_manager'),
  ('workspace.internal', 'service_advisor'),
  ('workspace.internal.extraction', 'company_admin'),
  ('workspace.internal.extraction', 'branch_manager'),
  ('workspace.internal.extraction', 'service_advisor'),
  ('workspace.provider.assignments', 'company_admin'),
  ('workspace.provider.assignments', 'branch_manager'),
  ('workspace.provider.assignments', 'service_advisor'),
  ('workspace.provider.invoices', 'company_admin'),
  ('workspace.provider.invoices', 'branch_manager'),
  ('workspace.provider.invoices', 'service_advisor'),
  ('platform.internal', 'super_admin'),
  ('platform.internal', 'staff'),
  ('platform.internal', 'account_manager'),
  ('platform.internal', 'purchasing'),
  ('platform.internal', 'part_extractor'),
  ('platform.internal.extraction', 'super_admin'),
  ('platform.internal.extraction', 'staff'),
  ('platform.internal.extraction', 'account_manager'),
  ('platform.internal.extraction', 'purchasing'),
  ('platform.internal.extraction', 'part_extractor'),
  ('platform.provider.assignments', 'super_admin'),
  ('platform.provider.assignments', 'staff'),
  ('platform.provider.assignments', 'account_manager'),
  ('platform.provider.assignments', 'purchasing'),
  ('platform.provider.assignments', 'part_extractor'),
  ('platform.provider.invoices', 'super_admin'),
  ('platform.provider.invoices', 'staff'),
  ('platform.provider.invoices', 'account_manager'),
  ('platform.provider.invoices', 'purchasing'),
  ('platform.provider.invoices', 'part_extractor')
on conflict do nothing;--> statement-breakpoint

update app_pages p set sort_order = v.n, group_heading = v.g, updated_at = now() from (values
  ('platform.my-work', 1, 'Workspace'),
  ('platform.approvals', 2, 'Workspace'),
  ('platform.overview', 3, 'Workspace'),
  ('platform.management-overview', 4, 'Workspace'),
  ('platform.rfqs', 5, 'Procurement'),
  ('platform.orders', 6, 'Procurement'),
  ('platform.delivered', 7, 'Procurement'),
  ('platform.reports', 8, 'Reports'),
  ('platform.pricing', 9, 'Pricing'),
  ('platform.profit', 10, 'Pricing'),
  ('platform.internal', 11, 'Back office'),
  ('platform.internal.extraction', 12, 'Back office'),
  ('platform.provider.assignments', 13, 'Service providers'),
  ('platform.provider.invoices', 14, 'Service providers'),
  ('platform.vendors', 15, 'Directory'),
  ('platform.org.workshops', 16, 'Directory'),
  ('platform.providers', 17, 'Directory'),
  ('platform.internal-teams', 18, 'Directory'),
  ('platform.account-managers', 19, 'Admin'),
  ('platform.admin.workspaces', 20, 'Admin'),
  ('platform.admin.workflows', 21, 'Admin'),
  ('platform.admin.users', 22, 'Admin'),
  ('platform.onboarding.review', 23, 'Admin'),
  ('platform.status-logs', 24, 'Admin'),
  ('platform.webhook-logs', 25, 'Admin'),
  ('platform_system.management-overview', 26, 'Platform'),
  ('platform_system.internal', 27, 'Back office'),
  ('platform_system.admin.workspaces', 28, 'Control tower'),
  ('platform_system.admin.workflows', 29, 'Control tower'),
  ('platform_system.admin.pages', 30, 'Control tower'),
  ('platform_system.admin.users', 31, 'Control tower'),
  ('platform_system.onboarding.review', 32, 'Control tower'),
  ('platform_system.vendors', 33, 'Directory'),
  ('platform_system.org.workshops', 34, 'Directory'),
  ('platform_system.providers', 35, 'Directory'),
  ('platform_system.internal-teams', 36, 'Directory'),
  ('platform_system.status-logs', 37, 'System'),
  ('platform_system.webhook-logs', 38, 'System'),
  ('platform_system.settings', 39, 'System'),
  ('workspace.my-work', 40, 'Dashboard'),
  ('workspace.overview', 41, 'Dashboard'),
  ('workspace.management-overview', 42, 'Dashboard'),
  ('workspace.rfq-new', 43, 'Procurement'),
  ('workspace.rfqs', 44, 'Procurement'),
  ('workspace.orders', 45, 'Procurement'),
  ('workspace.delivered', 46, 'Procurement'),
  ('workspace.closed', 47, 'Procurement'),
  ('workspace.purchase-invoices', 48, 'Finance'),
  ('workspace.returns', 49, 'Finance'),
  ('workspace.notes', 50, 'Finance'),
  ('workspace.statements', 51, 'Finance'),
  ('workspace.reports', 52, 'Reports'),
  ('workspace.targets', 53, 'Reports'),
  ('workspace.pricing', 54, 'Pricing'),
  ('workspace.profit', 55, 'Pricing'),
  ('workspace.parts-pricing-report', 56, 'Pricing'),
  ('workspace.internal', 57, 'Back office'),
  ('workspace.internal.extraction', 58, 'Back office'),
  ('workspace.provider.assignments', 59, 'Service providers'),
  ('workspace.provider.invoices', 60, 'Service providers'),
  ('workspace.onboarding', 61, 'Directory'),
  ('workspace.org.workshops', 62, 'Directory'),
  ('workspace.vendors', 63, 'Directory'),
  ('workspace.providers', 64, 'Directory'),
  ('workspace.internal-teams', 65, 'Directory'),
  ('workspace.account-managers', 66, 'Setup'),
  ('workspace.admin.users', 67, 'Setup'),
  ('workspace.status-logs', 68, 'Setup'),
  ('workspace.settings', 69, 'Setup'),
  ('vendor.vendor', 70, 'Sales'),
  ('vendor.vendor.quotations', 71, 'Sales'),
  ('vendor.vendor.confirmed', 72, 'Sales'),
  ('vendor.vendor.invoices', 73, 'Fulfillment & finance'),
  ('vendor.vendor.statement', 74, 'Fulfillment & finance'),
  ('vendor.vendor.returns', 75, 'Fulfillment & finance'),
  ('vendor.vendor.financing', 76, 'Fulfillment & finance'),
  ('vendor.vendor.deliveries', 77, 'Fulfillment & finance'),
  ('vendor.vendor.catalog', 78, 'Growth'),
  ('vendor.vendor.store', 79, 'Growth'),
  ('vendor.vendor.paid-quotations', 80, 'Growth'),
  ('vendor.vendor.wallet', 81, 'Growth'),
  ('vendor.vendor.market-index', 82, 'Growth'),
  ('vendor.vendor.branches', 83, 'Account'),
  ('vendor.vendor.margins', 84, 'Account'),
  ('vendor.vendor.account-managers', 85, 'Account'),
  ('vendor.vendor.profile', 86, 'Account'),
  ('vendor.vendor.settings', 87, 'Account'),
  ('workshop.workshop', 88, 'Overview'),
  ('workshop.workshop.store', 89, 'Storefront'),
  ('workshop.shipping', 90, 'Storefront'),
  ('workshop.paid-quotations', 91, 'Storefront'),
  ('workshop.wallet', 92, 'Storefront'),
  ('workshop.workshop.requests.new', 93, 'Requests'),
  ('workshop.workshop.requests.new.regular', 94, 'Requests'),
  ('workshop.workshop.requests', 95, 'Requests'),
  ('workshop.workshop.orders', 96, 'Orders'),
  ('workshop.deliveries', 97, 'Orders'),
  ('workshop.returns', 98, 'Orders'),
  ('workshop.invoices', 99, 'Billing'),
  ('workshop.statement', 100, 'Billing'),
  ('workshop.notes-archive', 101, 'Records'),
  ('workshop.workshop.branches', 102, 'Account'),
  ('workshop.admin.users', 103, 'Account'),
  ('workshop.account-managers', 104, 'Account'),
  ('workshop.webhook-logs', 105, 'Account'),
  ('workshop.workshop.profile', 106, 'Account'),
  ('workshop.settings', 107, 'Account'),
  ('service_provider.provider', 108, 'Provider'),
  ('service_provider.provider.assignments', 109, 'Provider'),
  ('service_provider.provider.extraction', 110, 'Part numbers'),
  ('service_provider.provider.extraction-settings', 111, 'Part numbers'),
  ('service_provider.provider.rfq-new', 112, 'Procurement'),
  ('service_provider.provider.rfq-new.regular', 113, 'Procurement'),
  ('service_provider.provider.rfqs', 114, 'Procurement'),
  ('service_provider.provider.orders', 115, 'Procurement'),
  ('service_provider.provider.invoices', 116, 'Finance'),
  ('service_provider.provider.wallet', 117, 'Finance'),
  ('service_provider.provider.users', 118, 'Account'),
  ('service_provider.provider.account-managers', 119, 'Account'),
  ('service_provider.provider.profile', 120, 'Account'),
  ('internal.overview', 121, 'Dashboard'),
  ('internal.internal', 122, 'Dashboard'),
  ('internal.internal.extraction', 123, 'Dashboard'),
  ('internal.internal.assignments', 124, 'Dashboard'),
  ('internal.notes', 125, 'Operations'),
  ('internal.notes-archive', 126, 'Operations'),
  ('internal.status-logs', 127, 'Operations'),
  ('internal.purchase-invoices', 128, 'Operations'),
  ('internal.returns', 129, 'Operations'),
  ('internal.shipping', 130, 'Fulfilment'),
  ('internal.paid-quotations', 131, 'Fulfilment'),
  ('internal.wallet', 132, 'Fulfilment'),
  ('internal.reports', 133, 'Reports'),
  ('internal.parts-pricing-report', 134, 'Reports'),
  ('internal.profit', 135, 'Reports'),
  ('internal.admin.users', 136, 'Setup'),
  ('internal.account-managers', 137, 'Setup'),
  ('internal.vendors', 138, 'Directory'),
  ('internal.internal.profile', 139, 'Account')
) as v(k, n, g) where p.key = v.k;
--> statement-breakpoint

do $$
declare bad text;
begin
  select string_agg(persona || '/' || group_heading, ', ') into bad from (
    select persona, group_heading from app_pages
    where module <> 'core' and group_heading <> 'Directory'
    group by persona, group_heading having count(distinct module) > 1) x;
  if bad is not null then raise exception 'group mixes owners: %', bad; end if;

  select string_agg(persona || '/' || group_heading, ', ') into bad from (
    select persona, group_heading from (
      select persona, group_heading,
             lag(group_heading) over (partition by persona order by sort_order) as prev
      from app_pages) t
    where prev is distinct from group_heading
    group by persona, group_heading having count(*) > 1) y;
  if bad is not null then raise exception 'heading split in two: %', bad; end if;

  select string_agg(path, ', ') into bad from (
    select path from app_pages group by path having count(distinct is_built) > 1) z;
  if bad is not null then raise exception 'shared route disagrees on built state: %', bad; end if;

  select count(*)::text into bad from (select sort_order from app_pages group by sort_order having count(*) > 1) c;
  if bad <> '0' then raise exception '% sort_order collision(s)', bad; end if;

  -- the point of the whole file: every counterparty family now has more than its Directory row
  select string_agg(module, ', ') into bad from (
    select module from app_pages where persona = 'workspace' and module <> 'core'
    group by module having count(*) < 2) d;
  if bad is not null then raise exception 'still nothing to see for: %', bad; end if;
end $$;
