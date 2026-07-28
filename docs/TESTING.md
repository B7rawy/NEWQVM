# Testing

How QVM is tested, what each suite covers, and the two traps that have already bitten this project once each.

Everything below was read from the files cited. `verify-rls.ts` was executed against the local stack; the assertion counts were taken from source, not from a suite run (running `smoke.sh` truncates and reseeds the local database, so it is not something to do casually while writing docs).

---

## 1. There is no unit-test framework, and that is a deliberate choice

There is no jest, no vitest, no mocha, no `*.spec.ts`, no `*.test.ts`, and no `.github/` directory anywhere in the repo. Verified:

```
find . -name '*.spec.ts' -o -name '*.test.ts'   →  (nothing)
grep -rl 'jest|vitest|mocha' --include=package.json  →  (nothing)
ls -a .github                                    →  no such directory
```

The reason is structural. In this codebase the load-bearing logic is not in TypeScript functions — it is in three places a mocked unit test cannot reach:

| Where the rule lives | Example | What a mocked test would prove |
|---|---|---|
| Postgres RLS policies | `tenant_isolation`, `environment_isolation` (restrictive) | nothing — a mock has no policy engine |
| Postgres triggers and constraints | `trg_set_row_audit`, `workflow_child_freeze`, `workflow_steps_entry_uq` | nothing — a mock has no trigger |
| The HTTP guard chain | `AuthGuard` → `RolesGuard` → zod parse → `DbService.withContext` | that a service method works when handed a context that the guard chain might never produce |

`apps/api/src/modules/rfq/rfq.service.ts` mostly does not filter by `tenant_id` at all — RLS supplies it. (The file mentions `tenantId` three times in 157 lines, and none of them is a read predicate: one passes it to `next_order_number()`, two stamp it on inserts.) A unit test with a stubbed database would pass while proving the opposite of what matters. So the suites are integration suites: real HTTP against a real Nest process, real `psql` against the real container, asserting on both the API response and the resulting rows.

**The honest cost of that choice.** Pure functions get no coverage — `cleanPartNumber` (`apps/api/src/modules/parts/parts.service.ts:12`) is the system's part-number normaliser and has no test. (Its docstring claims it is "used everywhere a part number is entered"; grep finds only two callers, `parts.controller.ts` and `vendor-selfservice.service.ts`, so the docstring is aspirational — that is a separate gap, not a testing one.) There are no frontend tests of any kind. There is no CI: the root `lint` script (`pnpm --recursive lint`) resolves to nothing, because no package — `apps/api`, `apps/web`, `packages/shared` — defines a `lint` script. The suites only run when a human runs them, or when `deploy.sh` runs the production variant.

---

## 2. The four suites

| Script | Path | Assertions (source count) | Target | Writes to the DB? | Run by |
|---|---|---|---|---|---|
| `smoke.sh` | `apps/api/scripts/smoke.sh` | 85 of its own, plus the 22 it folds in from `guard-check.sh` = **107** | local only | yes, heavily | `pnpm --filter @qvm/api test:smoke` |
| `guard-check.sh` | `apps/api/scripts/guard-check.sh` | **22** | local only | yes — it disables triggers | called by `smoke.sh:306` |
| `smoke-prod.sh` | `apps/api/scripts/smoke-prod.sh` | **24** | production | deliberately not | `deploy.sh` step 8/8, or `pnpm --filter @qvm/api test:smoke:prod` |
| `verify-rls.ts` | `apps/api/scripts/verify-rls.ts` | invariant scan over every table | any | read-only | `pnpm --filter @qvm/api db:verify`, and `deploy.sh` step 4/8 |

`smoke.sh:2` still says "88 checks". That number is stale — the file now contains 85 assertions of its own before `guard-check.sh` is folded in. Treat the header as prose, not a count.

---

## 3. `smoke.sh` — the local regression suite

Requires a **freshly seeded** local stack: the API listening on `$SMOKE_BASE` (default `http://localhost:4000`) and the `qvm_postgres` Docker container running. The packaged script does the seed for you:

