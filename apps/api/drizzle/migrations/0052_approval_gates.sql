-- 0052_approval_gates.sql — QNEW-89 §6: the padlock finally does something.
--
-- `workflow_transitions.requires_approval` has been storable, drawable as a padlock on the canvas,
-- and enforced NOWHERE since the engine was built. Meanwhile a complete approvals engine (QNEW-53)
-- sat in another module with ordered levels, a named approver per level, and a serialised act() —
-- and the two had zero references between them. This migration is the wiring.
--
-- Two columns, and each closes a specific hole:
--
--   transition_key — WHICH move this approval authorises ("priced>confirmed"). Without it, an
--       approval granted for one move would silently authorise a different one on the same record,
--       which is the worst possible failure for a permissions feature: it looks like it worked.
--
--   consumed_at — an approval is spent ONCE. Without it the same grant re-authorises the same move
--       every time someone presses the button again, and "approved" quietly becomes "approved
--       forever".
--
-- WHY A RECORD IS NEVER LEFT STUCK: this repo has no scheduler, no queue worker and no notification
-- dispatcher (verified: zero @Cron, zero setInterval). An approval chain creates records that are
-- waiting BY DESIGN, so if granting the last level did not itself perform the move, an approved
-- order would sit doing nothing until a human happened to press the button again. So the final
-- approval executes the transition. The retry path still works; it is the fallback, not the plan.

alter table approval_requests
  add column if not exists transition_key text,
  add column if not exists consumed_at     timestamptz;

comment on column approval_requests.transition_key is
  'The move this approval authorises, as "fromCode>toCode". NULL for approvals not raised by the '
  'workflow engine (QNEW-53 raised them before the two were connected).';
comment on column approval_requests.consumed_at is
  'When the grant was spent on the move it authorised. An approval is single-use.';

-- One OPEN request per (record, move). Pressing a blocked button twice should join the request that
-- is already waiting, not open a second one and split the approvers across both.
create unique index if not exists approval_requests_open_uq
  on approval_requests (tenant_id, environment, entity_type, entity_id, transition_key)
  where overall_status = 'pending' and transition_key is not null;

-- "what is waiting on me" and "what has been approved but not yet acted on" are the two queries the
-- whole feature is judged by; both filter on status and neither should scan.
create index if not exists approval_requests_pending_idx
  on approval_requests (tenant_id, environment, overall_status)
  where overall_status = 'pending';
create index if not exists approval_requests_granted_idx
  on approval_requests (tenant_id, environment, entity_id, transition_key)
  where overall_status = 'approved' and consumed_at is null;
