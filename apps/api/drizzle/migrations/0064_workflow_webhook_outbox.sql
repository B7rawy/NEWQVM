-- 0064_workflow_webhook_outbox.sql — the store-and-forward queue behind the `webhook` action, and
-- the per-workspace secret that lets a receiver tell a real call from anyone who learned the URL.
-- QNEW-90 item 3, the last entry in the action catalog.
--
-- ── WHY THIS TABLE EXISTS AT ALL, IN ONE SENTENCE ───────────────────────────────────────────────
-- THE ACTION WRITES A ROW HERE INSIDE THE BUSINESS TRANSACTION AND SENDS NOTHING, SO A ROLLBACK
-- TAKES THE OUTBOX ROW WITH IT AND A RECEIVER IS ONLY EVER TOLD ABOUT SOMETHING THAT REALLY
-- COMMITTED.
--
-- That is the whole reason `webhook` was held back through migrations 0056 and 0061 while the other
-- four actions shipped. Firing outbound HTTP from inside the move means the request leaves the
-- process the instant the action runs — and the move that caused it has not committed yet. Every
-- rule after the action can still refuse it: the exception freeze (0054) stops a record whose hold
-- was recorded in an earlier request, an approval gate (0052) can still be unsatisfied, and any
-- later statement in the same operation can raise. guard-check.sh already drives exactly this
-- sequence and asserts that a refused confirm ROLLS BACK the set_field an action had already run on
-- the header. A webhook cannot be rolled back. The receiver would have booked a shipment, charged a
-- card or told a customer, against an order that does not exist, and nothing in this system would
-- know — the run log would show the action succeeding, because from the engine's point of view it
-- did.
--
-- An outbox turns that from a race into an impossibility. The action's only effect is one INSERT in
-- the caller's own transaction. If the transaction commits, the row is there and the dispatcher will
-- deliver it. If it rolls back, the row was never there and there is nothing to deliver. There is no
-- third outcome, and no window in which one is true and the other is not.
--
-- ── WHY THE ROW CARRIES THE PAYLOAD RATHER THAN A POINTER TO THE RECORD ─────────────────────────
-- The delivery describes the record AS IT WAS WHEN THE MOVE HAPPENED. Re-reading the record at send
-- time would describe it as it is minutes later — possibly after two more moves, possibly after it
-- was deleted (0062), in which case the delivery would have nothing to describe and would die for a
-- reason that has nothing to do with the receiver. Freezing the payload at enqueue is also what lets
-- the whole thing be retried safely: every attempt sends byte-for-byte the same body, so a receiver
-- that de-duplicates on the delivery id gets a consistent answer whichever attempt reaches it first.
--
-- ── WHY status STAYS 'pending' WHILE AN ATTEMPT IS IN FLIGHT ────────────────────────────────────
-- There is deliberately no 'delivering' state. The dispatcher CLAIMS a row by bumping `attempts` and
-- pushing `next_attempt_at` into the future in one committed statement, then closes the transaction
-- and only then opens the socket. Two consequences, both wanted:
--   • no database transaction is ever held open across a network call, so a hung receiver cannot
--     pin a connection out of a pool of ten for the length of its timeout;
--   • a process killed mid-send leaves a row that is simply due again after the backoff, instead of
--     a row stuck in 'delivering' that needs a reaper nobody wrote.
-- `for update skip locked` on the claim is what stops two API processes — which is exactly what pm2
-- with more than one instance produces — claiming the same row in the same second.

