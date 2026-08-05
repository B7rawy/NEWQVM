-- 0076_workshop_pages.sql — the workshop portal reconciled with its board. Last of the five.
--
-- THE RENAMES ARE THE UNIFICATION, same as 0071 and 0073:
--   Dashboard    → Overview
--   New Request  → New RFQ
--   My Requests  → RFQs Dashboard
--   My Orders    → Orders Dashboard
--   Deliveries   → Delivered Orders
--
-- The last one also moves path, and that is the point of it. /deliveries and /delivered were the
-- same idea under two names in two portals; the board calls the workshop's "Delivered Orders",
-- which is what the workspace and platform menus already call /delivered. Neither route is wired —
-- both resolve to the ComingSoon placeholder — so consolidating them now costs nobody a page and
-- removes a duplicate before either gets built twice.
--
-- APPSHEET SYNC LOGS IS DELIBERATELY NOT HERE. The board lists it, and there is no AppSheet in this
-- system: `grep -ri appsheet` over apps/api and apps/web returns nothing. It belongs to the legacy
-- platform this one replaces, and a menu entry for a sync that does not exist would be inventing a
-- feature rather than documenting one. Say the word and it goes in as Soon.
--
-- Webhook Logs IS included even though webhooks are configured by the workspace rather than the
-- workshop, because the board asks for it and a read-only log is a defensible thing to show the
-- counterparty whose events are being sent. It is Soon, like everywhere else it appears.
--
-- Board order, with the pages the board omits (Returns & Exchanges, Invoices, Statement & Payments,
-- Branches, Settings) kept and slotted into the group they belong to — the board is a plan for what
-- to build, not a list of what to delete.

update app_pages set sort_order = sort_order + 9 where sort_order > 90;--> statement-breakpoint

update app_pages set label = 'Overview',        updated_at = now() where key = 'workshop.workshop';--> statement-breakpoint
update app_pages set label = 'New RFQ',         updated_at = now() where key = 'workshop.workshop.requests.new';--> statement-breakpoint
update app_pages set label = 'RFQs Dashboard',  updated_at = now() where key = 'workshop.workshop.requests';--> statement-breakpoint
update app_pages set label = 'Orders Dashboard',updated_at = now() where key = 'workshop.workshop.orders';--> statement-breakpoint
update app_pages set label = 'Delivered Orders', path = '/delivered', updated_at = now()
  where key = 'workshop.deliveries';--> statement-breakpoint

insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('workshop.workshop.store',              'workshop', 'workshop', '/workshop/store',              'Online Store',         'Store',         'Storefront', 0, false),
  ('workshop.shipping',                    'workshop', 'workshop', '/shipping',                    'Shipping & Delivery',  'Truck',         'Storefront', 0, false),
  ('workshop.paid-quotations',             'workshop', 'workshop', '/paid-quotations',             'Paid Quotations',      'Stamp',         'Storefront', 0, false),
  ('workshop.wallet',                      'workshop', 'workshop', '/wallet',                      'Wallet',               'Wallet',        'Storefront', 0, false),
  ('workshop.workshop.requests.new.regular','workshop', 'workshop', '/workshop/requests/new/regular','Regular RFQ',         'FileText',      'Requests',   0, false),
  ('workshop.notes-archive',               'workshop', 'workshop', '/notes-archive',               'Notes Archive',        'History',       'Records',    0, false),
  ('workshop.account-managers',            'workshop', 'workshop', '/account-managers',            'Account Managers',     'CalendarClock', 'Account',    0, false),
  ('workshop.webhook-logs',                'workshop', 'workshop', '/webhook-logs',                'Webhook Logs',         'Webhook',       'Account',    0, false),
  ('workshop.workshop.profile',            'workshop', 'workshop', '/workshop/profile',            'My Profile',           'UserCircle',    'Account',    0, false)
on conflict (key) do nothing;--> statement-breakpoint

update app_pages set parent_key = 'workshop.workshop.requests.new'
  where key = 'workshop.workshop.requests.new.regular';--> statement-breakpoint

insert into app_page_roles (page_key, role)
  select key, 'workshop' from app_pages where persona = 'workshop'
on conflict do nothing;--> statement-breakpoint

update app_pages p set sort_order = v.n, group_heading = v.g from (values
  ('workshop.workshop',                      80, 'Overview'),
  ('workshop.workshop.store',                81, 'Storefront'),
  ('workshop.shipping',                      82, 'Storefront'),
  ('workshop.paid-quotations',               83, 'Storefront'),
  ('workshop.wallet',                        84, 'Storefront'),
  ('workshop.workshop.requests.new',         85, 'Requests'),
  ('workshop.workshop.requests.new.regular', 86, 'Requests'),
  ('workshop.workshop.requests',             87, 'Requests'),
  ('workshop.workshop.orders',               88, 'Orders'),
  ('workshop.deliveries',                    89, 'Orders'),
  ('workshop.returns',                       90, 'Orders'),
  ('workshop.invoices',                      91, 'Billing'),
  ('workshop.statement',                     92, 'Billing'),
  ('workshop.notes-archive',                 93, 'Records'),
  ('workshop.workshop.branches',             94, 'Account'),
  ('workshop.admin.users',                   95, 'Account'),
  ('workshop.account-managers',              96, 'Account'),
  ('workshop.webhook-logs',                  97, 'Account'),
  ('workshop.workshop.profile',              98, 'Account'),
  ('workshop.settings',                      99, 'Account')
) as v(k, n, g) where p.key = v.k;--> statement-breakpoint

do $$
declare bad int; mism text;
begin
  select count(*) into bad from (
    select group_heading from (
      select group_heading, lag(group_heading) over (order by sort_order) as prev
      from app_pages where persona = 'workshop'
    ) t where prev is distinct from group_heading
    group by group_heading having count(*) > 1
  ) x;
  if bad > 0 then raise exception 'workshop menu would show % duplicated heading(s)', bad; end if;

  select count(*) into bad from app_pages c join app_pages p on p.key = c.parent_key
   where c.parent_key is not null
     and (c.sort_order <= p.sort_order or c.group_heading <> p.group_heading or c.persona <> p.persona);
  if bad > 0 then raise exception '% child page(s) sit away from their parent', bad; end if;

  select string_agg(path, ', ') into mism from (
    select path from app_pages group by path having count(distinct is_built) > 1) y;
  if mism is not null then
    raise exception 'shared route(s) disagree on built state: %', mism;
  end if;

  select count(*) into bad from (select sort_order from app_pages group by sort_order having count(*) > 1) z;
  if bad > 0 then raise exception '% sort_order collision(s)', bad; end if;
end $$;
