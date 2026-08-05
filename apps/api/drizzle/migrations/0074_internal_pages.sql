-- 0074_internal_pages.sql — the purchasing / internal back office reconciled with its board.
--
-- SAME PATHS, NOT NEW ONES. Almost every page the board draws already exists in the workspace or
-- platform portal with a settled route — Status Logs at /status-logs, Purchase & Return Invoices at
-- /purchase-invoices, and so on. The back office looks at the same screens through its own menu, so
-- these rows reuse those exact paths. Inventing /internal/status-logs would have meant a second
-- route, a second component and two places to fix the same bug.
--
-- BUILT STATE IS COPIED FROM THE WORKSPACE ROW, not asserted. Seven of these are still placeholders
-- there (Delivery & Return Notes, Purchase & Return Invoices, Returns & Exchanges, Performance
-- Reports, Parts Pricing Report, Profit Percentages, Account Managers). The same route cannot be
-- finished for one portal and unfinished for another, so claiming otherwise here would put a live
-- link on a ComingSoon screen.
--
-- THE BLUE NOTE — "فصل استخراج رقم القطعه في تابه منفصله" — asks for part-number extraction to leave
-- the Internal Dashboard and become its own tab. That is Part Number Extraction below, the back
-- office counterpart of the page 0073 added to the provider portal for the other side of the same
-- queue. It is new, so it arrives as Soon; the Internal Dashboard keeps its own tab until the page
-- is built and the tab is removed deliberately.
--
-- VENDORS IS module='vendor', NOT 'internal'. It is a page ABOUT vendors, so a workspace with no
-- vendor linked should not offer it here any more than it does in the workspace menu. Everything
-- else in this portal is module='internal' and appears only where an internal team is linked.
--
-- Profile → My Profile, matching 0071 and 0073. Assignments is kept although the board omits it.
--
-- Board order is followed except that Performance Reports moves down beside Parts Pricing Report.
-- The board is a flat list; this menu has headings rendered as consecutive runs, and leaving
-- Performance Reports above Shipping & Delivery would split "Reports" into two groups.

update app_pages set label = 'My Profile', updated_at = now() where key = 'internal.internal.profile';--> statement-breakpoint

insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('internal.overview',              'internal', 'internal', '/overview',              'Overview',                   'LayoutDashboard', 'Dashboard',  0, true),
  ('internal.internal.extraction',   'internal', 'internal', '/internal/extraction',   'Part Number Extraction',     'PackageSearch',   'Dashboard',  0, false),
  ('internal.notes',                 'internal', 'internal', '/notes',                 'Delivery & Return Notes',    'FileText',        'Operations', 0, false),
  ('internal.notes-archive',         'internal', 'internal', '/notes-archive',         'Notes Archive',              'History',         'Operations', 0, false),
  ('internal.status-logs',           'internal', 'internal', '/status-logs',           'Status Logs',                'History',         'Operations', 0, true),
  ('internal.purchase-invoices',     'internal', 'internal', '/purchase-invoices',     'Purchase & Return Invoices', 'Receipt',         'Operations', 0, false),
  ('internal.returns',               'internal', 'internal', '/returns',               'Returns & Exchanges',        'Undo2',           'Operations', 0, false),
  ('internal.shipping',              'internal', 'internal', '/shipping',              'Shipping & Delivery',        'Truck',           'Fulfilment', 0, false),
  ('internal.paid-quotations',       'internal', 'internal', '/paid-quotations',       'Paid Quotations',            'Stamp',           'Fulfilment', 0, false),
  ('internal.wallet',                'internal', 'internal', '/wallet',                'Wallet',                     'Wallet',          'Fulfilment', 0, false),
  ('internal.reports',               'internal', 'internal', '/reports',               'Performance Reports',        'LineChart',       'Reports',    0, false),
  ('internal.parts-pricing-report',  'internal', 'internal', '/parts-pricing-report',  'Parts Pricing Report',       'BarChart3',       'Reports',    0, false),
  ('internal.profit',                'internal', 'internal', '/profit',                'Profit Percentages',         'Percent',         'Reports',    0, false),
  ('internal.admin.users',           'internal', 'internal', '/admin/users',           'Users & Permissions',        'Users',           'Setup',      0, true),
  ('internal.account-managers',      'internal', 'internal', '/account-managers',      'Account Managers',           'CalendarClock',   'Setup',      0, false),
  ('internal.vendors',               'vendor',   'internal', '/vendors',               'Vendors',                    'Store',           'Setup',      0, true)
on conflict (key) do nothing;--> statement-breakpoint

insert into app_page_roles (page_key, role)
  select key, 'service_provider' from app_pages where persona = 'internal'
on conflict do nothing;--> statement-breakpoint

update app_pages p set sort_order = v.n, group_heading = v.g from (values
  ('internal.overview',             104, 'Dashboard'),
  ('internal.internal',             105, 'Dashboard'),
  ('internal.internal.extraction',  106, 'Dashboard'),
  ('internal.internal.assignments', 107, 'Dashboard'),
  ('internal.notes',                108, 'Operations'),
  ('internal.notes-archive',        109, 'Operations'),
  ('internal.status-logs',          110, 'Operations'),
  ('internal.purchase-invoices',    111, 'Operations'),
  ('internal.returns',              112, 'Operations'),
  ('internal.shipping',             113, 'Fulfilment'),
  ('internal.paid-quotations',      114, 'Fulfilment'),
  ('internal.wallet',               115, 'Fulfilment'),
  ('internal.reports',              116, 'Reports'),
  ('internal.parts-pricing-report', 117, 'Reports'),
  ('internal.profit',               118, 'Reports'),
  ('internal.admin.users',          119, 'Setup'),
  ('internal.account-managers',     120, 'Setup'),
  ('internal.vendors',              121, 'Setup'),
  ('internal.internal.profile',     122, 'Account')
) as v(k, n, g) where p.key = v.k;--> statement-breakpoint

-- Same invariants as every other portal, asserted inside the transaction.
do $$
declare bad int; mism text;
begin
  select count(*) into bad from (
    select group_heading from (
      select group_heading, lag(group_heading) over (order by sort_order) as prev
      from app_pages where persona = 'internal'
    ) t where prev is distinct from group_heading
    group by group_heading having count(*) > 1
  ) x;
  if bad > 0 then raise exception 'internal menu would show % duplicated heading(s)', bad; end if;

  -- A path that is a placeholder in one portal and finished in another is a live link onto a
  -- ComingSoon screen. Same route, same answer.
  select string_agg(distinct i.path, ', ') into mism
    from app_pages i join app_pages w on w.path = i.path and w.persona = 'workspace'
   where i.persona = 'internal' and i.is_built <> w.is_built;
  if mism is not null then
    raise exception 'built state disagrees with the workspace portal for: %', mism;
  end if;
end $$;
