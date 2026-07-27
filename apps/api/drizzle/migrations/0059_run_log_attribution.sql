-- 0059_run_log_attribution.sql — the run log must not say a named colleague was "no signed-in user".
--
-- 0056 gave the engine a run log and item 6 gave it a screen. An adversarial read of that screen
-- found it misattributing work, three separate ways, and all three are the same underlying mistake:
-- the query resolved WHO by joining `users`, and inferred WHAT KIND OF ACTOR from a null.
--
-- ── 1. `left join users` is empty for the very reader the screen was built for ───────────────────
-- 0045 replaced blanket read on `users` with `app_is_internal() OR id = app_user_id()`. A workspace
-- company_admin — the audience the run-log controller names in its own header — is NOT internal, so
-- that join resolves exactly one row: their own. Every colleague's move came back with a null name,
-- and the screen rendered its "no actor" label, which it defines as meaning a vendor arriving through
-- an unauthenticated quote link. So the log positively asserted that a vendor did work a named
-- employee had done. Confirmed at the policy, at the SQL and at the API.
--
-- The house pattern is to snapshot the name at write time (`workflow_exceptions.requested_by_name`,
-- `approval_requests.requested_by_name`), and it works precisely because a user can always read
-- their OWN row. But status_logs is written by the single status gateway on every move of every
-- record, and backfilling a name onto history nobody recorded is not possible. So this goes the other
-- way: one SECURITY DEFINER function, narrow enough to be safe to call.
--
-- WHAT IT WILL AND WILL NOT TELL YOU. It answers only for people the caller has a legitimate reason
-- to see: a member of the caller's own workspace gets their name; platform staff acting inside the
-- workspace resolve to a role rather than a person, because which Qparts employee touched an order is
-- our business and not the customer's; anyone else resolves to nothing. Internal callers see names
-- throughout, as they do everywhere else. Without that predicate a SECURITY DEFINER lookup over
-- `users` would be a name-disclosure oracle for any uuid the caller cared to guess.

create or replace function public.workflow_actor_label(p_user uuid)
returns text
language plpgsql
security definer
stable
set search_path to ''
as $function$
-- current_tenant_id(), not app_tenant_id(). The sibling helpers ARE app_is_internal() and
-- app_user_id(), so the symmetrical name is the one you expect and it does not exist; the first
-- version of this function called it and every request 500'd. Verified against pg_proc.
DECLARE v_name text; v_tenant uuid; v_internal boolean;
BEGIN
  IF p_user IS NULL THEN RETURN NULL; END IF;

  v_tenant   := public.current_tenant_id();
  v_internal := public.app_is_internal();

  SELECT full_name INTO v_name FROM public.users WHERE id = p_user;
  IF v_name IS NULL THEN RETURN NULL; END IF;

  -- internal callers already read the directory directly; nothing new is exposed here
  IF v_internal THEN RETURN v_name; END IF;

  IF v_tenant IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tenant_memberships m
     WHERE m.user_id = p_user AND m.tenant_id = v_tenant AND m.is_active
  ) THEN
    RETURN v_name;
  END IF;

  -- Acted on this workspace's records without being a member of it: that is Qparts staff. Naming the
  -- ROLE is the honest answer — "someone at Qparts did this" is true and useful, while the specific
  -- employee is not the customer's business and their name is not theirs to read.
  IF EXISTS (SELECT 1 FROM public.platform_members pm WHERE pm.user_id = p_user AND pm.is_active) THEN
    RETURN 'Qparts staff';
  END IF;

  RETURN NULL;
END $function$;--> statement-breakpoint

revoke all on function public.workflow_actor_label(uuid) from public;--> statement-breakpoint
grant execute on function public.workflow_actor_label(uuid) to qvm_app;--> statement-breakpoint

comment on function public.workflow_actor_label(uuid) is
  'Resolves an actor to a label the caller may legitimately see, bypassing the 0045 self-or-internal '
  'policy on users. Members of the caller''s workspace resolve to their name; platform staff to the '
  'role "Qparts staff"; anyone else to NULL. Exists because the run log joined users directly and '
  'came back empty for every workspace reader, which the screen then rendered as "no signed-in user".';

-- ── 2. an action the engine ran by itself could never say so ─────────────────────────────────────
-- status_logs.auto_advanced (0055) marks a move the engine made. workflow_action_runs had no
-- equivalent, so the run log selected `null::boolean` for action rows and its "the workflow" branch
-- was unreachable: an action fired by an automatic move rendered as "no signed-in user", one line
-- below the move that fired it rendering correctly as "the workflow". One act, named two ways, and
-- the wrong one meaning "nobody was logged in".
--
-- It could have been inferred — runActions writes a null actor only when the move was automatic —
-- but an inference that depends on nobody ever passing a null userId down a manual path is the kind
-- of thing that stays true until it quietly does not. The flag is recorded instead.
alter table workflow_action_runs
  add column if not exists auto_advanced boolean not null default false;--> statement-breakpoint

comment on column workflow_action_runs.auto_advanced is
  'True when the move that triggered this action was made by the engine rather than a person. '
  'Mirrors status_logs.auto_advanced: a null actor alone cannot distinguish "the engine did it" from '
  '"nobody was signed in", and the run log needs to say which.';

-- ── 3. the index the run log's own comment claimed already existed ───────────────────────────────
-- The union orders and limits each branch separately so both can ride an index. That is true for
-- workflow_action_runs (0056 created it) and was false for status_logs, which had indexes on
-- (tenant_id) and (tenant_id, entity_type, entity_id) but nothing ordered on created_at. Measured at
-- 40,000 rows: Seq Scan plus a top-N sort of the workspace's entire move history on every page load.
-- status_logs is append-only and grows for the life of the tenant, so the cost of opening this screen
-- would have grown with it forever.
create index if not exists status_logs_recent_idx
  on status_logs (tenant_id, environment, created_at desc);
