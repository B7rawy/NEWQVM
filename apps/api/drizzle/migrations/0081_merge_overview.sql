-- 0081_merge_overview.sql — one dashboard, not two.
--
-- Every design board opened with the same blue note on its first row: "تحتاج دمج وتوحيد" across
-- Overview and Management Overview. I read that as already satisfied because the vendor, workshop
-- and provider portals each carry only one of the two — and missed that the WORKSPACE and PLATFORM
-- menus carried both, a click apart, each with its own hero and its own claim to be where the day
-- starts. That is exactly what the note was pointing at.
--
-- NOTHING WAS DELETED IN MERGING THEM. Overview.tsx is now the single dashboard with four tabs:
-- Snapshot (the live procurement view it always had) plus Workshop, Purchasing and Suppliers
-- Reports, whose 450 lines moved across from ManagementOverview.tsx unchanged. The language toggle
-- and the "Demo data" badge follow the report tabs, so the merge does not launder one tab's honesty
-- into another's.
--
-- /management-overview STILL RESOLVES, onto the merged page opened at Workshop Reports. Old links
-- keep working, and the unscoped platform view needs it: /overview redirects to the workspace list
-- when no workspace is chosen, so that menu keeps its own row and is renamed Overview to match.
--
-- The Snapshot tab reads a workspace, so it is hidden when there is none rather than rendering a
-- page of dashes.

-- personas with both: platform, workspace
delete from app_page_roles where page_key in ('platform.management-overview', 'workspace.management-overview');--> statement-breakpoint
delete from app_pages where key in ('platform.management-overview', 'workspace.management-overview');--> statement-breakpoint

-- the unscoped platform view has no /overview to merge into, so its single entry is renamed
update app_pages set label = 'Overview', updated_at = now() where key in ('platform_system.management-overview');

--> statement-breakpoint

do $$
declare n int;
begin
  select count(*) into n from (
    select persona from app_pages where path in ('/overview','/management-overview')
    group by persona having count(*) > 1) x;
  if n > 0 then raise exception '% portal(s) still list two dashboards', n; end if;

  select count(*) into n from app_pages a
   where a.persona in ('workspace','platform','platform_system','internal')
     and not exists (select 1 from app_pages b
                     where b.persona = a.persona and b.path in ('/overview','/management-overview'));
  if n > 0 then raise exception 'a portal was left with no dashboard at all'; end if;
end $$;
