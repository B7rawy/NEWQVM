-- 0061_in_app_notifications.sql — the ONE notification channel this system can honestly deliver.
--
-- NotificationsService.send() writes a notification_log row and dispatches nothing, because there is
-- no SMTP client and no WhatsApp app behind it. That is why `notify` is absent from the workflow
-- action catalog (see the header of modules/workflow/actions.ts) and why the Communications portal
-- says "nothing is connected": recording an intention and calling it a delivery is the defect this
-- codebase refuses to ship.
--
-- IN-APP HAS NO PROVIDER TO BE MISSING. It is a row this application writes and this application
-- reads back. There is nothing to configure, nothing to go down, and no third party to lie about.
-- So it is the channel that can be built for real today, and everything that needs to tell a person
-- something — the unread badge, an approval waiting on them, the failure digest when it lands — can
-- stop pretending and start pointing here.
--
-- WHO MAY READ ONE. A notification is addressed to a PERSON, not to a workspace. The tenant policy
-- apply_tenant_rls() installs is not enough on its own: it reads
--   using (tenant_id = current_tenant_id() OR app_is_internal())
-- and that OR is a deliberate break-glass for platform staff. Break-glass is right for orders and
-- wrong for somebody's inbox, so this table adds a RESTRICTIVE addressee policy on top. Restrictive
-- policies are AND-ed with everything else, so no permissive escape — present or future — can widen
-- it back open. A super admin reading another person's notifications would be a privacy hole that
-- looked exactly like a working feature.
--
-- THE ADDRESSEE POLICY IS DELIBERATELY NOT `FOR ALL`. Delivery is written BY somebody else: the
-- approver's notification is inserted inside the requester's transaction, where app.user_id is the
-- requester. A FOR ALL restrictive policy would apply its WITH CHECK to INSERT and make it
-- impossible to notify anyone but yourself — i.e. it would silently disable the entire feature while
-- every read path went on looking correct. SELECT / UPDATE / DELETE are addressee-only; INSERT stays
-- governed by the tenant + environment policies.
--
-- CONSEQUENCE FOR CALLERS, and it has already bitten once elsewhere in this repo: `INSERT …
-- RETURNING` re-checks the SELECT policies against the new row, so an insert that returns a column
-- FAILS when writing for another user. The delivery path in notifications.service.ts inserts without
-- RETURNING for exactly this reason.

create table if not exists in_app_notifications (
  id           uuid primary key default gen_random_uuid() not null,
  tenant_id    uuid not null references tenants(id),
  -- ADR-0012. A notification raised by a Sandbox experiment must not appear in the Live inbox of the
  -- person who ran it, and vice versa. No suppression is needed the way it is for email: in-app
  -- delivery inside Sandbox IS real delivery — the reader is in Sandbox too, and the RESTRICTIVE
  -- environment policy is what keeps the two inboxes apart.
  environment  environment_type not null default 'live',
  -- The person. Not a role, not a queue: a role would make "unread" meaningless the moment two
  -- people hold it, because neither of them could ever clear the other's badge.
  recipient_user_id uuid not null references users(id),
  title        text not null,
  body         text,
  /**
   * The screen this is about, as an IN-APP path ("/approvals"). Checked rather than trusted: this
   * value is rendered as a router destination, so an absolute or protocol-relative URL would turn a
   * notification into an off-site redirect wearing the product's own chrome.
   */
  link         text,
  /** What kind of thing happened — 'approval', 'workflow', 'digest'. Free text on purpose: a check
   *  constraint here would mean a migration every time a new producer is wired, and an unknown kind
   *  degrades to a plain notification rather than to a broken one. */
  kind         text not null default 'system',
  /** NULL = unread. A nullable timestamp rather than a boolean because "when did they see it" is the
   *  question asked next, and a boolean cannot be widened into it without another migration. */
  read_at      timestamptz,
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null,
  created_by   uuid,
  updated_by   uuid,
  -- A notification with no title is a badge increment with nothing behind it: the reader is told
  -- something happened and cannot be told what. Refuse it where the API cannot be bypassed.
  constraint in_app_notifications_title_ck check (length(btrim(title)) > 0),
  constraint in_app_notifications_kind_ck  check (length(btrim(kind)) > 0),
  constraint in_app_notifications_link_ck  check (
    link is null or (link like '/%' and link not like '//%')
  )
);--> statement-breakpoint

-- THE UNREAD COUNT IS THE HOT READ. Every authenticated page load asks "how many unread do I have",
-- and the answer must be one index range, never a scan of an append-only table that only ever grows.
-- PARTIAL on `read_at is null` so the index holds only the rows the question is about: an inbox that
-- is 99% read keeps an index a few rows long, and the count stays as cheap in year three as on day
-- one. Column order is the equality tuple the count filters on, so it is a single index lookup.
create index if not exists in_app_notifications_unread_idx
  on in_app_notifications (recipient_user_id, tenant_id, environment)
  where read_at is null;--> statement-breakpoint

-- The list read: same equality tuple, then newest first, so the ORDER BY is served by the index
-- instead of sorting the whole inbox to show ten rows.
create index if not exists in_app_notifications_inbox_idx
  on in_app_notifications (recipient_user_id, tenant_id, environment, created_at desc);--> statement-breakpoint

SELECT public.apply_tenant_rls('in_app_notifications');--> statement-breakpoint

-- ── the addressee floor ─────────────────────────────────────────────────────────────────────────
-- RESTRICTIVE: AND-ed with tenant_isolation and environment_isolation, so the app_is_internal()
-- escape in the tenant policy cannot reach a person's inbox. app_user_id() is NULL on a session with
-- no signed-in user, and `NULL = recipient_user_id` is NULL, i.e. not true — so an anonymous or
-- machine session sees nothing here rather than everything, which is the correct direction to fail.
DO $$ BEGIN
CREATE POLICY "in_app_notifications_addressee_read" ON "in_app_notifications"
  AS RESTRICTIVE FOR SELECT
  USING (recipient_user_id = public.app_user_id());
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- Marking read is a statement about MY inbox. The WITH CHECK is what stops an update from moving a
-- row onto somebody else on the way through.
DO $$ BEGIN
CREATE POLICY "in_app_notifications_addressee_update" ON "in_app_notifications"
  AS RESTRICTIVE FOR UPDATE
  USING (recipient_user_id = public.app_user_id())
  WITH CHECK (recipient_user_id = public.app_user_id());
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
CREATE POLICY "in_app_notifications_addressee_delete" ON "in_app_notifications"
  AS RESTRICTIVE FOR DELETE
  USING (recipient_user_id = public.app_user_id());
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

comment on table in_app_notifications is
  'In-app notification inbox — the one notification channel with real delivery, because it needs no '
  'provider. Addressed to a person: a RESTRICTIVE policy limits SELECT/UPDATE/DELETE to the '
  'recipient, so not even platform staff can read somebody else''s. INSERT is deliberately NOT '
  'covered — delivery is written by whoever caused it. See the header of migration 0061.';--> statement-breakpoint

comment on column in_app_notifications.read_at is
  'NULL means unread. The unread count reads the partial index in_app_notifications_unread_idx, so '
  'setting this column is what removes the row from the hot read entirely.';
