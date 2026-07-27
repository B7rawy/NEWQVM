-- 0060_workflow_action_library.sql — QNEW-90 item 3, the reviewer's refinement: an action becomes a
-- reusable NAMED entity that lives in a shared library and is associated to rules, instead of only
-- ever being configured again by hand on the next arrow that needs the same thing.
--
--                       THE LIBRARY AUTHORS. THE FLOW REMEMBERS.
--
-- WHY A COPY AND NOT A POINTER. The obvious reading of "associated, not embedded" is a foreign key
-- from the transition to this row, resolved when the action runs. We are deliberately not doing
-- that, and the reason is the promise the SAME ticket calls our advantage over the benchmark (item
-- 1): a flow's semantics FREEZE on activation, and every record binds to the version it entered.
-- A pointer would put a live edit surface underneath a frozen rule. Somebody correcting a value on
-- a library row at 11:00 would change what an ACTIVE flow does at 11:01 — to orders that were judged
-- by the old rule an hour earlier — while the freeze triggers in 0047, the version clone in
-- newVersion() and workflow_record_state's binding all went on reporting that nothing had changed.
-- They would each be telling the truth about the columns they guard and a lie about the behaviour,
-- which is the worst kind of guarantee to own.
--
-- So adding an entry to a transition COPIES its action and its params into
-- workflow_transitions.actions, exactly as a hand-configured action already is, and additionally
-- stamps a RECEIPT on that array element: {"ref": {"id": …, "name": …}}.
--
--   THE COPY IS WHAT RUNS. status.service.ts and modules/workflow/actions.ts do not learn that this
--   table exists and are not touched by this change. An active flow executes bytes it froze, not a
--   row somebody can still edit. That is the whole property being protected.
--
--   THE RECEIPT IS WHAT REMEMBERS. It lets the builder answer "which flows use this entry", offer a
--   DRAFT a one-click re-copy when the two have drifted, and go on naming the entry on screen after
--   somebody deletes it from the library — which is why the receipt carries the NAME as well as the
--   id, and why deleting an entry is safe rather than something we have to refuse.
--
-- THE CONSEQUENCE THE UI IS REQUIRED TO SAY IN PLAIN WORDS: editing an entry does not change any
-- flow that already uses it. An admin who assumes it propagates and finds out from a live order is
-- exactly the defect this trade is made against, and the trade is only honest if the screen admits
-- it at the moment of editing rather than in a release note.
--
-- MODULE SCOPING is not repeated here. Which entity types an action applies to is a property of the
-- catalog entry (ActionDef.entities in actions.ts), not of a saved configuration of it, so an entry
-- inherits its scope from `action` and there is no second place for the two to disagree.

create table if not exists workflow_actions (
  id           uuid primary key default gen_random_uuid() not null,
  tenant_id    uuid not null references tenants(id),
  -- ADR-0012, same as the flows that copy from it: an entry is written and tried in Sandbox and
  -- exists separately in Live. One library spanning both would offer a Sandbox experiment from the
  -- picker while somebody was building the flow that runs real orders.
  environment  environment_type not null default 'live',
  name_en      text not null,
  name_ar      text not null,
  /** The catalog key from modules/workflow/actions.ts — refused at save time by actionByKey. */
  action       text not null,
  params       jsonb not null default '{}'::jsonb,
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null,
  created_by   uuid,
  updated_by   uuid,
  -- An empty key can only arrive by hand, and it would be copied into a transition as an action the
  -- engine cannot name — a rule that looks configured and logs "this server does not know the
  -- action ''" forever. Refuse it where the API cannot be bypassed.
  constraint workflow_actions_action_ck check (length(btrim(action)) > 0),
  -- A nameless entry in a library whose entire purpose is to be picked by name is not an entry.
  constraint workflow_actions_name_ck check (
    length(btrim(name_en)) > 0 and length(btrim(name_ar)) > 0
  ),
  -- THE COMPOSITE UNIQUE, for the reason workflow_flows_id_scope_uq exists in 0047: referential
  -- integrity triggers BYPASS RLS, so a plain single-column FK to this table would let a row in one
  -- workspace or environment be pinned by a row in another and the tenant policy would never get a
  -- say. Nothing points here today — the receipt is deliberately not a foreign key — but the target
  -- a scoped FK needs has to exist before the first one is written, because adding a unique later
  -- means a migration that can fail on live data.
  constraint workflow_actions_id_scope_uq unique (id, tenant_id, environment)
);--> statement-breakpoint

-- Two entries sharing a name is a library nobody can use: the picker lists names, the receipt
-- records a name, and "which one did I choose" stops having an answer. Folded and trimmed because
-- "Express shipping" and "express shipping " are the same mistake, not two entries.
create unique index if not exists workflow_actions_name_uq
  on workflow_actions (tenant_id, environment, lower(btrim(name_en)));--> statement-breakpoint

create index if not exists workflow_actions_tenant_idx
  on workflow_actions (tenant_id, environment);--> statement-breakpoint

SELECT public.apply_tenant_rls('workflow_actions');--> statement-breakpoint

comment on table workflow_actions is
  'Named, reusable action configurations for the workflow builder. Adding one to a transition '
  'COPIES it and stamps a receipt; the copy is what runs, so editing an entry never changes a flow '
  'that already uses it. See the header of migration 0060 for why it is a copy and not a pointer.';--> statement-breakpoint

-- ── the receipt, on the transition side ─────────────────────────────────────────────────────────
-- 0056 already requires every element of `actions` to carry an action key. A receipt is optional —
-- an action configured by hand has none — but a HALF receipt is worse than no receipt at all: the
-- usage count reads ref.id, so an element carrying only {"ref":{"name":"…"}} would show an entry's
-- name on the canvas while the library screen reported nobody using it. Two screens disagreeing
-- about the same fact is how a feature stops being believed.
alter table workflow_transitions
  drop constraint if exists workflow_transitions_actions_ref_shape,
  add  constraint workflow_transitions_actions_ref_shape check (
    jsonb_array_length(jsonb_path_query_array(actions, '$[*] ? (exists (@.ref))'))
    = jsonb_array_length(jsonb_path_query_array(actions, '$[*] ? (@.ref.id != null)'))
  );--> statement-breakpoint

comment on column workflow_transitions.actions is
  'What happens AFTER this move succeeds: [{action, params, ref?}] from the code-defined catalog in '
  'modules/workflow/actions.ts. `ref` is a receipt {id, name} left behind when the configuration '
  'was taken from the workflow_actions library — it is never followed at run time. FROZEN — what a '
  'move does is as much a rule as who may make it.';--> statement-breakpoint

-- WHAT THE USAGE COUNT COSTS. "how many flows carry a receipt for this entry" is asked for every
-- entry every time the builder loads, and it is a containment test over a jsonb column: without an
-- index that is a sequential scan of every transition in the database, once per entry. jsonb_path_ops
-- rather than the default operator class because it indexes whole paths instead of every key and
-- every value separately — roughly half the size, and it serves `@>`, which is the only operator
-- this column is ever searched with.
create index if not exists workflow_transitions_action_ref_idx
  on workflow_transitions using gin (actions jsonb_path_ops);--> statement-breakpoint

-- There is no change to public.workflow_child_freeze() in this migration and that is not an
-- omission. `actions` joined the freeze tuple in 0056, and a receipt lives INSIDE that column, so
-- stamping one onto an active flow's transition is already refused by the trigger that is there.
-- The library may be edited at any time; what it may not do is reach into a flow that is running.
comment on column workflow_actions.params is
  'The saved configuration, in the same shape a transition stores. Copied on use, never read at run '
  'time.';
