-- 0073_provider_pages.sql — the service-provider portal reconciled with its board, and the sub-item
-- the board asks for.
--
-- NESTING IS NEW. The board draws "New RFQ ⌄" with "Regular RFQ" indented under it, and the workshop
-- board draws the same pair, so one level of hierarchy is a structure the product wants rather than
-- a one-off. Flattening it would have silently redesigned somebody else's design. `parent_key` is a
-- self-reference on app_pages; the resolver nests children under their parent and the sidebar
-- renders them indented under an expandable row.
--
-- ONE LEVEL ONLY, and enforced: a child may not itself be a parent. A sidebar that can nest without
-- limit is a sidebar that can be made unusable from a database row, and nothing on any board asks
-- for a third level.
--
-- WHAT THE BOARD ADDS. Everything below is red "صفحة جديدة لم تبني" or a blue note describing a page
-- that does not exist here yet, so all of it arrives is_built = false and shows as "Soon". Two of
-- them come from the blue notes rather than a drawn row:
--   صفحة استخراج رقم القطعه                        → Part Number Extraction
--   صفحة اعدادات استقبال طلبات استخراج رقم القطعه  → Part Number Request Settings
-- These are the provider side of the part-number extraction work the internal dashboard already
-- models as a queue; the platform role `part_extractor` is the same idea from the staff side.
--
-- Profile → My Profile, matching the vendor portal's unification in 0071: one name per page.
--
-- ASSIGNMENTS AND INVOICES ARE KEPT although the board does not draw them, for the same reason
-- Settings was kept in 0071 — the board is a plan for what to build, not a list of what to delete.

alter table app_pages add column if not exists parent_key text references app_pages(key) on delete cascade;--> statement-breakpoint

-- A child cannot have children. Enforced in the database because the sidebar renders exactly one
-- level and a deeper row would simply vanish from the menu with no error anywhere.
create or replace function app_pages_one_level() returns trigger language plpgsql as $$
begin
  if new.parent_key is not null then
    if exists (select 1 from app_pages p where p.key = new.parent_key and p.parent_key is not null) then
      raise exception 'page % would be a third level: its parent % is already a child',
        new.key, new.parent_key;
    end if;
    if exists (select 1 from app_pages c where c.parent_key = new.key) then
      raise exception 'page % already has children and cannot become a child itself', new.key;
    end if;
  end if;
  return new;
end $$;--> statement-breakpoint
drop trigger if exists trg_app_pages_one_level on app_pages;--> statement-breakpoint
create trigger trg_app_pages_one_level before insert or update on app_pages
  for each row execute function app_pages_one_level();--> statement-breakpoint

update app_pages set sort_order = sort_order + 9 where sort_order > 94;--> statement-breakpoint

update app_pages set label = 'My Profile', updated_at = now() where key = 'service_provider.provider.profile';--> statement-breakpoint

insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('service_provider.provider.extraction',          'service_provider', 'service_provider', '/provider/extraction',          'Part Number Extraction',       'PackageSearch',  'Part numbers', 0, false),
  ('service_provider.provider.extraction-settings', 'service_provider', 'service_provider', '/provider/extraction-settings', 'Part Number Request Settings', 'SlidersHorizontal', 'Part numbers', 0, false),
  ('service_provider.provider.rfq-new',             'service_provider', 'service_provider', '/provider/rfq-new',             'New RFQ',                      'FilePlus2',      'Procurement',  0, false),
  ('service_provider.provider.rfq-new.regular',     'service_provider', 'service_provider', '/provider/rfq-new/regular',     'Regular RFQ',                  'FileText',       'Procurement',  0, false),
  ('service_provider.provider.rfqs',                'service_provider', 'service_provider', '/provider/rfqs',                'RFQs Dashboard',               'Files',          'Procurement',  0, false),
  ('service_provider.provider.orders',              'service_provider', 'service_provider', '/provider/orders',              'Orders Dashboard',             'ShoppingCart',   'Procurement',  0, false),
  ('service_provider.provider.wallet',              'service_provider', 'service_provider', '/provider/wallet',              'Wallet',                       'Wallet',         'Finance',      0, false),
  ('service_provider.provider.users',               'service_provider', 'service_provider', '/provider/users',               'Users & Permissions',          'Users',          'Account',      0, false),
  ('service_provider.provider.account-managers',    'service_provider', 'service_provider', '/provider/account-managers',    'Account Managers',             'CalendarClock',  'Account',      0, false)
on conflict (key) do nothing;--> statement-breakpoint

-- the sub-item, set after both rows exist
update app_pages set parent_key = 'service_provider.provider.rfq-new'
  where key = 'service_provider.provider.rfq-new.regular';--> statement-breakpoint

insert into app_page_roles (page_key, role)
  select key, 'service_provider' from app_pages
  where persona = 'service_provider'
on conflict do nothing;--> statement-breakpoint

update app_pages p set sort_order = v.n, group_heading = v.g from (values
  ('service_provider.provider',                      91, 'Provider'),
  ('service_provider.provider.assignments',          92, 'Provider'),
  ('service_provider.provider.extraction',           93, 'Part numbers'),
  ('service_provider.provider.extraction-settings',  94, 'Part numbers'),
  ('service_provider.provider.rfq-new',              95, 'Procurement'),
  ('service_provider.provider.rfq-new.regular',      96, 'Procurement'),
  ('service_provider.provider.rfqs',                 97, 'Procurement'),
  ('service_provider.provider.orders',               98, 'Procurement'),
  ('service_provider.provider.invoices',             99, 'Finance'),
  ('service_provider.provider.wallet',              100, 'Finance'),
  ('service_provider.provider.users',               101, 'Account'),
  ('service_provider.provider.account-managers',    102, 'Account'),
  ('service_provider.provider.profile',             103, 'Account')
) as v(k, n, g) where p.key = v.k;--> statement-breakpoint

-- Same two invariants as every other portal: one run per heading, and a child immediately after its
-- parent so nesting and ordering cannot disagree.
do $$
declare bad int;
begin
  select count(*) into bad from (
    select group_heading from (
      select group_heading, lag(group_heading) over (order by sort_order) as prev
      from app_pages where persona = 'service_provider'
    ) t where prev is distinct from group_heading
    group by group_heading having count(*) > 1
  ) x;
  if bad > 0 then raise exception 'provider menu would show % duplicated heading(s)', bad; end if;

  select count(*) into bad from app_pages c join app_pages p on p.key = c.parent_key
   where c.parent_key is not null
     and (c.sort_order <= p.sort_order or c.group_heading <> p.group_heading);
  if bad > 0 then raise exception '% child page(s) are ordered or grouped away from their parent', bad; end if;
end $$;
