-- 0053_approval_requester_name.sql — who asked me to sign this?
--
-- Migration 0045 replaced `global_read USING(true)` on `users` with "yourself, or platform staff",
-- which was right: a workspace user has no business reading the whole directory. But it means an
-- approver who is a workspace user cannot read the row of a platform user who raised a request, and
-- the approvals inbox showed "asked by someone".
--
-- "Who is asking me to authorise this" is part of the decision, not decoration. Rather than widen a
-- policy to expose every user to every approver, snapshot the one name at the moment the request is
-- raised — the same pattern the schema already uses for `rfqs.customer_name_snapshot`.
--
-- A snapshot also ages correctly here: it records who asked AT THE TIME, which is what an audit
-- trail wants, rather than following a later rename.

alter table approval_requests
  add column if not exists requested_by_name text;

comment on column approval_requests.requested_by_name is
  'Display name of the requester, captured when the request was raised. Snapshot, not a join: an '
  'approver may be a workspace user who cannot read the requester''s row (see 0045).';

-- backfill what is visible; nothing existing depends on it
update approval_requests r
   set requested_by_name = u.full_name
  from users u
 where u.id = r.requested_by and r.requested_by_name is null;
