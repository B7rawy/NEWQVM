-- 0072_fix_portal_roles.sql — the vendor and workshop portals were seeded with roles that do not
-- exist at run time, which left both sidebars empty.
--
-- 0069 took the role vocabulary from the `membership_role` ENUM. That was the wrong source. The
-- value the resolver compares against is `ctx.role`, and auth.guard.ts computes it as:
--
--     tenant.role  ??  (vendorAccess ? "vendor" : workshopAccess ? "workshop"
--                       : providerAccess ? "service_provider" : platformRole)
--
-- So a vendor user arrives as the literal "vendor" and a workshop user as "workshop" — never as
-- vendor_admin, vendor_user, branch_manager or service_advisor. Those enum values are real, but
-- they name workspace MEMBERSHIP roles; nothing puts them on a counterparty's request. The seeded
-- rows therefore matched nothing and /nav returned zero groups for 25 pages across two portals.
--
-- It went unseen because the portal preview in the shell renders the STATIC tree, not /nav, so
-- looking at the vendor portal as an admin showed a full sidebar either way. Only logging in as a
-- vendor exposes it.
--
-- The provider and internal portals were already correct — both resolve to "service_provider".

delete from app_page_roles
where page_key in (select key from app_pages where persona in ('vendor', 'workshop'));--> statement-breakpoint

insert into app_page_roles (page_key, role)
  select key, 'vendor' from app_pages where persona = 'vendor'
  union all
  select key, 'workshop' from app_pages where persona = 'workshop'
on conflict do nothing;--> statement-breakpoint

-- Every portal must have at least one page its own role can open. A portal whose pages all match a
-- role nobody carries is a user staring at an empty sidebar with no way out, which is the bug this
-- file exists to fix — so it is asserted here rather than left to be noticed again.
do $$
declare bad text;
begin
  select string_agg(persona, ', ') into bad from (
    select p.persona from app_pages p
    join (values ('vendor','vendor'), ('workshop','workshop'),
                 ('service_provider','service_provider'), ('internal','service_provider')
         ) as m(persona, runtime_role) on m.persona = p.persona
    left join app_page_roles r on r.page_key = p.key and r.role = m.runtime_role
    group by p.persona having count(r.role) = 0
  ) x;
  if bad is not null then
    raise exception 'portal(s) % have no page their own role can open', bad;
  end if;
end $$;