create table if not exists workflow_webhook_outbox (
  id                 uuid primary key default gen_random_uuid() not null,
  tenant_id          uuid not null references tenants(id),
  -- ADR-0012. A Sandbox rehearsal must not call the receiver that Live calls with the Live secret;
  -- keeping the environment on the row is what lets the dispatcher run two isolated passes and what
  -- lets the signing secret below differ between them.
  environment        environment_type not null default 'live',
  entity_type        entity_type not null,
  entity_id          uuid not null,
  /** "fromCode>toCode" — the arrow that caused it, the same key workflow_action_runs records. */
  transition_key     text,
  /** Where it goes. Validated for scheme and shape by the action before this row is written, and
   *  validated AGAIN — including what the name resolves to — at send time. See webhook-url.ts. */
  url                text not null,
  /** The body, frozen at enqueue. Every attempt sends exactly these bytes. */
  payload            jsonb not null default '{}'::jsonb,
  /** How many times the dispatcher has opened a socket for this row. Bumped when the attempt is
   *  CLAIMED rather than when it finishes, so a crashed process still counts as having tried. */
  attempts           integer not null default 0,
  /** When it may next be picked up. Defaults to now() so the first attempt is immediate; the
   *  dispatcher pushes it forward by the backoff on every claim. */
  next_attempt_at    timestamptz not null default now(),
  status             text not null default 'pending',
  /** What went wrong last, in the words a person reading the run log would need. Kept on the row
   *  even after it dies, because "it stopped trying" without "and here is why" is not an answer. */
  last_error         text,
  /** The receiver's HTTP status on the last attempt, or NULL when no response was ever read —
   *  a refused address, a DNS failure and a timeout are all "no response", and they are different
   *  from a 500, which is a receiver that answered and said no. */
  last_response_code integer,
  delivered_at       timestamptz,
  created_at         timestamptz default now() not null,
  updated_at         timestamptz default now() not null,
  created_by         uuid,
  updated_by         uuid,
  -- 'pending' — still owed. 'delivered' — a 2xx was read. 'dead' — the attempt ceiling was reached
  -- and nobody will try again. Three states and no fourth: a value the dispatcher cannot act on and
  -- the run log cannot render must not be storable.
  constraint workflow_webhook_outbox_status_ck check (status in ('pending', 'delivered', 'dead')),
  -- THE DATABASE REFUSES A NON-HTTPS DESTINATION TOO. The action validates the URL and is the only
  -- writer today, but this row is the thing that makes a request leave the building, and a check
  -- that lives only in TypeScript is one hand-fix on a live database away from being absent. It is
  -- deliberately a prefix test and not an attempt at URL parsing — the real guard is webhook-url.ts;
  -- this is the floor under it.
  constraint workflow_webhook_outbox_https_ck check (url like 'https://%'),
  constraint workflow_webhook_outbox_url_len_ck check (length(url) between 9 and 2048),
  constraint workflow_webhook_outbox_attempts_ck check (attempts >= 0)
);--> statement-breakpoint

-- The dispatcher's ONLY query: "what is due in this workspace and environment". Partial on
-- status = 'pending' because delivered and dead rows accumulate forever and must never be paid for
-- again — without the predicate the tick degrades into a scan of the entire delivery history, which
-- is invisible in a test database and fatal in a workspace two years old.
create index if not exists workflow_webhook_outbox_due_idx
  on workflow_webhook_outbox (tenant_id, environment, next_attempt_at)
  where status = 'pending';--> statement-breakpoint

-- "what happened to the deliveries for this record" — asked by a person debugging one order, not by
-- the dispatcher, so it is a separate and much smaller index than the one above.
create index if not exists workflow_webhook_outbox_entity_idx
  on workflow_webhook_outbox (tenant_id, environment, entity_type, entity_id);--> statement-breakpoint