```bash
corepack pnpm db:up
corepack pnpm db:migrate
corepack pnpm --filter @qvm/api test:smoke
# test:smoke = tsx drizzle/seed/index.ts > /dev/null && bash scripts/smoke.sh
```

**"Freshly seeded" is not a suggestion.** Sections 2–4 create directory rows with fixed keys (`NEWTAX1`, `IMPA1`, `DUP99`, …) and the cleanup blocks at `smoke.sh:250-254` and `:258-261` only remove the RFQ-chain artefacts — they never delete from `vendors`. Re-run against a dirty database and the very first submission test flips from `pending` to `merged`, because the tax number already exists. That is why the `test:smoke` script seeds first rather than assuming.

The seed itself has a matching guard (`apps/api/drizzle/seed/index.ts:17-37`): it truncates every table, so it refuses to run unless the DSN hostname is in an allow-list of unmistakably local hosts (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal`), unless `SEED_I_KNOW_THIS_IS_NOT_LOCAL=yes` is set. The repo is rsynced to the server, so a `pnpm db:seed` in the wrong directory on the box would replace production with fixtures.

### Sections

| § | Name | Assertions | What it actually proves |
|---|---|---|---|
| 1 | Schema & dedup | 6 | `counterparty_type` exists on both directories; the 6 scoped unique indexes exist; `counterparty_submissions` and `import_batches` both carry RLS; company-tax and individual-mobile duplicates raise `duplicate key`, and an individual's mobile colliding with a company's phone does **not**. The dedup checks run inside `BEGIN … ROLLBACK`, so they leave nothing behind. |
| 2 | Submission, match, review | 23 | The counterparty onboarding pipeline end to end: new company → `pending`; exact tax re-submit → `merged` to the *same* entity id; individual exact-mobile → auto-link; type-scoped matching (an individual sharing a company's phone must stay `pending`); `%` escaping in the name matcher; the privacy split (the submitter gets a `matchCount`, the reviewer gets candidate names); approve/reject/`use merge instead`; and that a workspace manager gets 403 on both review and approve. |
| 3 | Bulk import | 7 | A 5-row import splits into 1 auto-linked / 3 pending / 1 error, the `import_batches` row records `completed\|4\|1`, three rows land in `counterparty_submissions` tagged `excel_import` with the batch id, and a 1001-row payload is rejected by the cap. |
| 4 | Governance guards | 6 | A workspace manager cannot `POST /vendors`, cannot `POST /org/workshops`, and cannot browse `/vendors/available` — but *can* list linked vendors and *can* submit a counterparty. Platform staff can still write the directory directly. |
| 5 | Individual-read privacy RLS | 4 | Asserted **through `qvm_app`, not through the API.** An internal session sees an individual vendor; the linked workspace sees it; an unlinked workspace sees zero; every workspace still sees a company row. |
| 6 | Live/Sandbox isolation | 13 | The boundary holds in the database: a sandbox session sees zero live RFQs, `app_is_internal()` does not reopen it (the policy is RESTRICTIVE), a sandbox session **cannot forge a row labelled live**, `next_order_number` counts the two environments separately (`SMOKE-SBX-1` vs `SMOKE-1`), `tenants.is_sandbox` is gone, and every table with an `environment` column carries the restrictive policy — computed by a `NOT EXISTS` query, not a magic number. Plus regressions found by auditing the boundary: a sandbox quote link resolves rather than 404ing (and a bogus token still 404s), the quote and its RFQ are stored as `sandbox`, and a platform staffer on workspace A cannot raise a PO on workspace B's order. |
| 7 | Authorization preconditions & PII floor | 11 | Picking a winner moves the item to `priced`; a **cancelled** item then cannot be confirmed into an order and produces no order line (this was a real defect — a winning-quote id survives a later status change, so "has a winner" was not a sufficient precondition). Then the PII floor via `qvm_app`: a non-internal session reads zero rows from `users` and zero from `platform_members`, while an internal one still can. Then the status gateway: picking a winner writes a `status_logs` row carrying the from-code, the to-code, a non-null `changed_by`, and the right `environment`. |
| 8 | Workflow engine | 15 | A non-super-admin cannot create a flow; the governed catalog is served; a draft flow can be created; an invented status code and a two-entry graph are both 400; a dead-end graph *saves* (drafts may be half-drawn) but cannot *activate*; a complete flow activates and is recorded `active`; an active flow returns 409 on edit and on delete; `new-version` clones the graph into a fresh draft; the three freeze triggers exist in `pg_trigger`; flows built in Live are invisible in Sandbox. |

Two details in section 6 are worth copying into any new assertion you write.

First, `smoke.sh:165-169` asserts that the live corpus is **non-empty** before asserting that sandbox sees zero:

```bash
LIVE_N=$(envq live false)
ok 1 "$([ "${LIVE_N:-0}" -gt 0 ] && echo 1 || echo 0)" "live session sees at least one live RFQ (=$LIVE_N)"
ok 0 "$(envq sandbox false)"  "sandbox session sees ZERO live RFQs"
```

Without the first line, an isolation test passes vacuously the day the seed stops creating an RFQ.

Second, `smoke.sh:187-190` counts violations rather than asserting a total:

```sql
select count(*) from information_schema.columns c
where c.table_schema='public' and c.column_name='environment'
  and c.table_name <> 'order_number_counters'
  and not exists (select 1 from pg_policies p where p.tablename=c.table_name
                  and p.policyname='environment_isolation' and p.permissive='RESTRICTIVE')
```

Expected `0`. A new table joining the operational set fails this immediately. An assertion phrased as "expect 42 protected tables" would have to be edited every time the schema grows, and would be edited without thinking.

---

## 4. `guard-check.sh` — the workflow guard, in its own file

Called from `smoke.sh:306` with the base URL and the platform-admin token. It prints `  PASS | …` / `  FAIL | …` lines; `smoke.sh` greps and folds the counts into its own totals.

It is a separate file for a concrete reason, stated at `guard-check.sh:4-6`: it drives a full RFQ → send → quote → pick-winner chain **twice**, and inlining that in `smoke.sh` meant three layers of shell escaping around JSON payloads. See §7.

The 22 assertions, grouped:

| Group | n | What it proves |
|---|---|---|
| Permissive until configured | 1 | With no active flow, a normal status move is allowed. This is what made the rollout safe for live orders — the guard is inert until a workspace opts in. |
| Activation and bite | 2 | A flow activates; the same move, now off the drawn path, is refused. |
| The 0048 frozen/tunable split | 3 | `workflow_child_freeze`'s source contains `owner_roles` (semantics are frozen) but **not** `NEW.pages` (a mis-routed status stays fixable without republishing), and `workflow_steps.pages` defaults to `[]` — no routing opinion until someone draws one. The first two are asserted by reading `pg_proc.prosrc`, because the split is a hard-coded column tuple inside a plpgsql function — a new semantic column nobody adds to that tuple is silently editable on an active flow. |
| Orphaned migration | 1 | See §6. |
| Role gates | 3 | A rule restricting an arrow refuses an actor who lacks the role; a platform `super_admin` is break-glass and still gets through; activation refuses a step whose owner role nobody in the workspace holds. Note `guard-check.sh:111-124`: the suite **mints a non-super platform user** (`purchasing`) on the fly, because every status endpoint here is platform-only and the seeded admin is `super_admin`. Without that user the role guard would look like it worked while doing nothing at all. |
| Queue routing | 6 | With no active flow, `?queue=` filters nothing. A routed status appears on its page, not on others, and asking for no queue still returns everything. Then the safety rule, twice: an **unrouted** status still appears on every page, including pages other statuses are routed to. Without that rule, the first time an admin routes one status, every other status silently vanishes from every queue. |
| Custody / handoff | 3 | Each of `pool` / `actor` / `keep` is driven for real through `new_rfq → priced` and the resulting `workflow_record_state.assignee_user_id` is read back from the database. |
| SLA and freeze | 2 | The step's `slaHours` becomes a real `due_at` on the record; the freeze trigger governs `handoff`. |
| `/my-work` | 1 | Answers 200 and does not explode on an empty workspace. |

**`guard-check.sh` is local-only, permanently.** Its `wfclean()` helper (`:20-29`) runs `ALTER TABLE … DISABLE TRIGGER` on all three freeze triggers so it can delete active flows, and it connects as the database owner (`psql -U qvm`) to do so. That is not something to point at production, which is why `smoke-prod.sh` has no workflow section at all.

---

## 5. `smoke-prod.sh` — verification that is safe to run against real data

24 assertions against `$SMOKE_BASE` (default `https://easycarty.store`) plus SSH into the prod host for `psql`. Every design decision in this file is about not damaging production.

- **No credentials, and no host, in the file.** `PROD_SSH`, `SMOKE_ADMIN_PASS` and `SMOKE_MANAGER_PASS` come from the environment, and the script aborts with a clear message if any is missing (`:13-20`). The comment states why: a password committed here is a live credential in version control, and it stays in git history long after anyone rotates it. `deploy.sh:92-98` sources them from the local `.env` (ignored by `.gitignore`) and *skips* the suite rather than failing if they are absent.
- **Dedup is proven inside `BEGIN … ROLLBACK`** (`:37-42`), so three insert attempts leave zero rows.
- **The counterparty path is submit → reject, never approve** (`:52-61`). It snapshots `count(*) from vendors` before and after and asserts they match. A rejected submission creates no directory row.
- **Cleanup deletes its own submission** (`:84`) and asserts the delete happened.

Its unique value over the local suite is that it can check things that only exist in production:

| Assertion | Where | Why it can only be checked on prod |
|---|---|---|
| `/api/rfqs` with `X-Environment: sandbox` returns 0 while live returns >0 | `:68-73` | The boundary must survive **nginx**. If the proxy ever strips `X-Environment`, `resolveEnvironment()` fails open to `live` and a user who believes they are in Sandbox writes real data. Silent by design unless asserted. |
| a request with **no** environment header returns the same count as `live` | `:74` | Confirms the fail-closed-to-real-data default is what actually happens through the real stack. |
| `/api/me` echoes back `live` and `sandbox` respectively | `:75-76` | The only way a client can discover the server disagrees with it. |
| every `environment` table carries the RESTRICTIVE policy on prod; `tenants.is_sandbox` is gone | `:77-81` | Same `NOT EXISTS` query as the local suite, run through `rpsql`. |
| `directory_read` exists on `vendors`+`workshops` and `global_read` does **not** | `:33-34` | Confirms migration `0032_individual_read_privacy.sql` actually applied on prod, not just locally. |

---

## 6. `verify-rls.ts` — the invariant scan

Read-only. It queries `pg_class`, `pg_policies` and `information_schema.columns` and exits 1 on any violation. Real output against the local database:

```
$ corepack pnpm --filter @qvm/api db:verify
RLS verify OK — 93 tables all covered (42 environment-isolated).
```

It exists because of a specific incident, recorded in its own header (`verify-rls.ts:1-15`): new tables are born **fully open to `qvm_app`** via the default ACL, and the policy loop in migration `0001` only covered tables that existed at that moment. `platform_audit` was created by `0029_platform_audit.sql` and slipped through exactly that way — `qvm_app` had unrestricted cross-tenant read/write/delete on the impersonation audit ledger until `0034_audit_hardening.sql` closed it. A grep-based review would not have caught it; a schema-wide invariant does.

The four checks (`:49-59`):

| # | Condition | Why it is fatal |
|---|---|---|
| 1 | `relrowsecurity` is false | the table is open to `qvm_app` |
| 2 | RLS on but **zero** policies | Postgres denies everything to `qvm_app` — the table is silently unusable, and the failure surfaces as an empty list in the UI, not an error |
| 3 | has `tenant_id` but not `FORCE`, or no policy whose qual/with-check mentions `current_tenant_id` | the owner is exempt from its own policies without `FORCE`; a tenant table without a tenant predicate leaks across workspaces |
| 4 | has `environment` but no **RESTRICTIVE** policy mentioning `current_environment` | a permissive one would be OR-ed with `tenant_isolation`'s `app_is_internal()` escape, and so bypassed in exactly the cross-workspace portals that need it most |

One exemption, `ENV_POLICY_EXEMPT = new Set(["order_number_counters"])` (`:47`). It carries `environment` only as part of its unique key, holds no business data, and `next_order_number()` must read the row it is about to bump.

Two notes on the file's honesty. Check 3's FORCE requirement applies **only to tables that carry `tenant_id`** — the header's "has RLS disabled or not FORCEd" reads broader than the code. And the scanner is happy with `global_read USING (true)` on any table without a `tenant_id`, so it would not have flagged the `users` / `platform_members` exposure that migration `0045_user_read_privacy.sql` fixed. It guards structure, not policy semantics.

`deploy.sh` runs it at step 4/8 — after migrations, **before** letting traffic in.

---

## 7. Trap 1: the stale-server abort

`smoke.sh:16-27`.

The API dev server has **no watch mode**. `apps/api/package.json` runs it as:

```
node --import @swc-node/register/esm-register src/main.ts
```

There is no `--watch`, no nodemon, no Nest CLI. Edit a service, run the suite, and you get green results **for code that is not running**. The comment records that this has already happened once.

The guard:

```bash
PID=$(/usr/sbin/lsof -ti tcp:${B##*:} -sTCP:LISTEN 2>/dev/null | /usr/bin/head -1)
if [ -n "$PID" ]; then
  API_EPOCH=$(/bin/ps -o lstart= -p "$PID" | { read -r l; /bin/date -j -f '%a %b %d %T %Y' "$l" +%s 2>/dev/null || echo 0; })
  SRC_EPOCH=$(/usr/bin/find src drizzle -name '*.ts' -exec /usr/bin/stat -f '%m' {} + 2>/dev/null | /usr/bin/sort -rn | /usr/bin/head -1)
  if [ "${API_EPOCH:-0}" -gt 0 ] && [ "${SRC_EPOCH:-0}" -gt "${API_EPOCH:-0}" ]; then
    echo "ABORT: the running API started before the newest source edit — restart it, or these results are fiction."
    exit 1
  fi
fi
```

`${B##*:}` strips everything up to the last colon in the base URL to get the port. It finds the listening PID, converts the process start time to an epoch, takes the newest mtime across `src/` and `drizzle/`, and refuses to report if source is newer than the process. Refusing is the right call: a suite that says "0 failed" about code you did not deploy is worse than a suite that says nothing.

**Three real limitations of this guard, all verified:**

1. **It is macOS-only.** `/bin/ps -o lstart=`, BSD `date -j -f`, and `stat -f '%m'` are all BSD-flavoured. On Linux `date -j` fails, `API_EPOCH` becomes `0`, and the `-gt 0` test short-circuits the whole check.
2. **It silently no-ops when run from the repo root.** `find src drizzle` is relative to the current directory. Run from `apps/api` it finds 115 files; run from the repo root — which is exactly what the script's own header at `smoke.sh:5` documents (`bash apps/api/scripts/smoke.sh`) — it finds zero, `SRC_EPOCH` is empty, the comparison collapses to `0 -gt <epoch>`, and the suite proceeds against a stale server. Both counts were measured. **Run it via `pnpm --filter @qvm/api test:smoke`**, which sets the working directory correctly.
3. **It is bypassed entirely if nothing is listening on the port** — the whole block is inside `if [ -n "$PID" ]`. That case is fine in practice, since the very next curl fails anyway.

If you touch nothing else in this document, fix limitation 2.

---

## 8. Trap 2: the orphaned migration

Asserted in two independent places.

**In `deploy.sh` step 3/8** (`deploy.sh:49-58`), as a Python pre-flight that runs *before* `drizzle-kit migrate`:

```python
d = "apps/api/drizzle/migrations"
tags = {e["tag"] for e in json.load(open(f"{d}/meta/_journal.json"))["entries"]}
orphans = sorted(f[:-4] for f in os.listdir(d) if f.endswith(".sql") and f[:-4] not in tags)
if orphans:
    sys.exit("ABORT: migration(s) missing from meta/_journal.json, drizzle would skip them: " + ", ".join(orphans))
```

**In `guard-check.sh:104-109`**, as the same computation expressed as an assertion expecting `0`, so a developer catches it locally rather than at deploy time.

The failure it prevents: **drizzle discovers migrations only through `meta/_journal.json`.** A `.sql` file with no entry there is never opened — and `drizzle-kit migrate` still exits `0`. A forgotten journal entry therefore ships as a *green deploy against a schema that was never altered*, and the API 500s on the columns it now queries. There is no error anywhere in the deploy log.

This matters more here than in a typical Drizzle project because much of the recent history is hand-written rather than generated. `0044_snapshot_sync.sql:1-8` documents it directly: the snapshot chain "had stalled at `meta/0035_snapshot.json` while 0036-0043 were hand-written". Snapshots exist for only a subset of tags (`0026`–`0029`, `0035`, `0044`, `0047`, `0067`), and `0035` / `0044` / `0067_snapshot_sync.sql` are deliberate no-op migrations whose only job is to re-sync drizzle's snapshot so the next `generate` diffs against reality. Hand-written files do not get journalled automatically.

**The journal check has a sibling now, and it covers the failure the journal check cannot see.** An orphaned `.sql` is a migration that never runs; a stale *snapshot* is a migration that runs and is wrong. `guard-check.sh` asserts that the schema `.ts`, the newest snapshot and the live database agree on the workflow tables' columns, reading the first two through `apps/api/scripts/schema-columns.ts` (which reads the snapshot from disk rather than regenerating it — a check that writes a migration file is not a check). Its expected value is `read|0|0`, not `0|0`: two empty sets have an empty symmetric difference, so a run where the helper failed to start would otherwise report `0|0` and pass while comparing nothing at all.

Current state, verified:

```
journalled: 50
sql files:  50
orphans:    []
```

---

## 9. How to add an assertion

### The helpers

All four scripts share the same shape. `smoke.sh:8-12` and `:33`:

| Helper | Signature | Notes |
|---|---|---|
| `ok` | `ok <expected> <actual> <label>` | string equality. In `smoke.sh`/`smoke-prod.sh` it increments `PASS`/`FAIL`. In `guard-check.sh` it only prints — see the gap in §10. |
| `jf` | `… \| jf <key>` | reads one **top-level** JSON key from stdin. Nested access needs an inline `python3 -c`. |
| `psql` | `psql "<sql>"` | `docker exec qvm_postgres psql -U qvm …` — the **owner** role. RLS does not apply. Use for setup, teardown, and reading ground truth. |
| `appsql` | `appsql "<sql>"` | connects as **`qvm_app`**, the runtime non-superuser, with the local dev password supplied via `PGPASSWORD`. RLS **does** apply. Use this whenever the thing you are proving is a policy. |
| `scode` | `scode <METHOD> <path> [curl args…]` | returns just the HTTP status code. |
| `rpsql` | `rpsql "<sql>"` (prod only) | SSHes to `$PROD_SSH` and runs `psql` there. |

Three pre-built header arrays: `M` (workspace manager, `X-Tenant: riyadh`), `A` (platform admin, no tenant), `AR` (platform admin + `X-Tenant: riyadh`).

The seeded fixtures the suites depend on (`apps/api/drizzle/seed/index.ts:115-176`): two tenants `riyadh` and `jeddah`; `admin@qparts.local` as platform `super_admin`; `manager@qparts.local` as `company_admin` of `riyadh`; plus `staff@`, `vendor@`, `workshop@` and `multi@` for the other personas. The fixture passwords are hashed in the seed file — read them from there rather than copying literals into new files.

### Choosing what to assert against

Pick deliberately. The rule the existing suites follow:

- **Testing an API contract or a role guard** → `scode` / `jf` against HTTP.
- **Testing an RLS policy** → `appsql`, never the API. The API path runs through `AuthGuard`, which can mask a missing policy. `smoke.sh:236-239` is the model: set the GUCs by hand as `qvm_app`, then count rows.
- **Testing a trigger or constraint** → `psql` with `BEGIN … ROLLBACK`, or read `pg_proc.prosrc` / `pg_trigger` directly, as `guard-check.sh:94-97` does.
- **Testing that a write happened** → assert on the API response *and* on the row. Most of section 7 does both.

Prefer a violation count over a total. `select count(*) … where not exists (…)` expecting `0` keeps working as the schema grows; `expect 42` gets edited without thinking the next time someone adds a table.

### The brace-expansion pitfall

`guard-check.sh:10-11` states the rule:

> JSON payloads are built with printf, NOT an inline python dict: `{...}` inside nested double quotes hits bash brace expansion, which silently mangles the body into something the API rejects.

This is worth understanding rather than obeying blindly, because it fails *silently*. Reproduced:

```bash
args() { echo "argc=$#"; for a in "$@"; do echo "  [$a]"; done; }
S=SITEM-1

# BROKEN — python invoked inline as an argument
args -d "$(python3 -c "import json,sys;print(json.dumps({'items':[{'rfqItemId':sys.argv[1],'offeredCost':50}]}))" "$S")"
```

```
  File "<string>", line 1
    import json,sys;print(json.dumps({'items':['rfqItemId':sys.argv[1]]}))
                                                          ^
SyntaxError: invalid syntax
  File "<string>", line 1
    import json,sys;print(json.dumps({'items':['offeredCost':50]}))
                                                            ^
SyntaxError: invalid syntax
argc=3
  [-d]
  []
  []
```

Bash brace-expands `{'rfqItemId':…,'offeredCost':50}` — any `{…}` containing a comma is a brace-expansion candidate — **before** it re-parses the nested command substitution. Python is invoked twice with two broken scripts, both error to stderr, and `curl` receives two empty `-d` arguments. `curl` does not complain. The API returns a 400 about a missing field and you spend twenty minutes debugging the endpoint.

Three forms that work, all verified:

```bash
# 1. printf with a SINGLE-quoted format string — what guard-check.sh uses.
#    Single quotes suppress brace expansion outright.
curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"GP","quantity":1}]}' "$BR" "$plate")"

# 2. Assign to a variable FIRST, then pass the variable — what smoke.sh:201 uses.
QPAY=$(python3 -c "import json,sys;print(json.dumps({'items':[{'rfqItemId':sys.argv[1],'offeredCost':50}]}))" "$SITEM")
curl … -d "$QPAY"

# 3. Escaped JSON with no command substitution at all — fine for static payloads.
curl … -d "{\"a\":$BR,\"b\":2}"
```

Form 2 works because the assignment right-hand side is not itself inside another pair of double quotes. Move the *identical* command substitution inline into an argument and it breaks. That distinction is the entire trap.

Prefer form 1 for anything with interpolated values. Use single-quoted heredocs (`<<'SQL'`) for multi-statement SQL, as sections 1 and 3 do.

### The recipe

1. Decide the layer (§ "Choosing what to assert against") and pick `scode` / `jf` / `psql` / `appsql`.
2. Build the payload with `printf '…json…' "$var"`, single-quoted format.
3. Write `ok <expected> "<actual>" "<a sentence saying what would be broken if this failed>"`. The labels in these files are prose, not identifiers — `"a sandbox session CANNOT insert a row labelled live"` tells a future reader what the regression was. `"test 14b"` does not.
4. If the new check writes rows, add the teardown to the matching cleanup block. Note the ordering constraint at `smoke.sh:249-254`: `rfq_items.winning_vendor_quote_item_id` must be nulled **before** the quote rows it points at are deleted, or the cleanup half-fails and leaves the next run dirty.
5. If it asserts on a not-yet-populated corpus, add a non-emptiness assertion first so it cannot pass vacuously.
6. Restart the API before running. The staleness guard will not save you if you run from the repo root.

---

## 10. Known gaps in the test suites themselves

These are properties of the suites, verified by reading them. They are listed so nobody trusts a green run further than it deserves.

| Gap | Detail |
|---|---|
| **A crash in `guard-check.sh` reads as a pass.** | `guard-check.sh`'s `ok()` does not keep counters; `smoke.sh:307-309` recounts by grepping `^  PASS` / `^  FAIL` out of the captured output. If `guard-check.sh` dies partway — it runs `set -uo pipefail`, so one unbound variable is enough — `smoke.sh` folds in *fewer* PASS lines and *zero* FAIL lines, and still prints `0 failed`. The total shrinks silently. Nothing asserts that 22 checks ran. |
| **`guard-check.sh` always exits 0.** | Its last statement is a `psql` cleanup (`:233-239`). Run standalone it can never fail a pipeline. |
| **`smoke.sh` and `smoke-prod.sh` have no `set -e`, `-u` or `-o pipefail`.** | Verified: neither file has a `set` line. A failed setup step (a login returning an empty token, a `psql` that errors) does not stop the run — it produces a cascade of confusing FAILs downstream. |
| **The staleness guard is macOS-only and cwd-dependent.** | §7. |
| **No CI.** | Nothing runs any of this automatically. `deploy.sh` runs `verify-rls.ts` and `smoke-prod.sh`; `smoke.sh` and `guard-check.sh` run only when a human types the command. |
| **No frontend tests at all.** | Not one. The `WIRED` route set in `apps/web/src/App.tsx:66-92`, the `Placeholder`/`ComingSoon` fallback for every unwired nav path, the persona nav in `apps/web/src/nav.tsx` — none of it is asserted anywhere. |
| **No coverage of pure functions.** | `cleanPartNumber`, `queuePredicate` (`apps/api/src/modules/workflow/routing.ts:22`), `AiService.quotaDetail`'s 429 translation (`apps/api/src/common/ai.service.ts`), the zod schemas — all untested except incidentally, through an endpoint that happens to call them. |
| **13 API modules have no test coverage and no UI.** | `purchasing`, `delivery`, `invoicing`, `returns`, `shipping`, `approvals`, `pricing`, `insurance`, `vendor-finance`, `vendor-selfservice`, `vendor-assignment`, `parts`, `infra`. Verified two ways: no route prefix of any of them appears in `apps/web/src`, and their nav entries in `nav.tsx` carry `soon: true` so they resolve to the `Placeholder` route. `smoke.sh` touches purchasing only to assert a cross-workspace **403** (`:214`). Nothing exercises a happy path through any of them. |
| **Nothing asserts outbound delivery, because there is none.** | `NotificationsService.send()` (`apps/api/src/modules/notifications/notifications.service.ts:60-63`) has a comment where provider dispatch would go and a `logger.log()` where the send would be. Everything is written to `notification_log` with status `suppressed` unless `environment` is live **and** `NODE_ENV=production` **and** the channel's provider env var is set. The suites only ever delete from `notification_log` in cleanup; they never assert on it. |
| **`verify-rls.ts` checks structure, not semantics.** | A `global_read USING (true)` on a table full of personal data passes. It would not have caught the `users` / `platform_members` exposure that migration `0045` fixed. |
| **`smoke.sh` needs a reseed between runs.** | §3. The directory rows it creates are never cleaned up. |
| **The header count is stale.** | `smoke.sh:2` says 88; the file holds 85 of its own plus 22 folded in. |