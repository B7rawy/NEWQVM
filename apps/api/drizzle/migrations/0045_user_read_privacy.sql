-- 0045_user_read_privacy — stop every authenticated session from reading every user row.
--
-- `apply_global_rls()` gives non-tenant tables a blanket `global_read USING (true)`. That is right for
-- reference vocabulary (car_brands, item_statuses, regions, payment_accounts — which is a lookup list
-- of payment METHODS, not accounts). It is wrong for two of them:
--
--   users            — email, phone, full_name, and the existence of password_hash
--   platform_members — who Qparts' own staff are, and which platform_role each holds
--
-- Proven on 2026-07-25 as role qvm_app with app.is_internal = false (i.e. an ordinary workspace or
-- vendor-portal session): 6 of 6 user rows readable with emails, plus the full platform staff list.
-- RLS is meant to be the floor under the API, and for these two tables it was not holding.
--
-- Safe to tighten: every reader of both tables runs under app_is_internal() — verified call-site by
-- call-site (auth.guard, auth.service, me.controller, impersonation, users-admin, platform-staff,
-- workspaces.controller list(), vendors.service, org.service, provider-portal, counterparty.service).
-- The one non-internal context in workspaces.controller (branches()) touches neither table.
--
-- Follows the 0032_individual_read_privacy pattern. SAME CAVEAT: do NOT re-run apply_global_rls() on
-- these tables afterwards — it would recreate the permissive global_read and reopen the hole.
--
-- DELIBERATELY NOT INCLUDED: vendor_users / workshop_users / service_provider_users, which leak the
-- person↔company mapping. They are read from 17 files including the shared counterparty helper, so
-- narrowing them needs its own verification pass rather than being smuggled in here.

-- ── users ───────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "global_read" ON "users";--> statement-breakpoint
DO $$ BEGIN
CREATE POLICY "user_self_or_internal_read" ON "users" FOR SELECT USING (
  public.app_is_internal()
  -- you can always read your own row (drives /me, and keeps a session usable with no tenant context)
  OR id = public.app_user_id()
);
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- ── platform_members ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "global_read" ON "platform_members";--> statement-breakpoint
DO $$ BEGIN
CREATE POLICY "platform_member_internal_read" ON "platform_members" FOR SELECT USING (
  public.app_is_internal()
  -- your own membership: auth.guard resolves it to decide whether you ARE internal
  OR user_id = public.app_user_id()
);
EXCEPTION WHEN duplicate_object THEN null; END $$;
