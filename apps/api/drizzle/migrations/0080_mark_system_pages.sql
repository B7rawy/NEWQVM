-- 0080_mark_system_pages.sql — inside a counterparty's own portal, say which screens are theirs
-- and which are the platform's.
--
-- The tag added earlier was suppressed inside a portal that owns everything in it, on the grounds
-- that eighteen identical tags are decoration. That was half right. The back office does not own
-- everything in its menu: Status Logs, Users & Permissions, Account Managers and Overview are the
-- SAME screens the workspace has, at the same routes. Calling them "Internal" would be a claim, and
-- leaving them unmarked among marked ones is the answer.
--
-- THE TEST IS THE CATALOG'S, NOT MINE. A page is the platform's when its route is already
-- module='core' somewhere — core literally meaning "always on, belongs to every workspace". Nothing
-- here is a judgement about what feels systemic.
--
-- It reclassifies 8 rows and no others, which is itself the evidence the rule is sound: the back
-- office and the workshop reuse platform screens and get 4 each, while the VENDOR and PROVIDER
-- portals change by nothing at all, because they were built on their own /vendor/* and /provider/*
-- routes and genuinely own every page they show.
--
-- Gating is unaffected. These rows live in portals that only render for that counterparty's own
-- users, so core-versus-owned changes what the row SAYS, not whether it appears.

update app_pages set module = 'core', updated_at = now() where key in (
  'workshop.admin.users',   -- workshop: Users & Permissions  [/admin/users]
  'workshop.account-managers',   -- workshop: Account Managers  [/account-managers]
  'workshop.webhook-logs',   -- workshop: Webhook Logs  [/webhook-logs]
  'workshop.settings',   -- workshop: Settings  [/settings]
  'internal.overview',   -- internal: Overview  [/overview]
  'internal.status-logs',   -- internal: Status Logs  [/status-logs]
  'internal.admin.users',   -- internal: Users & Permissions  [/admin/users]
  'internal.account-managers'   -- internal: Account Managers  [/account-managers]
);


--> statement-breakpoint

do $$
declare bad text;
begin
  -- the vendor and provider portals must be untouched by this: if they lost pages to 'core' the
  -- rule is picking up something other than platform screens.
  select count(*)::text into bad from app_pages
   where persona in ('vendor','service_provider') and module = 'core';
  if bad <> '0' then raise exception '% vendor/provider page(s) became core — the rule is too broad', bad; end if;

  -- and every portal still has pages of its own to show
  select string_agg(persona, ', ') into bad from (
    select persona from app_pages
    where persona in ('vendor','workshop','service_provider','internal') and module <> 'core'
    group by persona having count(*) < 3) x;
  if bad is not null then raise exception 'portal(s) % have almost nothing of their own left', bad; end if;
end $$;
