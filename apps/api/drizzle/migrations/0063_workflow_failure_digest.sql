-- 0063_workflow_failure_digest.sql — the ledger that makes a DAILY digest daily (QNEW-90 item 6).
--
-- The ticket asks for "a daily digest to configured recipients — digest, not one email per failure".
-- The word doing the work is DIGEST: a message per failure is a pager, and a rule that breaks two
-- hundred times before lunch would bury the one that broke once. So a digest covers a WINDOW, and a
-- window only means anything if the system remembers where the last one ended.
--
-- THAT MEMORY IS THIS TABLE, AND IT EXISTS FOR ONE PROPERTY: a failure is reported exactly once.
-- Without it the only implementable window is "the last 24 hours", which re-reports every failure
-- that happened in the overlap each time the job runs, and turns the digest into the flood it was
-- supposed to replace. With it, each window starts where the previous one ended, so:
--
--   • nothing is reported twice, however often the job runs or is run by hand;
--   • nothing is dropped when the job does NOT run — after two days down, the next window simply
--     spans both days, because window_start comes from the last row rather than from the clock.
--
-- THE UNIQUE KEY IS THE ENFORCEMENT, not the code above it. window_end is always a day boundary, so
-- (tenant, environment, window_end) can exist at most once and a second attempt at the same day is
-- refused by the database. Two API processes ticking at the same second — which is exactly what pm2
-- with more than one instance produces — cannot both send.
--
-- A ROW IS WRITTEN EVEN WHEN THE DAY HAD NO FAILURES, and that is deliberate rather than wasteful:
-- the row is what ADVANCES the window. Skipping the quiet days would mean the next digest re-opened
-- them, and a failure landing on a quiet day would be reported on a day it did not happen. Nothing
-- is delivered on a quiet day — a digest of nothing is a nag, and an inbox that pings daily to say
-- "all fine" is an inbox people stop reading.
--
-- PER (TENANT, ENVIRONMENT), NOT PER TENANT. ADR-0012: Sandbox and Live are parallel universes. A
-- Live digest that folded in Sandbox failures would report a rehearsal as a production incident;
-- worse, the reverse would hide a real failure among experiments. Sandbox gets its own digest for
-- the reason migration 0061 gives for delivering Sandbox notifications at all — finding out your
-- flow is broken while rehearsing is the entire point of having a Sandbox.

create table if not exists workflow_failure_digests (
  id           uuid primary key default gen_random_uuid() not null,
  tenant_id    uuid not null references tenants(id),
  environment  environment_type not null default 'live',
  /** Inclusive. Always the previous row's window_end, so the windows tile the timeline with no gap
   *  and no overlap — which is the whole no-re-report guarantee, written as data. */
  window_start timestamptz not null,
  /** Exclusive, and always a local midnight in the workspace's own business-calendar timezone — the
   *  same day boundary the action daily cap measures against (see refuseOverDailyCap in actions.ts).
   *  One definition of "a day" for the ceiling and for the report of what hit it. */
  window_end   timestamptz not null,
  /** What was found. Kept even when zero, because "we looked and there was nothing" is the fact
   *  that distinguishes a quiet day from a day the job never ran. */
  failures     integer not null default 0,
  /** How many people were actually told. Zero with failures > 0 is a real and visible state: the
   *  workspace has no active company_admin, so the digest had nowhere to go. */
  recipients   integer not null default 0,
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null,
  created_by   uuid,
  updated_by   uuid,
  -- A window that ends before it starts would silently select no failures and then claim the day was
  -- clean. Refuse it where no code path can bypass the check.
  constraint workflow_failure_digests_window_ck check (window_end > window_start),
  constraint workflow_failure_digests_window_uq unique (tenant_id, environment, window_end)
);--> statement-breakpoint

-- The job's first question, every tick, for every workspace: "where did the last window end?" The
-- unique constraint's index is on (tenant_id, environment, window_end) and answers it as one
-- backwards range scan, so the scheduler stays cheap as the table grows one row per workspace per
-- day forever.
create index if not exists workflow_failure_digests_latest_idx
  on workflow_failure_digests (tenant_id, environment, window_end desc);--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_failure_digests');--> statement-breakpoint

comment on table workflow_failure_digests is
  'One row per workspace per environment per day: the window a failure digest covered, and what it '
  'found. The window of the next digest starts where the last one ended, which is what makes a '
  'failure reportable exactly once. See the header of migration 0063.';
