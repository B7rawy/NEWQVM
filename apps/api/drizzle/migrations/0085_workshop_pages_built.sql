-- 0085_workshop_pages_built.sql — the workshop menu tells the truth about what just got built.
--
-- Six pages leave "Soon" because their screens now exist and work: Delivered Orders, Returns &
-- Exchanges, Invoices (relabelled from 0071's unification), Statement & Payments, Notes Archive,
-- My Profile — plus Regular RFQ, which renders the same form its parent points at, matching the
-- legacy menu's nesting.
--
-- THE PATHS MOVE INTO THE PORTAL'S OWN NAMESPACE (/workshop/…), for the same reason the vendor
-- portal owns /vendor/…: those routes were SHARED with the workspace persona's still-unbuilt
-- placeholder rows, and the shared-route guard rightly demands one truth per path. A portal page
-- and a workspace page are different screens for different people; giving each its own route is
-- what makes "built here, Soon there" an honest state instead of a violation. Nothing breaks: the
-- old paths were placeholders nobody could bookmark.
--
-- The Storefront teasers (Online Store, Shipping & Delivery, Paid Quotations, Wallet), Account
-- Managers and Webhook Logs remain Soon on purpose — the LEGACY sidebar ships the same teasers
-- with the same badge, so the port is faithful there too.

update app_pages set path = '/workshop/delivered', is_built = true, updated_at = now() where key = 'workshop.deliveries';--> statement-breakpoint
update app_pages set path = '/workshop/returns',   is_built = true, updated_at = now() where key = 'workshop.returns';--> statement-breakpoint
update app_pages set path = '/workshop/invoices',  is_built = true, updated_at = now() where key = 'workshop.invoices';--> statement-breakpoint
update app_pages set path = '/workshop/statement', is_built = true, updated_at = now() where key = 'workshop.statement';--> statement-breakpoint
update app_pages set path = '/workshop/notes',     is_built = true, updated_at = now() where key = 'workshop.notes-archive';--> statement-breakpoint
update app_pages set is_built = true, updated_at = now() where key = 'workshop.workshop.profile';--> statement-breakpoint
update app_pages set path = '/workshop/requests/new/regular', is_built = true, updated_at = now()
  where key = 'workshop.workshop.requests.new.regular';--> statement-breakpoint

do $$
declare bad text;
begin
  -- every workshop page that claims to be built must live under the portal's own routes or the
  -- shared core ones — never on a workspace placeholder path
  select string_agg(path, ', ') into bad from app_pages
   where persona = 'workshop' and is_built
     and path not like '/workshop%' and path not in ('/admin/users', '/settings');
  if bad is not null then raise exception 'built workshop page(s) on foreign paths: %', bad; end if;

  -- and the shared-route truth still holds product-wide
  select string_agg(path, ', ') into bad from (
    select path from app_pages group by path having count(distinct is_built) > 1) x;
  if bad is not null then raise exception 'shared route disagrees on built state: %', bad; end if;
end $$;
