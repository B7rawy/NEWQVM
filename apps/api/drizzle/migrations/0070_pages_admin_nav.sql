-- 0070_pages_admin_nav.sql — the screen that edits the catalog, added TO the catalog.
--
-- The sidebar is data now, so a new menu entry is an INSERT rather than an edit to nav.tsx. This is
-- the first page to arrive that way, and it is the one that edits page visibility — which makes it
-- the honest test of whether 0069 actually works: if this row does not appear in the sidebar, the
-- mechanism does not work, and there is no way to hide that.
--
-- ORDER IS RENUMBERED, NOT APPENDED. Groups are formed by CONSECUTIVE runs of group_heading, so a
-- 'Control tower' page appended at the end of the sequence would open a SECOND 'Control tower'
-- group at the bottom of the menu instead of joining the first. Everything at or after the
-- insertion point shifts by one so the new row lands inside the run it belongs to.
--
-- It is super-admin only, matching Workspaces and Workflows beside it: this screen can take a page
-- away from every role in a portal, which is a bigger lever than anything else in that group.

update app_pages set sort_order = sort_order + 1 where sort_order > 25;--> statement-breakpoint

insert into app_pages (key, module, persona, path, label, icon, group_heading, sort_order, is_built) values
  ('platform_system.admin.pages', 'core', 'platform_system', '/admin/pages', 'Pages', 'SlidersHorizontal', 'Control tower', 26, true)
on conflict (key) do nothing;--> statement-breakpoint

insert into app_page_roles (page_key, role) values
  ('platform_system.admin.pages', 'super_admin')
on conflict do nothing;
