-- 0071_vendor_pages.sql — the vendor portal reconciled against its design board.
--
-- The board marked two kinds of thing. Blue "تحتاج دمج وتوحيد" on pages that exist under a different
-- name in a different portal and should read as ONE page across the product; red "صفحة جديدة لم تبني"
-- on pages that do not exist yet at all.
--
-- WHAT THE MERGES TURNED OUT TO BE. Every blue pair already exists exactly once here — the rebuild
-- had unified them and kept the other system's name. So the merge work is naming, not deletion:
--
--   Quotation Requests  →  Quotations
--   Invoices            →  Purchase & Return Invoices
--   Deliveries          →  Shipping & Delivery
--   Branches & Users    →  Users & Permissions
--   Vendor Profile      →  My Profile
--
-- Labels only. Paths, roles and modules are untouched, so no bookmark breaks and nobody's access
-- changes — a rename is the whole of the unification when the duplicate page never got built twice.
--
-- FOUR PAGES ARE GENUINELY NEW, and arrive as `is_built = false` so the sidebar marks them "Soon"
-- rather than offering a link to a screen that does not exist.
--
-- SETTINGS IS KEPT although the board does not list it. The board is a plan for what to build, not
-- an inventory of what to remove, and dropping a page a vendor may be using today on that basis
-- would be reading far too much into an omission. If it should go, that is its own decision.
--
-- Order follows the board top to bottom WITH ONE DEPARTURE. The board is a flat list with no
-- section headings; this menu has them, and they are rendered as consecutive runs. The board places
-- Shipping & Delivery between Online Store and Paid Quotations, which are 'Growth', while shipping
-- is 'Fulfillment & finance' here — dropping it there verbatim splits BOTH headings in two and the
-- vendor sees 'Fulfillment & finance' and 'Growth' twice each in one sidebar. It stays in
-- fulfillment, where it belongs, immediately after Invoice Financing. The first draft of this file
-- did it the board's way and the assertion at the bottom refused it.

update app_pages set sort_order = sort_order + 4 where sort_order > 75;--> statement-breakpoint

-- ── the unification: one name per page, product-wide ──
update app_pages set label = 'Quotations',                 updated_at = now() where key = 'vendor.vendor.quotations';--> statement-breakpoint
update app_pages set label = 'Purchase & Return Invoices', updated_at = now() where key = 'vendor.vendor.invoices';--> statement-breakpoint
update app_pages set label = 'Shipping & Delivery',        updated_at = now() where key = 'vendor.vendor.deliveries';--> statement-breakpoint
update app_pages set label = 'Users & Permissions',        updated_at = now() where key = 'vendor.vendor.branches';--> statement-breakpoint
update app_pages set label = 'My Profile',                 updated_at = now() where key = 'vendor.vendor.profile';--> statement-breakpoint

-- ── the four that do not exist yet ──
insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('vendor.vendor.paid-quotations',  'vendor', 'vendor', '/vendor/paid-quotations',  'Paid Quotations',    'Stamp',         'Growth',  0, false),
  ('vendor.vendor.wallet',           'vendor', 'vendor', '/vendor/wallet',           'Wallet',             'Wallet',        'Growth',  0, false),
  ('vendor.vendor.margins',          'vendor', 'vendor', '/vendor/margins',          'Profit Percentages', 'Percent',       'Account', 0, false),
  ('vendor.vendor.account-managers', 'vendor', 'vendor', '/vendor/account-managers', 'Account Managers',   'CalendarClock', 'Account', 0, false)
on conflict (key) do nothing;--> statement-breakpoint

-- The three commercial pages go to the vendor's admin only: margins and the wallet are money, and
-- the user list is who may act as this vendor. Paid Quotations and Account Managers are day-to-day
-- and match the pages either vendor role can already open.
insert into app_page_roles (page_key, role) values
  ('vendor.vendor.paid-quotations',  'vendor_admin'),
  ('vendor.vendor.paid-quotations',  'vendor_user'),
  ('vendor.vendor.wallet',           'vendor_admin'),
  ('vendor.vendor.margins',          'vendor_admin'),
  ('vendor.vendor.account-managers', 'vendor_admin'),
  ('vendor.vendor.account-managers', 'vendor_user')
on conflict do nothing;--> statement-breakpoint

-- ── board order, 62..79 ──
update app_pages p set sort_order = v.n from (values
  ('vendor.vendor',                  62),
  ('vendor.vendor.quotations',       63),
  ('vendor.vendor.confirmed',        64),
  ('vendor.vendor.invoices',         65),
  ('vendor.vendor.statement',        66),
  ('vendor.vendor.returns',          67),
  ('vendor.vendor.financing',        68),
  ('vendor.vendor.deliveries',       69),
  ('vendor.vendor.catalog',          70),
  ('vendor.vendor.store',            71),
  ('vendor.vendor.paid-quotations',  72),
  ('vendor.vendor.wallet',           73),
  ('vendor.vendor.market-index',     74),
  ('vendor.vendor.branches',         75),
  ('vendor.vendor.margins',          76),
  ('vendor.vendor.account-managers', 77),
  ('vendor.vendor.profile',          78),
  ('vendor.vendor.settings',         79)
) as v(k, n) where p.key = v.k;--> statement-breakpoint

-- Every heading must still be ONE run after the renumbering. Asserted, not assumed — this is what
-- caught the board-order placement above, inside the transaction, before anything was written.
do $$
declare bad int;
begin
  select count(*) into bad from (
    select group_heading from (
      select group_heading, lag(group_heading) over (order by sort_order) as prev
      from app_pages where persona = 'vendor'
    ) t where prev is distinct from group_heading
    group by group_heading having count(*) > 1
  ) x;
  if bad > 0 then
    raise exception 'vendor menu would show % duplicated group heading(s)', bad;
  end if;
end $$;