-- ── THE SIGNING SECRET ──────────────────────────────────────────────────────────────────────────
-- A URL is not an authenticator. Anyone who reads a flow definition, a database backup or a proxy
-- log learns the destination, and from then on can POST anything they like to it wearing our shape.
-- The receiver needs a way to tell our call from theirs, and the only thing it can check without a
-- round trip back to us is a signature over the bytes it just received.
--
-- ── THE SCHEME, WRITTEN OUT SO WHOEVER BUILDS THE RECEIVING END CAN IMPLEMENT IT ────────────────
-- Every delivery carries three headers:
--
--     X-QVM-Delivery:   <uuid>            the outbox row id — the SAME value on every retry
--     X-QVM-Timestamp:  <unix seconds>    when this attempt was signed
--     X-QVM-Signature:  v1=<hex>          hex HMAC-SHA256
--
-- The signed message is the timestamp, a full stop, and the raw request body, exactly as sent:
--
--     signature = hex( HMAC_SHA256( secret, timestamp + "." + rawBody ) )
--
-- To verify: read the raw body BEFORE any JSON parsing (a re-serialised body will not match —
-- key order, spacing and unicode escaping are all free to change), recompute, and compare in
-- constant time. Reject a timestamp more than a few minutes from your own clock; without that check
-- a captured request can be replayed forever, because the signature over it never expires.
--
-- The delivery id is also inside the body, and that is not duplication for convenience: only the
-- body is covered by the HMAC, so the header is a hint and the body's copy is the authenticated
-- one. De-duplicate on it — the dispatcher guarantees at-least-once, never exactly-once, so a
-- receiver that already processed a delivery id must answer 2xx and do nothing.
--
-- ── WHY THE SECRET IS GENERATED HERE AND NEVER TYPED ───────────────────────────────────────────
-- `secret` has no API that writes it and no default that a human chooses: the column default is two
-- gen_random_uuid() values with their hyphens stripped and concatenated — 64 hex characters, 244
-- bits of entropy, from the same CSPRNG (pg_strong_random) that mints every primary key in this
-- database. A secret somebody types is a secret somebody can guess, reuse from another system, or
-- paste into a chat, and the one thing this value must be is unguessable. There is exactly one way a
-- row is created (an INSERT that names only the workspace and the environment and lets the default
-- mint the value), which is why the length check below can be trusted to describe every row that
-- will ever exist.
--
-- gen_random_uuid() RATHER THAN gen_random_bytes(). The obvious spelling of "32 random bytes" is
-- pgcrypto's gen_random_bytes(32), and pgcrypto is NOT installed on this database. Adding it would
-- make deploying this migration depend on an extension being creatable on every box the platform
-- runs on, to save a `replace`. gen_random_uuid() has been core PostgreSQL since 13 and is already
-- the default on every id column in this schema, so it is a dependency we provably already have.
--
-- PER WORKSPACE, SPLIT BY ENVIRONMENT. "One workspace, one secret" is the promise; Sandbox gets its
-- own so a rehearsal cannot be signed with the credential that authenticates real orders, which is
-- the same reason ADR-0012 keeps every other pair of universes apart.
create table if not exists workflow_webhook_secrets (
  id           uuid primary key default gen_random_uuid() not null,
  tenant_id    uuid not null references tenants(id),
  environment  environment_type not null default 'live',
  /** 64 hex characters of CSPRNG output. Server-side by construction — see above. */
  secret       text not null
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null,
  created_by   uuid,
  updated_by   uuid,
  constraint workflow_webhook_secrets_scope_uq unique (tenant_id, environment),
  -- 64 hex characters is what the default produces. A shorter value could only arrive by hand, and a
  -- hand-chosen HMAC key is the failure this table's whole design is arranged to prevent.
  constraint workflow_webhook_secrets_len_ck check (length(secret) >= 64)
);--> statement-breakpoint

-- Minted for every workspace that exists today, in both environments, BEFORE row-level security is
-- applied below — with RLS on, this statement would have to run inside a workspace's session, and it
-- is about all of them. New workspaces get theirs on first use: the dispatcher and the read endpoint
-- both insert-on-conflict-do-nothing before reading, so the row is never missing when it is needed.
insert into workflow_webhook_secrets (tenant_id, environment)
select t.id, e.env
from tenants t
cross join (values ('live'::environment_type), ('sandbox'::environment_type)) as e(env)
on conflict (tenant_id, environment) do nothing;--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_webhook_outbox');--> statement-breakpoint
SELECT public.apply_tenant_rls('workflow_webhook_secrets');--> statement-breakpoint

comment on table workflow_webhook_outbox is
  'Pending outbound webhook deliveries. The webhook action writes a row here INSIDE the business '
  'transaction and sends nothing, so a rollback takes the row with it and a receiver is only ever '
  'told about something that really committed. A separate dispatcher sends them, with backoff and a '
  'terminal state. See the header of migration 0064.';--> statement-breakpoint

comment on table workflow_webhook_secrets is
  'One HMAC-SHA256 key per workspace per environment, generated by the database and never typed by '
  'a person. Deliveries are signed with it so a receiver can tell a real call from anyone who '
  'learned the URL. The exact scheme is written out in the header of migration 0064.';--> statement-breakpoint

comment on column workflow_webhook_outbox.next_attempt_at is
  'When this row may next be claimed. The dispatcher pushes it forward by the backoff AT CLAIM TIME '
  'rather than after the attempt finishes, so a process killed mid-send leaves a row that is simply '
  'due again instead of one stuck in a state nothing clears.';
