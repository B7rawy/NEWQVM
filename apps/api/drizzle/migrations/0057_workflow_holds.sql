-- 0057_workflow_holds.sql — a hold is not a cancellation.
--
-- 0056 gave the engine a `lock_record` action, and it froze a record by opening a row in
-- workflow_exceptions with kind = 'cancellation', because that was the only kind the CHECK allowed.
-- Reusing the freeze MECHANISM was right. Reusing the WORD was a defect with teeth:
--
--   the approvals inbox renders every open exception with a button labelled "Cancel it", and that
--   button calls resolve → approve → moves the record to `cancelled`.
--
-- So a hold the engine placed appeared to a reviewer as a cancellation request that no human had
-- made, one click away from destroying a live order. `unlock_record` had the mirror fault: it
-- released "the open exception" whatever its kind, so an automatic release could silently refuse a
-- customer's real cancellation request and file 'released by the workflow' as the reason.
--
-- A hold therefore gets its own kind and its own terminal state:
--   kind   'hold'      — placed by the engine. It freezes the record. NOBODY IS BEING ASKED
--                        ANYTHING, which is exactly what distinguishes it from the other two.
--   status 'released'   — taken off hold. Deliberately not 'rejected': there was no request to
--                        refuse, and an audit trail saying a request was rejected when none existed
--                        is a false record.
--
-- Only the labels needed fixing. The freeze itself stays kind-agnostic on purpose — one mechanism
-- means one place to look when a record will not move.

alter table workflow_exceptions
  drop constraint if exists workflow_exceptions_kind_ck,
  add  constraint workflow_exceptions_kind_ck
    check (kind in ('cancellation', 'return', 'hold'));--> statement-breakpoint

alter table workflow_exceptions
  drop constraint if exists workflow_exceptions_status_ck,
  add  constraint workflow_exceptions_status_ck
    check (status in ('open', 'approved', 'rejected', 'executed', 'released'));--> statement-breakpoint

comment on column workflow_exceptions.kind is
  'cancellation | return — a person is asking for a decision. hold — the engine froze this record '
  'via the lock_record action and no decision is being requested; it is released, not approved.';

-- Relabel anything the action already wrote under the wrong kind. 0056 has not been deployed, so in
-- practice this touches only local test data; it is written to be precise rather than broad because
-- mistaking a REAL cancellation request for an engine hold would hide it from its reviewer. The
-- engine's own default reason is the only marker those rows carry.
update workflow_exceptions
   set kind = 'hold', updated_at = now()
 where kind = 'cancellation' and status = 'open' and reason = 'held by the workflow';
