-- 0078_group_by_owner.sql — the menu stops interleaving owners.
--
-- The tags added in the previous change made the disorder visible: "Performance Reports [Workshop]"
-- sat between Pricing Engine [Vendor] and Profit Percentages [Vendor], and Setup ran core, workshop,
-- vendor, provider, internal, core, core. Seven groups across four portals held more than one owner.
--
-- THE RULE NOW: a group heading has ONE owner. Where a group mixed, it splits along the seam —
-- "Reports & pricing" becomes Reports (workshop) and Pricing (vendor); platform's "Services" splits
-- the same way and its Account Managers moves to Admin, where the other core pages already are;
-- platform_system's "Platform" gives the Internal Dashboard its own "Back office" heading.
--
-- ONE GROUP IS DELIBERATELY MIXED and renamed to say so. "Directory" is the index OF the
-- counterparties — Workshops, Vendors, Providers, Internal, in that fixed order, plus the page that
-- adds one. Four different tags in a row is exactly what that group means; making it single-owner
-- would mean four one-line groups saying the same thing four times.
--
-- Nothing is added, removed or renamed. Every page keeps its path, module, roles and built state;
-- only sort_order and group_heading move, and each portal is renumbered strictly inside its own
-- existing block so no other portal shifts and sort_order stays globally unique.
--
-- GENERATED, NOT TYPED. The 80 rows below came from a script that reads the catalog, resolves paths
-- to keys, and refuses to emit anything if the layout drops a page, invents one, or leaves a
-- non-Directory group with two owners.

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
  ('platform.vendors', 11, 'Directory'),
  ('platform.org.workshops', 12, 'Directory'),
  ('platform.providers', 13, 'Directory'),
  ('platform.internal-teams', 14, 'Directory'),
  ('platform.account-managers', 15, 'Admin'),
  ('platform.admin.workspaces', 16, 'Admin'),
  ('platform.admin.workflows', 17, 'Admin'),
  ('platform.admin.users', 18, 'Admin'),
  ('platform.onboarding.review', 19, 'Admin'),
  ('platform.status-logs', 20, 'Admin'),
  ('platform.webhook-logs', 21, 'Admin'),
  ('platform_system.management-overview', 22, 'Platform'),
  ('platform_system.internal', 23, 'Back office'),
  ('platform_system.admin.workspaces', 24, 'Control tower'),
  ('platform_system.admin.workflows', 25, 'Control tower'),
  ('platform_system.admin.pages', 26, 'Control tower'),
  ('platform_system.admin.users', 27, 'Control tower'),
  ('platform_system.onboarding.review', 28, 'Control tower'),
  ('platform_system.vendors', 29, 'Directory'),
  ('platform_system.org.workshops', 30, 'Directory'),
  ('platform_system.providers', 31, 'Directory'),
  ('platform_system.internal-teams', 32, 'Directory'),
  ('platform_system.status-logs', 33, 'System'),
  ('platform_system.webhook-logs', 34, 'System'),
  ('platform_system.settings', 35, 'System'),
  ('workspace.my-work', 36, 'Dashboard'),
  ('workspace.overview', 37, 'Dashboard'),
  ('workspace.management-overview', 38, 'Dashboard'),
  ('workspace.rfq-new', 39, 'Procurement'),
  ('workspace.rfqs', 40, 'Procurement'),
  ('workspace.orders', 41, 'Procurement'),
  ('workspace.delivered', 42, 'Procurement'),
  ('workspace.closed', 43, 'Procurement'),
  ('workspace.purchase-invoices', 44, 'Finance'),
  ('workspace.returns', 45, 'Finance'),
  ('workspace.notes', 46, 'Finance'),
  ('workspace.statements', 47, 'Finance'),
  ('workspace.reports', 48, 'Reports'),
  ('workspace.targets', 49, 'Reports'),
  ('workspace.pricing', 50, 'Pricing'),
  ('workspace.profit', 51, 'Pricing'),
  ('workspace.parts-pricing-report', 52, 'Pricing'),
  ('workspace.onboarding', 53, 'Directory'),
  ('workspace.org.workshops', 54, 'Directory'),
  ('workspace.vendors', 55, 'Directory'),
  ('workspace.providers', 56, 'Directory'),
  ('workspace.internal-teams', 57, 'Directory'),
  ('workspace.account-managers', 58, 'Setup'),
  ('workspace.admin.users', 59, 'Setup'),
  ('workspace.status-logs', 60, 'Setup'),
  ('workspace.settings', 61, 'Setup'),
  ('internal.overview', 113, 'Dashboard'),
  ('internal.internal', 114, 'Dashboard'),
  ('internal.internal.extraction', 115, 'Dashboard'),
  ('internal.internal.assignments', 116, 'Dashboard'),
  ('internal.notes', 117, 'Operations'),
  ('internal.notes-archive', 118, 'Operations'),
  ('internal.status-logs', 119, 'Operations'),
  ('internal.purchase-invoices', 120, 'Operations'),
  ('internal.returns', 121, 'Operations'),
  ('internal.shipping', 122, 'Fulfilment'),
  ('internal.paid-quotations', 123, 'Fulfilment'),
  ('internal.wallet', 124, 'Fulfilment'),
  ('internal.reports', 125, 'Reports'),
  ('internal.parts-pricing-report', 126, 'Reports'),
  ('internal.profit', 127, 'Reports'),
  ('internal.admin.users', 128, 'Setup'),
  ('internal.account-managers', 129, 'Setup'),
  ('internal.vendors', 130, 'Directory'),
  ('internal.internal.profile', 131, 'Account')
) as v(k, n, g) where p.key = v.k;

do $$
declare bad text;
begin
  -- one owner per heading, Directory excepted and named
  select string_agg(persona || '/' || group_heading, ', ') into bad from (
    select persona, group_heading from app_pages
    where module <> 'core' and group_heading <> 'Directory'
    group by persona, group_heading having count(distinct module) > 1) x;
  if bad is not null then raise exception 'still mixing owners in: %', bad; end if;

  -- headings remain single runs after the renumbering
  select string_agg(persona || '/' || group_heading, ', ') into bad from (
    select persona, group_heading from (
      select persona, group_heading,
             lag(group_heading) over (partition by persona order by sort_order) as prev
      from app_pages) t
    where prev is distinct from group_heading
    group by persona, group_heading having count(*) > 1) y;
  if bad is not null then raise exception 'heading split into two groups: %', bad; end if;

  -- and children still sit directly under their parents
  select count(*)::text into bad from app_pages c join app_pages p on p.key = c.parent_key
   where c.parent_key is not null
     and (c.sort_order <> p.sort_order + 1 or c.group_heading <> p.group_heading);
  if bad <> '0' then raise exception '% child page(s) no longer follow their parent', bad; end if;
end $$;
