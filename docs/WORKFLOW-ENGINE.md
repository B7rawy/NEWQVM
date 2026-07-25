# The Workflow Engine

The newest subsystem in QVM (Jira epic **QNEW-64**). It lets each workspace draw its own order state machine on a canvas — or describe it in Arabic or English and have an LLM draw it — and then have the database and the API enforce that drawing on real orders.

This document explains the storage, the design choices behind it, the runtime guard, and what is honestly not built. Everything below was read from the files cited.

**Status at time of writing:** all four tables exist in the local development database (Docker `qvm_postgres`, migrations `0047`–`0049` applied) and all four are **empty** (0 rows), as is `status_logs`. Production was not inspected for this document. Treat behavioural claims as "verified in code and in `guard-check.sh`", not "verified against production data".

---

## 1. The problem it solves

Before this engine, a status column was just a column. Any service could set it to any value. The old system had one hard-coded lifecycle and every workspace had to bend to it.

Three separate gaps had to close in order:

1. **Status writes were scattered.** `apps/api/src/common/status.service.ts:9-12` records the state it replaced: 22 direct status writes across 8 services, and a fully-designed `status_logs` table with zero writers and zero rows. No record of who moved anything, when, or from what.
2. **There was nowhere to put a rule.** Even with logging, "new_rfq may only become confirmed after pricing" had no representation.
3. **Nobody owned a record.** Responsibility was implicit in the status. "What am I supposed to be doing" meant opening every list page and guessing.

The ordering was deliberate and is stated at `status.service.ts:18-20`:

> because all 22 former write sites were collapsed into this one function first, the workflow check exists in ONE place rather than 22. That ordering was the point — a rule engine bolted onto one of twenty paths enforces nothing.

---

## 2. The four tables

Schema: `apps/api/drizzle/schema/workflow.ts`. DDL: `apps/api/drizzle/migrations/0047_workflow_engine.sql`, extended by `0048_workflow_governance.sql` and `0049_workflow_custody.sql`.

| Table | One row is | Key columns |
|---|---|---|
| `workflow_flows` | one **version** of a named flow | `flow_key`, `version`, `status` (draft/active/retired), `is_default`, `status_domain`, `selection_condition`, `canvas` |
| `workflow_steps` | one **status placed in one flow**, with its canvas position | `item_status_id` \| `vendor_status_id`, `is_entry`, `is_terminal`, `sla_hours`, `pages`, `owner_roles`, `canvas_x/y` |
| `workflow_transitions` | one **permitted move** — the arrow | `from_step_id`, `to_step_id`, `condition`, `allowed_roles`, `requires_approval`, `priority`, `handoff` |
| `workflow_record_state` | which flow version **one live record** is executing, and who holds it | `entity_type`+`entity_id`, `flow_id`, `assignee_user_id`, `assignee_role`, `step_entered_at`, `due_at` |

`pages` / `owner_roles` were added by `0048`; `handoff` and the four `workflow_record_state` custody columns by `0049`. See §10 — five of those columns are not declared in the Drizzle schema file.

### Scoping

Flows belong to the **workspace** (`tenant_id`), never to an individual workshop (`workflow.ts:31-33`). Everything under a workspace follows that workspace's rules. Tenant RLS then isolates one workspace's flows from another's for free — no service needs a `where tenant_id =` on these tables.

Flows are also **per-environment**. A flow is drawn and tested in Sandbox and activated separately in Live (`workflow.controller.ts:15-16`, ADR-0012). Note there is no promote-to-live path; see §10.

### A step arranges a status, it does not own one

`workflow_steps` points at a row in `item_statuses` or `vendor_statuses` — the governed catalogue, seeded in `apps/api/drizzle/seed/reference-data.ts`. Two different flows may use the same status differently. The engine never invents vocabulary.

The status FK is **split into two columns** rather than one soft `status_id` (`workflow.ts:118-123`). A single soft column would accept a wrong-catalogue or deleted id indistinguishably, and the guard would then stall every record at the step before it — and after activation freezes the flow, repairing that means publishing a new version. A CHECK ties the pair to the declared domain:

```sql
-- 0047_workflow_engine.sql:191-194
CHECK ( num_nonnulls(item_status_id, vendor_status_id) = 1
        AND (status_domain = 'item') = (item_status_id IS NOT NULL) )
```

A second CHECK forbids a self-loop, because `StatusService` treats X→X as a no-op and such a rule could never fire (`0047:200-201`).

### Composite foreign keys — a first in this repo

Children pin to their parent on more than `flow_id` (`workflow.ts:154-165`, `0047:113-165`):

| Child | Pins on |
|---|---|
| `workflow_steps` | `(flow_id, tenant_id, environment, status_domain)` |
| `workflow_record_state` | `(flow_id, tenant_id, environment, status_domain)` |
| `workflow_transitions` | `(flow_id, tenant_id, environment)` — the table has no `status_domain` column, so the domain is pinned transitively through its two step FKs |

