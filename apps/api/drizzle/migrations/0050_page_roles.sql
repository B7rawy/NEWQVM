-- 0050_page_roles.sql — QNEW-89 §3: a page is a STATION, and it plays a role.
--
-- Until now `workflow_steps.pages` was a flat list of page keys: it could say WHERE a record shows
-- up, but not what that screen is allowed to do about it. So there was no way to express the most
-- common arrangement in this business — the workshop must SEE that its request is being worked on,
-- without being able to touch it.
--
-- Each entry becomes {page, mode}:
--   action   — this station owns the work; its buttons are live and it counts in My Work
--   watch    — read-only tracking; shows who holds it and for how long
--   optional — may intervene, possibly only after a delay (a manager picking up a stalled item)
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION: every existing flat string becomes {page: <it>, mode:
-- 'action'}, which is exactly what a routed page meant before. Nothing changes behaviour on upgrade.
--
-- ⚠ THE DANGEROUS PART, AND WHY IT IS IN THIS SAME MIGRATION:
-- routing.ts matched with `pages @> to_jsonb('rfqs')`. Containment finds a bare string inside a flat
-- array, and finds NOTHING inside an array of objects:
--     ["rfqs"]                          @> '"rfqs"'  ->  true
--     [{"page":"rfqs","mode":"action"}] @> '"rfqs"'  ->  false
-- Shipping the shape change without the predicate change would make every routed status vanish from
-- every screen — the exact disappearance the routing safety rule exists to prevent, caused by the
-- migration itself. The application-side change ships in the same commit; this header exists so the
-- next person who touches either one knows they are a pair.

alter table workflow_steps drop constraint if exists workflow_steps_pages_is_array;

update workflow_steps
   set pages = coalesce((
         select jsonb_agg(
                  case jsonb_typeof(e)
                    -- the old shape: a bare page key, which always meant "this desk acts on it"
                    when 'string' then jsonb_build_object('page', e #>> '{}', 'mode', 'action')
                    -- already migrated (re-run safety): keep it, defaulting a missing mode
                    else jsonb_build_object('page', e ->> 'page', 'mode', coalesce(e ->> 'mode', 'action'))
                  end)
         from jsonb_array_elements(pages) e), '[]'::jsonb)
 where jsonb_array_length(pages) > 0;

-- Every element must be an object carrying a known mode. Rejecting at the boundary keeps every
-- reader simple: nothing downstream has to defend against a stray string or a typo'd mode.
--
-- Expressed with jsonb_path_query_array rather than `not exists (select …)` because a CHECK
-- constraint may not contain a subquery — Postgres rejects it outright with transformSubLink.
-- Counting the elements that MATCH and comparing to the total says the same thing with a function.
alter table workflow_steps
  add constraint workflow_steps_pages_shape check (
    jsonb_typeof(pages) = 'array'
    and jsonb_array_length(pages) = jsonb_array_length(
      jsonb_path_query_array(
        pages,
        '$[*] ? (@.page != null && (@.mode == "action" || @.mode == "watch" || @.mode == "optional"))'
      ))
  );

comment on column workflow_steps.pages is
  'Stations this step appears on: [{page, mode}] where mode is action | watch | optional. '
  '[] = appears on every screen (the routing safety rule). TUNABLE on an active flow.';
