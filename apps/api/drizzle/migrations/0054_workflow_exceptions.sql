-- 0054_workflow_exceptions.sql — QNEW-89 §7: cancellation and return as ATTACHED flows.
--
-- The statuses have existed in the vocabulary since the beginning (`cancellation_request`,
-- `return_request`, `cancelled`, `return`) with no request → review → execute path behind them, no
-- restore-on-reject, and nothing stopping an order from marching on while a cancellation was being
-- considered.
--
-- THE MODELLING DECISION, AND WHY IT IS NOT A STATUS IN THE MAIN CHAIN:
-- Splicing "cancellation_request" into the order's own status means the order has stopped being
-- confirmed/processing/delivered — you have destroyed the fact you need in order to put it back if
-- the cancellation is refused. An exception is a SEPARATE small flow hanging off the record, so
-- while it is open the record legitimately has two states: its real one (frozen) and the exception's.
--
-- WHY A NEW TABLE RATHER THAN workflow_record_state:
-- that table carries UNIQUE (tenant_id, environment, entity_type, entity_id) — exactly one row per
-- record, which its custody upsert depends on. Two concurrent states cannot live there without
-- dropping the constraint the rest of the engine relies on. An exception also has its own lifecycle
-- and its own fields (why, who asked, who decided, what to restore), so it earns a table.
--
-- restore_status_id IS CAPTURED WHEN THE EXCEPTION OPENS, not read back from status_logs at
-- rejection time. Reading it back would mean trusting that nothing else moved the record in between,
-- and the whole point of the freeze is that nothing did — but recording the answer is cheaper than
-- proving it, and it survives a log that gets trimmed.

create table if not exists workflow_exceptions (
  id                 uuid primary key default gen_random_uuid() not null,
  tenant_id          uuid not null references tenants(id),
  environment        environment_type not null default 'live',
  entity_type        entity_type not null,
  entity_id          uuid not null,
  -- 'cancellation' stops the order; 'return' sends delivered goods back. Same machinery, different
  -- entry conditions and different terminal status.
  kind               text not null,
  status             text not null default 'open',
  reason             text not null,
  requested_by       uuid references users(id),
  -- snapshot for the same reason approval_requests carries one: a workspace reviewer may not be able
  -- to read the requester's row (see 0045), and the audit trail wants who asked AT THE TIME.
  requested_by_name  text,
  resolved_by        uuid references users(id),
  resolved_by_name   text,
  resolved_at        timestamptz,
  resolution_note    text,
  /** The status to put the record back to if this is refused. Captured when the exception opens. */
  restore_status_id  uuid references item_statuses(id),
  created_at         timestamptz default now() not null,
  updated_at         timestamptz default now() not null,
  created_by         uuid,
  updated_by         uuid,
  constraint workflow_exceptions_kind_ck   check (kind in ('cancellation', 'return')),
  constraint workflow_exceptions_status_ck check (status in ('open', 'approved', 'rejected', 'executed'))
);--> statement-breakpoint

-- ONE open exception per record. Two people asking to cancel the same order should join one review,
-- not open two that can be decided differently.
create unique index if not exists workflow_exceptions_open_uq
  on workflow_exceptions (tenant_id, environment, entity_type, entity_id)
  where status = 'open';--> statement-breakpoint

-- the freeze check runs on EVERY guarded status move, so it must not scan
create index if not exists workflow_exceptions_open_idx
  on workflow_exceptions (tenant_id, environment, entity_type, entity_id, status)
  where status = 'open';--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_exceptions');--> statement-breakpoint

comment on table workflow_exceptions is
  'Cancellation and return as flows ATTACHED to a record, not statuses spliced into its main chain. '
  'While one is open the record keeps its real status (frozen) so a refusal can put it back.';