The reasoning at `workflow.ts:41-44` is worth internalising:

> RI triggers bypass RLS, and the only actor managing flows is internal, so the tenant policy constrains nothing on this path.

In other words: on every other table, RLS is the tenancy boundary. On this path it is not, because referential-integrity checks run with policies disabled and the only caller is already internal. So the scope is pinned structurally instead. `workflow_steps` also carries `unique (id, flow_id)`, which is what lets a transition's edge FKs guarantee an arrow can never join two different flows.

### Partial unique indexes carry the versioning logic

| Index | Predicate | Why |
|---|---|---|
| `workflow_flows_active_uq` on `(tenant_id, environment, flow_key)` | `where status = 'active'` | Activation is two writes (retire v1, activate v2); a crash between them would otherwise leave routing to pick nondeterministically |
| `workflow_flows_default_uq` on `(tenant_id, environment, status_domain)` | `where is_default and status = 'active'` | The `status = 'active'` clause is load-bearing — without it a **draft** v2 of the default collides with the live v1 and versioning becomes impossible (`workflow.ts:91-92`) |
| `workflow_steps_entry_uq` on `(flow_id)` | `where is_entry` | Zero entries wedges every new record; two makes the start nondeterministic |

### Details that read as trivia but are not

- **`canvas_x` / `canvas_y` are `double precision`, not `numeric`** (`workflow.ts:147-148`). Drizzle returns `numeric` as a *string*, so the first drag would compute `"120.00" + 5 = "120.005"`, the node would teleport, and that value would be saved.
- **`workflow_record_state.status_domain` has no default** (`workflow.ts:257-258`). Defaulting to `'item'` would silently mis-bind `rfq_vendor` — the one vendor-domain entity — to a flow speaking the wrong vocabulary, after which nothing resolves.
- **`workflow_record_state`'s FK to the flow has no `ON DELETE`** (`workflow.ts:267`, `0047:114`). An in-flight record must *block* deletion of the flow version it is executing.
- **The workflow tables carry the repo's only cascading FKs** — no other file under `apps/api/drizzle/schema/` uses `onDelete` at all. `workflow_transitions`' two edge FKs cascade from `workflow_steps`, which is why `workflow_transitions_from_step_idx` / `_to_step_idx` exist: without a covering index each step delete is a sequential scan.
- All four tables use the `audit` column block, not `timestamps` (`workflow.ts:261-263`). `apply_tenant_rls` attaches `trg_set_row_audit` unconditionally and `set_row_audit()` writes `created_by`; a table without those columns dies on first insert with `record new has no field created_by`.

### `selection_condition` has three meaningful states

`NULL` = never auto-selected (routing not decided; the default). `{}` = matches every record. `{…}` = matches records satisfying it (`workflow.ts:72-77`). Without the NULL state, a half-finished flow is born matching everything and quietly captures every new record ahead of the intended one. A CHECK stops such a flow going live:

```sql
-- 0047:196-198
CHECK ( status <> 'active' OR is_default OR selection_condition IS NOT NULL )
```

**Caveat, verified:** `selection_condition` is stored, validated at activation, and returned to the UI — but **never evaluated at runtime**. See §10.

---

## 3. The graph is one document keyed by status CODE

This is the single design choice the whole feature rests on. Stated at `workflow.service.ts:13-18`:

> THE GRAPH IS ONE DOCUMENT, KEYED BY STATUS CODE — not by uuid. That single choice is what makes "draw it myself / let the AI draw it / do half each" one feature:
> - the canvas sends the whole graph on save,
> - the AI assistant returns exactly the same shape,
> - the server resolves codes → ids, validates, and replaces the graph atomically.
> A uuid-keyed API would force the model to invent identifiers it cannot know.

Concretely, one shape flows through three consumers:

```
{ steps:       [{ status: "new_rfq", isEntry: true, x: 80, y: 100,
                  ownerRoles: [], pages: [], slaHours: null }, …],
  transitions: [{ from: "new_rfq", to: "priced", labelEn: "Quote",
                  handoff: "pool", allowedRoles: [], requiresApproval: false }, …] }
```

- `PUT /admin/workflows/:id/graph` accepts it (`saveGraphSchema`, `workflow.service.ts:77-85`).
- `GET /admin/workflows/:id` returns it, resolving ids back to codes in SQL (`workflow.service.ts:256-280`).
- `POST /admin/workflows/:id/assist` returns it, parsed through the **same** zod schema (`workflow.service.ts:666`).
- `WorkflowCanvas.tsx` holds it as one React state object (`Graph`, line 38 — `{ steps, edges }` in the client's naming), which is also what makes undo exact: every edit is a whole-object snapshot (`WorkflowCanvas.tsx:17`, `commit()` at `:129-140`).

**Save is a full replace** (`workflow.service.ts:326-353`): delete transitions, delete steps, re-insert both. Idempotent by construction, because the incoming document *is* the desired state. Codes are resolved to ids once, up front, and the whole document is rejected if any code is unknown (`resolveStatusCodes`, `:703-718`) — "a partially-valid graph saved is worse than one rejected with a clear list."

Because deleting and reinserting children is the natural save, the freeze triggers had to exist. Without them, that save would silently rewrite the rules that in-flight orders are being judged by (`0047:12-14`).

---

## 4. Versioning: drafts are clay, active flows are stone

| Flow status | Editable? | Deletable? |
|---|---|---|
| `draft` | yes, freely | yes |
| `active` | no — only tunable columns (§5), and no API exposes them | no, retire it |
| `retired` | no | no |

The lifecycle is `draft → active → retired`, one-way. `activate()` (`workflow.service.ts:368-392`) retires the predecessor **first**, because the partial unique index permitting one active version is not deferrable and the other order fails.

`newVersion()` (`:409-471`) is the supported way to change an active flow: clone the whole graph into a fresh draft with step ids remapped. `is_default` is deliberately forced to `false` on the clone (`:423-424`) — two active defaults is exactly what the partial index exists to prevent, and `activate()` hands the flag over instead.

### Records bind to a version and stay there

`workflow_record_state` is the mechanism. When a record first moves, the guard writes a row pinning it to the flow it was executing, and the upsert at the end of the guard deliberately does **not** update `flow_id`:

```
-- status.service.ts:298-300
ON CONFLICT DO UPDATE, not DO NOTHING: the row is now living state that must follow the
record, not a write-once pin. flow_id is deliberately NOT updated — a record stays bound to
the version it entered, which is the guarantee that publishing a new version cannot strand it.
```

So an order that entered v1 finishes on v1 after v2 goes live, even if v2 deleted the step it is sitting on. The canvas says the same thing to the user, in the frozen banner (`WorkflowCanvas.tsx:561-567`).

**Precision worth having:** binding happens at the record's **first status move**, not at creation. RFQ creation inserts `status_id` directly (`rfq.service.ts:86`) and never touches `workflow_record_state`. A record created under v1 and first moved after v2 activated binds to v2.

### The freeze is enforced by database triggers, not by convention

Two `plpgsql` functions, both `SET search_path = ''`.

**`workflow_flow_freeze()`** — `BEFORE UPDATE OR DELETE ON workflow_flows` (`0047:244-277`):
- only a draft may be deleted;
- status moves forward only (`draft → active|retired`, `active → retired`);
- once past draft, `flow_key`, `version`, `environment`, `status_domain`, `selection_condition` are immutable.

**`workflow_child_freeze()`** — `BEFORE INSERT OR UPDATE OR DELETE ON workflow_steps` and `workflow_transitions` (`0047:204-242`, redefined by `0048:45-83` and `0049:60-100`):
- if the parent flow is not a draft, **INSERT and DELETE are rejected outright**;
- UPDATE is rejected only if it touches the frozen tuple;
- it returns early when the parent flow is missing (`v_status IS NULL`), because a CASCADE delete of a draft flow removes children after the parent.

The application-level checks in `saveGraph`, `remove` and `assist` are for good error messages, not for safety (`workflow.service.ts:20-21`).

---

## 5. FROZEN vs TUNABLE — the classification rule

`0048_workflow_governance.sql:9-16` states the rule for every future column on these tables:

> **SEMANTICS ARE FROZEN, VIEW AND TIMING ARE TUNABLE.**
> An active flow version is immutable because in-flight records are bound to it; changing a rule underneath them would rewrite history. But routing is not a rule — it decides which list a record shows up in. If an admin routes a status to the wrong page, live work goes missing from a queue, and forcing them to publish a whole new version to fix a typo would be the wrong trade.

The freeze tuples as they stand after `0049`:

| Table | Frozen (in the tuple) | Tunable (deliberately absent) |
|---|---|---|
| `workflow_steps` | `item_status_id`, `vendor_status_id`, `status_domain`, `is_entry`, `is_terminal`, `owner_roles` | `pages`, `sla_hours`, `sort_order`, `canvas_x/y` |
| `workflow_transitions` | `from_step_id`, `to_step_id`, `condition`, `requires_approval`, `allowed_roles`, `priority`, `handoff` | `label_en`, `label_ar` |

`owner_roles` is frozen because it governs **who may act**. `pages` is tunable because it governs **where they look**. `handoff` was classified frozen for the same reason as `owner_roles` — it is a rule about who becomes responsible (`0049:25-26`).

### This is the subsystem's sharpest maintenance hazard, and the migrations say so

`workflow_child_freeze()` is a **hard-coded tuple of column names**. `0048:41-44`:

> A new semantic column that is not listed here is silently editable on an ACTIVE flow, which would let someone rewrite the rules under orders already executing them — the exact failure this feature exists to prevent. Any future column must be classified into one of the two lists above at the moment it is added.

`apps/api/scripts/guard-check.sh:94-97` asserts the classification directly against `pg_proc.prosrc`, rather than trusting it:

```bash
ok t "…prosrc like '%owner_roles%'…"  "the freeze trigger governs owner_roles (semantics are frozen)"
ok f "…prosrc like '%NEW.pages%'…"    "but NOT pages — a mis-routed status stays fixable without republishing"
```

`guard-check.sh:225-226` asserts the same for `handoff`.

**Honest note:** the DB permits editing `pages` on an active flow, but **the API does not expose any way to do it**. `saveGraph` refuses any flow whose status is not `draft` (`workflow.service.ts:317-320`), and it is the only writer of that column. The canvas keeps the "Shows on" chips enabled on a frozen flow (`WorkflowCanvas.tsx:872`, `disabled={frozen && false}` with a comment citing 0048) but hides the Save button entirely when frozen (`:537`). The intent is implemented at the database layer and unimplemented above it.

---

## 6. Governance

### `workflow_steps.owner_roles` — who is responsible while a record sits here

A jsonb array of `membership_role` codes. `[]` means "no opinion" — grants nobody, restricts nobody. `0048:18-20` calls this **permissive until configured**: a workspace that never opens the workflow screen sees no behaviour change at all.

### `workflow_transitions.allowed_roles` — who may fire this one arrow

Also a jsonb array, also empty-means-silence. The two gates are **independent and both must pass** (`status.service.ts:238-243`):

> Both must be satisfied, which is what lets an admin say "this desk belongs to purchasing" once on the step, and still single out one arrow for a manager.

### `handoff` — custody after the move

Three modes, `CHECK (handoff in ('pool','keep','actor'))`, default `'pool'` (`0049:34-38`). This is *runtime* state, which is why the resulting assignment lands on `workflow_record_state` and not on the flow: "the flow says what SHOULD happen on a move; these columns record what DID" (`0049:8-9`).

| Mode | Effect | Right for |
|---|---|---|
| `pool` (default) | release the record to the destination step's `owner_roles`; `assignee_user_id` = null | a real handover between teams — a move usually means the work has left your desk |
| `keep` | the current holder carries over | one person doing several steps in a row |
| `actor` | whoever made the move takes it | picking something up *is* taking it on |

One refinement (`status.service.ts:285-292`): a pooled record whose destination step has exactly **one** possible holder is auto-assigned to them. "Leaving it 'unclaimed' when there is only one candidate is busywork, not governance."

A consequence worth knowing: in `pool` mode the code only sets `assignee_role` when the destination step *has* `owner_roles` (`status.service.ts:285`). A pooled record landing on a step with no owners gets neither an assignee nor a role, and `myWork`'s pool query matches on `assignee_role`, so that record appears in nobody's queue. Permissive-until-configured applies here too — it is the pre-engine behaviour, not a lost record.

`guard-check.sh:215-217` exercises all three modes end to end.

### SLA and `due_at`

`workflow_steps.sla_hours` on the destination step is turned into an absolute `due_at` at move time (`status.service.ts:294-296`). Stored rather than computed on read, so "overdue" is one indexed comparison instead of a join per row (`0049:17-18`). Three partial indexes back the two queries the feature exists to serve — mine, pool, overdue (`0049:42-50`).

### Status → page routing, and its SAFETY RULE

`workflow_steps.pages` holds page **keys**, never URLs — "routes move, keys must not" (`pages.ts:20`). The catalogue is a hard-coded list of seven (`pages.ts:32-47`), each carrying `entities`, `personas`, and a deliberately honest `wired` flag. Exactly one entry is `wired: false`: `{ key: "internal", path: "/internal" }`, because that screen is a mock — `apps/web/src/pages/InternalDashboard.tsx` is 1,376 lines of hard-coded arrays (`const ORDERS: Order[] = [...]` at `:114`) with no API call. `pages.ts:9-12`:

> routing a live status to one of them would make real work disappear from the queue people actually watch.

The predicate lives in `apps/api/src/modules/workflow/routing.ts`. The rule, verbatim from `:9-10`:

> **A status that the flow routes NOWHERE appears on EVERY page, exactly as it does today. Only a status deliberately routed somewhere is filtered out of the pages it was not routed to.**

The failure it prevents (`:12-15`): without it, the first time an admin routed a *single* status, every **other** status would silently vanish from every queue — a half-configured flow would hide live work, and it would surface as a customer phone call rather than an error.

The SQL is therefore three-part rather than a simple containment test (`routing.ts:43`):

```sql
(status is null OR status NOT IN (routed anywhere) OR status IN (routed here))
```

Two further safety properties:
- it reads only `status = 'active'` flows, so a draft being edited never changes what anyone sees;
- callers pass `undefined` to opt out, which yields `sql\`true\`` — byte-identical to the pre-routing query.

`guard-check.sh:163-194` asserts the safety rule specifically.

---

## 7. The guard — `StatusService.assertTransitionAllowed`

`apps/api/src/common/status.service.ts:170-313`. It runs inside `transitionMany`, **after** reading the current values and **before** the UPDATE (`:131`), so a rejection rolls back the whole caller transaction.

### Permissive until configured

`status.service.ts:161-165`:

> Deliberately PERMISSIVE UNTIL CONFIGURED. Every record that exists today predates the engine and is bound to no flow, and there is no active flow until an admin activates one — so if either is missing this returns silently and the system behaves exactly as it did before. Enforcement switches on for a workspace the moment it activates a flow, and only for records that entered under it. **Rolling this out any other way would freeze live orders the day it shipped.**

The implementation of that is one line: `if (!flowId) continue;` (`:195`). `guard-check.sh:64-65` asserts it as check #1.

### The algorithm, per moving record

1. **Find the flow** (`:181-194`): the record's bound `flow_id`, else today's `is_default` active flow for this tenant + environment + status domain. Neither → allow.
2. **Load the steps** (`:197-201`). If the record's *current* status is not a step in this flow, it is not really executing it, so the move cannot be judged → allow (`:209`). If it *is* on the flow but the destination is not a step → 400 naming both codes (`:210-220`). `:205-208` explains the asymmetry: "otherwise 'the workflow says new_rfq → confirmed' is advice, not a rule."
3. **Find the edge** (`:222-236`). No `workflow_transitions` row for that `(from, to)` pair → 400, with a message telling the admin to draw the transition.
4. **Two role gates** (`:238-261`). `fromStep.owner_roles` and `edge.allowed_roles`; empty is silence; both must pass.
5. **Custody** (`:263-293`) and **SLA** (`:294-296`), per §6.
6. **Upsert `workflow_record_state`** (`:301-311`).

### Roles are re-read from the database, not taken from the request

`effectiveRoles()` (`:59-68`) unions `tenant_memberships` and `platform_members` on every check. The reason (`:50-54`):

> The AuthGuard picks ONE role for the request (a `limit 1` with no ordering), which is fine for coarse route guards but wrong here — a user who is both a branch_manager and an account_manager must satisfy a rule naming either, and which one the guard happened to pick must not decide it.

Same principle as `changed_by`: a caller-supplied role is a caller-controlled role.

### `super_admin` break-glass

`status.service.ts:248-250`:

> break-glass: a workspace that has restricted a step to a role nobody holds still needs a way out, and refusing the platform owner would make that unrecoverable without SQL.

If the effective role set contains `super_admin`, both role gates are skipped entirely. It does **not** skip the graph checks — an undrawn transition is still refused for a super admin. The escape is about permissions, not about the shape of the flow.

Note `effectiveRoles` unions `platform_members`, and `platform_role` includes `super_admin` (`enums.ts:31`), so a platform super admin gets this everywhere. `assertActivatable`'s complementary check is the preventative half: it refuses to activate a flow whose steps are owned by roles nobody holds (§9), so the break-glass is a last resort rather than a routine path.

### Cost

The guard runs **per record**, and each iteration issues 4–6 queries (bound flow, steps, edge, upsert — plus the role union and the custody lookup when they apply). `transitionMany` batches the UPDATE; it does not batch the guard or the `status_logs` insert (`:141-147`), both of which are per-row loops. Fine at current volumes; it is the obvious first thing to profile.

---

## 8. Authoring API and the canvas

`apps/api/src/modules/workflow/workflow.controller.ts` — `@Controller("admin/workflows")`, `@UseGuards(AuthGuard, RolesGuard)`, `@PlatformOnly()` at class level. Writes additionally require `platformRole === "super_admin"`, checked per method in the service (`workflow.service.ts:96-99`). Same split as `/admin/platform`: platform staff may look, only a super admin may change.

| Route | Notes |
|---|---|
| `GET /catalog` | The governed vocabulary the canvas and the AI may reference: active item + vendor statuses, `enum_range(membership_role)`, `ROUTABLE_PAGES`, and a **holders count per role** in this workspace (`:111-132`) |
| `GET /` , `GET /:id` | Scoped to tenant **and** environment |
| `GET /my-work` | Declared **before** `@Get(":id")` so the literal wins routing (`controller:48-49`) |
| `POST /records/:entity/:id/claim` | Claim or hand over |
| `POST /` | Empty draft; `version = max(version)+1` per `flow_key` |
| `PUT /:id/graph` | Full replace, draft only |
| `POST /:id/assist` | AI proposal, persists nothing |
| `POST /:id/activate`, `/retire`, `/new-version`, `DELETE /:id` | Lifecycle |

### `my-work` and `claim`

`myWork` (`workflow.service.ts:145-188`) splits `mine` (claimed by or handed to you) from `pool` (unclaimed work your roles may pick up) and counts `overdue`. Kept separate deliberately: "'yours' and 'available' are different prompts" (`:143`). It reads only `workflow_record_state`, so an unconfigured workspace gets an empty result rather than a wrong one.

`claim` (`:196-225`) **deliberately does not move the status** (`:193-195`): "claiming is about responsibility, not progress, and conflating the two would mean you could not pick something up without also advancing it." It refuses to hand a record to someone who does not hold the step's role, since that would strand it where nobody looks.

### The canvas

`apps/web/src/pages/admin/WorkflowCanvas.tsx` (1,103 lines). Hand-built on SVG rather than a graph library; the file header (`:13`) cites the repo's bundle discipline — note that `docs/CONVENTIONS.md`'s frontend section states that as lazy-route-per-page after an old 3 MB chunk, and does not literally name graph libraries. Two things are done properly rather than approximated (`:13-17`):

- **One view transform `{x, y, k}`** applied to the world, so pan and zoom are continuous. `zoomAt` (`:223-233`) anchors the world point under the cursor so wheel-zoom does not lurch toward a corner.
- **History over the whole graph object.** `commit()` (`:129-140`) snapshots; a `coalesceKey` collapses consecutive edits to the same text field into one undo entry, which used to blow the 100-entry cap and evict structural edits from the bottom.

The inspector surfaces the governance directly and warns where it can hurt: role chips show live holder counts and mark a role with zero holders (`:848-866`); page chips mark unwired screens with the hint "this screen is not built yet" (`:876-887`). `save()` only clears the dirty flag if the graph did not change while the request was in flight (`:486-489`).

---

## 9. The AI assistant, and the three guards that keep it honest

`workflow.service.ts:499-697`. The controller route is `POST /admin/workflows/:id/assist`. It is a **conversation**: `assistSchema` takes the whole message history plus the current canvas graph, so the model can ask "who approves that?" and use the answer, and so "add a step after pricing" has something to add to (`:66-75`).

`AiService` (`apps/api/src/common/ai.service.ts`) is the single model boundary. Gemini only; `enabled` returns false for anything else (`:18-22`), and `json()` throws a 503 naming `AI_PROVIDER` / `GEMINI_API_KEY` when unconfigured (`:60-64`). The model is only ever asked for structured output against a schema and never writes to the database.

The three guards, in order (`workflow.service.ts:492-497`), "because a plausible-looking wrong flow is the expensive failure here":

1. **The model is handed only the governed catalogue.** The system prompt (`:530-593`) enumerates the active status codes for *this flow's* domain, the roles with their live holder counts, and the page keys — appending `(NOT BUILT YET — avoid)` to any page whose `wired` is false (`:592`).
2. **Every code it returns is checked against that catalogue** and the whole reply rejected if any is invented (`:670-675`). It cannot conjure `manager_review` and have it quietly saved.
3. **The same `saveGraphSchema` zod parse and `validateGraph` the human save path uses** run before the reply is returned (`:666`, `:688`). "The model gets no looser contract."

And then: **nothing is persisted** (`:689`). The canvas renders the proposal and a human presses Save.

There is exactly one forgiving fixup (`:677-686`): duplicate `(from, to)` pairs get incrementing priorities rather than the whole reply being thrown away. The comment names the trade — "being forgiving of the model and strict about the RESULT is the right split — the human reviews it on the canvas either way."

Two prompt rules are worth calling out because they encode operational knowledge, not style:

- **Rule 9** (`:571-572`) — never name a role shown as "0 people": "every record would stall there with nobody able to move it."
- **Rule 7** (`:559-565`) — wrap the layout at 5 steps per row, because a single long row forces the canvas to zoom out until labels are unreadable.

The model is also explicitly instructed to **set `drawGraph=false`** for greetings, vague requests, questions, and genuine ambiguity — "Never invent an answer to something you should ask about. Never draw a whole flow off a greeting" (`:536-543`).

### Activation is stricter than saving

`assertActivatable` (`:758-823`) — "a draft may be half-drawn, but a LIVE flow that can wedge a record is the failure mode this whole design exists to prevent." It refuses:

| Check | Why |
|---|---|
| no steps | nothing to run |
| no entry step | new records would have nowhere to start. (*Two* entry steps are stopped earlier — `validateGraph:729-731` requires exactly one, and `workflow_steps_entry_uq` makes it impossible to store two) |
| no terminal step | records could never finish |
| not default **and** `selection_condition IS NULL` | "routing is not set" |
| a non-terminal step with no outgoing transition | records would stall there |
| a step unreachable from the entry step (BFS, `:790-801`) | dead weight the canvas will happily draw |
| a non-terminal step whose `owner_roles` include a role **nobody in the workspace holds** (`:804-822`) | "Activation is the last cheap moment to say so; after it, real orders stall." |

---

## 10. What is NOT built

Verified by reading the code and by grep across `apps/api/src` and `apps/web/src`.

### Approval chains — designed into the schema, enforced nowhere

`workflow_transitions.requires_approval` is stored, is in the freeze tuple, is drawn on the canvas as a padlock (`WorkflowCanvas.tsx:689`), is editable in the inspector (`:910-911`), and is described to the user as "The order waits here until someone approves" (`:914`).

**Nothing reads it.** `assertTransitionAllowed` selects only `allowed_roles, handoff` from the edge (`status.service.ts:222-225`). A transition marked `requiresApproval: true` executes immediately, exactly like any other.

There is a separate `approvals` module (`approval_policies`, `approval_levels`, `approval_requests`, `approval_actions` in `apps/api/drizzle/schema/approvals.ts`) reached at `/api/approvals`. Grep for `workflow` inside `apps/api/src/modules/approvals/` returns nothing — the two subsystems have no connection. The schema comment at `workflow.ts:195` states the intent ("Gate this move behind the approvals engine (QNEW-53)") in the future tense, correctly.

### Auto-transitions — no scheduler exists

There is no timer, no queue worker, no cron. Grep for `@Cron`, `setInterval`, `ScheduleModule`, `node-cron` across `apps/api/src` returns zero hits, and `@nestjs/schedule` is not a dependency. Every transition is driven by a human hitting an endpoint. A flow cannot say "after 24 hours in `tendering`, move to `unavailable`".

### Escalation — not built

`due_at` is computed and stored, `myWork` counts overdue rows, and `MyWork.tsx:55` renders them with a red tint. That is the entirety of SLA handling. Nothing notifies, reassigns, or escalates when `due_at` passes. (And `NotificationsService` would not deliver it anyway — `notifications.service.ts:60-63` logs `SEND …` with the comment "real provider dispatch goes here"; see the architecture document.)

### Conditions and priority are stored, never evaluated

`workflow_transitions.condition` is described at `workflow.ts:199` as "The IF part: field / operator / reference, AND-OR composed", and `priority` at `:201-205` as the mechanism for "Confirmed → Purchased goes straight through under 5,000, needs the finance manager above it".

Neither is implemented. The guard's edge lookup is `… where flow_id = … and from_step_id = … and to_step_id = … limit 1` — no `order by priority`, no condition evaluation. There is also no UI for authoring a condition: the canvas inspector has no field for it, and the save payload (`WorkflowCanvas.tsx:474-485`) never sends one, so `condition` is always the `{}` default.

### `selection_condition` is never evaluated — there is effectively one flow per workspace

The guard resolves the applicable flow with `… and status = 'active' and is_default limit 1` (`status.service.ts:181-185`). A non-default flow with a selection condition can be created, saved and activated, and will never be selected for any record. Multi-flow routing is schema-and-validation only.

### A flow created through the UI cannot be activated

`Workflows.tsx:72` posts only `{ flowKey, nameEn, nameAr }` — no `isDefault`. `WorkflowCanvas.tsx:474-485` sends the graph but no `selectionCondition`. So a UI-created flow has `is_default = false` and `selection_condition = null`, and `assertActivatable` refuses it with *"routing is not set: give it a selection condition, or make it the default flow"* — with no way to satisfy either condition from any screen. `guard-check.sh:68-74` gets around this by posting `"isDefault":true` and `"selectionCondition":{}` directly to the API.

### "My work" is unreachable for the people custody assigns work to

`WorkflowController` carries `@PlatformOnly()` at class level, so `GET /my-work` and `POST /records/:e/:id/claim` are platform-staff-only. The `/my-work` route is registered for every persona (`App.tsx:122`) but the nav link appears only in `platformNav` and `platformSystemNav` (`nav.tsx:57`, `:110`) — and a non-platform user who reached the page anyway would get a rejected API call.

But custody assigns to `tenant_memberships` roles — `company_admin`, `branch_manager`, `service_advisor` — and `guard-check.sh:215` proves a pooled record lands on a workspace manager. Those users have neither the link nor API access to see it. The personal-queue payoff currently reaches only Qparts staff.

### Routing reaches two of the seven pages

`queuePredicate` is called in exactly two places: `rfq.service.ts:117` and `orders.service.ts:126`, both opt-in via `?queue=`. `Rfqs.tsx:35` uses `?queue=rfqs`; `Orders.tsx:24` uses `?queue=orders`.

The other five page keys — `workshop_requests`, `workshop_orders`, `vendor_quotations`, `vendor_confirmed`, `internal` — are offered in the builder, are accepted by `validateGraph`, are saved to `workflow_steps.pages`, and are **ignored**. No portal endpoint calls `queuePredicate`. An admin routing a status to a vendor screen gets no error and no effect.

### `pages.ts` promises two things it does not do

Its header (`pages.ts:11-16`) says "activation warns about them" for unwired screens, and that `personas` "drives ordering in the picker and lets the activation check ask the useful question". Neither exists: `assertActivatable` never looks at `pages`, and `personas` / `entities` are read by nothing — they are returned in the catalog payload and typed in the canvas (`WorkflowCanvas.tsx:35`) but never used. The unwired warning is a canvas-only hint (`:876-887`). `pageByKey` is imported by `workflow.service.ts:7` and never called.

### `allowed_roles` is never validated against the role enum

`validateGraph` (`:722-752`) checks structure — duplicate steps, exactly one entry, both endpoints of every transition existing, no self-loop, no two transitions sharing a `(from, to, priority)` — and then page keys against `isPageKey`. It never validates role strings, and zod accepts any `string().max(40)` for `ownerRoles` and `allowedRoles`. A typo in `owner_roles` is caught indirectly at activation (any nonexistent role has zero holders → refused, unless the step is terminal). A typo in a transition's `allowedRoles` is caught by nothing, and at runtime silently blocks everyone except a `super_admin`.

### Holder counts read only `tenant_memberships`

`catalog` (`:119-123`), the assist prompt (`:517-521`), the auto-assign lookup (`status.service.ts:287-291`) and `assertActivatable`'s holder map (`:806-813`) all count `tenant_memberships` alone. `effectiveRoles` at runtime unions `platform_members`. A step owned by a role held only by platform staff will therefore be reported as having 0 holders and refused at activation, even though those users could in fact act on it.

### Schema drift: the Drizzle schema, the snapshot and the database all disagree

Verified against the running Postgres container and `apps/api/drizzle/migrations/meta/0047_snapshot.json` (the newest snapshot — `0048` and `0049` were hand-written SQL and produced none).

| Columns | In DB | In `workflow.ts` | In snapshot |
|---|---|---|---|
| `workflow_steps.pages`, `.owner_roles` | yes | yes | **no** |
| `workflow_record_state.assignee_user_id`, `.assignee_role`, `.step_entered_at`, `.due_at`; `workflow_transitions.handoff` | yes | **no** | **no** |

Two distinct consequences:

- The five `0049` columns are invisible to Drizzle. They are read and written only through raw SQL (`status.service.ts:271-311`, `workflow.service.ts:158-221`, `:271`, `:348-467`) and get no types. Because they are absent from *both* the `.ts` and the snapshot, `drizzle-kit generate` will not emit a `DROP COLUMN` for them — but any tool that diffs against the live database (`drizzle-kit push`, `db:studio`) will treat them as unknown.
- `pages` and `owner_roles` are in the `.ts` but not the snapshot, so the next `pnpm db:generate` will emit `ADD COLUMN` statements for columns that already exist. That migration will fail on apply unless it is hand-edited — the same trap `0047:99-100` documents for the `0046` columns.

**Reconcile the schema file and regenerate a snapshot before anyone runs `db:generate`.**

### `status.service.ts` `history()` only resolves item-domain codes

The joins at `:332-333` are conditioned on `l.status_domain = 'item'`. A `vendor`-domain row comes back with null `from_code` / `to_code`.

### `myWork` resolves only four entity types

The joins at `workflow.service.ts:167-176` cover `rfq`, `order`, `rfq_item`, `order_item`. The other six entities the status gateway can track (`rfq_vendor`, `purchase_order`, `delivery`, `return`, `invoice`, `credit_note` — see `ENTITIES` at `status.service.ts:24-35`) appear with `reference: null` and `status: null`.

### One service still bypasses the gateway entirely

`apps/api/src/modules/insurance/insurance.service.ts:100` does a raw `update rfqs set status_id = …`. It has its own hand-written state machine, but the move produces no `status_logs` row and is not checked against the workflow. Insurance status changes are invisible to My Work, to time-in-status, and to the guard.

### No ADR

`docs/decisions/` contains `0001`–`0010` and `0012`. There is no ADR for the workflow engine; the design rationale lives entirely in file headers and migration headers. (Separately, `ADR-0011` is cited by `apps/api/drizzle/schema/org.ts:11`, `apps/api/src/modules/rfq/rfq.service.ts:43` and `apps/api/drizzle/seed/index.ts:148,158`, and does not exist.)

### There is no promote-to-live path

Flows are per-environment, and `newVersion` clones within `envOf(ctx)` (`:428`). A flow built and tested in Sandbox must be rebuilt by hand in Live. `Workflows.tsx:121-126` says so to the user: "Build and test here, then recreate it in Live once you are happy with it."

---

## 11. Reading order

1. `apps/api/drizzle/schema/workflow.ts` — the four tables and most of the reasoning.
2. `apps/api/drizzle/migrations/0047_workflow_engine.sql` → `0048` → `0049` — the constraints and triggers, in the order they were argued out.
3. `apps/api/src/common/status.service.ts` — the single write path, then the guard at `:170`.
4. `apps/api/src/modules/workflow/workflow.service.ts` — authoring, `assist` at `:499`, `assertActivatable` at `:758`.
5. `apps/api/src/modules/workflow/routing.ts` and `pages.ts` — routing and the safety rule.
6. `apps/web/src/pages/admin/WorkflowCanvas.tsx` — the one-document shape as the client sees it.
7. `apps/api/scripts/guard-check.sh` — the executable spec. Run it against a freshly seeded local stack; it is the fastest way to see the engine actually bite.
