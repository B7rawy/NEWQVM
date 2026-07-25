# QVM Platform

QVM is a multi-tenant B2B procurement platform for auto spare parts in the Saudi market. A repair workshop files a request for parts; Qparts staff clean it up, invite vendors to quote, pick a winner per line, and turn the winning lines into a confirmed order that is then purchased, delivered, invoiced, and — when something is wrong — returned and credited. This repository is a clean rebuild of the original Qparts/QVM system: same domain, new schema, tenancy enforced by PostgreSQL row-level security rather than by application `WHERE` clauses.

Live at `easycarty.store`. Deployment is `./deploy.sh` only.

---

## Repository layout

```
qvm-platform/
├── apps/
│   ├── api/                     NestJS 10 + Drizzle 0.36 + postgres.js. TypeScript ESM.
│   │   ├── src/
│   │   │   ├── main.ts          Bootstrap: global prefix /api, CORS open, one Zod exception filter.
│   │   │   ├── app.module.ts    31 controllers registered flat on the root module (+2 inside
│   │   │   │                    AuthModule and WorkflowModule).
│   │   │   ├── common/          AuthGuard, RolesGuard, request context, StatusService, AiService.
│   │   │   ├── db/              DbService — connects as qvm_app and sets the RLS session GUCs.
│   │   │   └── modules/         29 domain module folders (rfq, orders, purchasing, workflow, portals, …).
│   │   ├── drizzle/
│   │   │   ├── schema/          28 files; 93 `pgTable` declarations. (index.ts, _shared.ts and
│   │   │   │                    enums.ts declare no tables.)
│   │   │   ├── migrations/      50 journalled SQL migrations (0000–0049).
│   │   │   └── seed/            Local dev fixtures. TRUNCATES everything before seeding.
│   │   └── scripts/             verify-rls.ts, smoke.sh, guard-check.sh, smoke-prod.sh.
│   └── web/                     React 18 + Vite 5 + Tailwind 3 SPA. Dev server on :5200.
│       └── src/                 App.tsx (routing + the WIRED set), nav.tsx (per-persona menus),
│                                lib/api.ts (the single fetch client), pages/, components/.
├── packages/
│   └── shared/                  Role constants. Declared as an API dependency but imported nowhere.
├── infra/
│   ├── docker-compose.yml       postgres:16-alpine (qvm_postgres) + minio (unused, see below).
│   └── data/                    Local volume mounts. Git-ignored.
├── docs/                        Architecture, conventions, ADRs, phase logs. Arabic. See below.
├── deploy.sh                    The only supported production deploy path.
└── .env.example                 Template for local config. Not exhaustive — see the note below.
```

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | ≥ 22 | Enforced by `engines` in the root `package.json` |
| Docker | recent | Runs Postgres locally |
| pnpm | 9.15.0 | Pinned via `packageManager`. Use `corepack pnpm <cmd>` |

On macOS `corepack enable pnpm` can fail with `EACCES` (it wants to symlink into `/usr/local/bin`). Use the `corepack pnpm <command>` form directly — it needs no privileges. Every command below uses that form.

---

## Local setup

```bash
git clone <repo-url> qvm-platform
cd qvm-platform

cp .env.example .env          # then edit every change_me value
corepack pnpm install

corepack pnpm db:up           # docker compose -f infra/docker-compose.yml up -d

# drizzle-kit does NOT read the repo-root .env — export it yourself first:
set -a && . ./.env && set +a
corepack pnpm db:migrate      # drizzle-kit migrate, connects as DATABASE_URL (the owner role)
corepack pnpm db:seed         # tsx drizzle/seed/index.ts — TRUNCATES, then seeds fixtures
corepack pnpm dev             # api on :4000 and web on :5200, in parallel
```

`db:seed`, `db:verify` and the API itself all have hardcoded localhost fallbacks that happen to match `.env.example`, so they work in a bare shell. `db:migrate` and `db:studio` do not: `apps/api/drizzle.config.ts` falls back to port **5432**, not 5434, so without an exported `DATABASE_URL` drizzle-kit silently aims at the wrong server. `deploy.sh` sources `.env` before every drizzle-kit call for exactly this reason.

### Port note — read this before the first `db:up`

`infra/docker-compose.yml` defaults the host port to **5433**, `.env.example` sets `POSTGRES_PORT=5434`, and `drizzle.config.ts` falls back to **5432**. Compose reads `POSTGRES_PORT` from your `.env`, so copying `.env.example` first makes compose and the app agree. The drizzle-kit fallback only bites when `DATABASE_URL` is unset, which is why the step above exports it.

### `.env.example` is a template, not an inventory

It is not a complete list of what the code reads, in either direction:

| | |
|---|---|
| Read by the code, **absent** from `.env.example` | `IMPERSONATION_TTL` (`modules/admin/impersonation.service.ts`, defaults to `30m`) |
| Present in `.env.example`, **read by nothing** | `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `PAYMENT_MODE` |

The complete set the API actually reads: `DATABASE_URL`, `APP_DATABASE_URL`, `API_PORT`, `NODE_ENV`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `IMPERSONATION_TTL`, `APP_ROOT_DOMAIN`, `EMAIL_PROVIDER`, `WHATSAPP_ENABLED`, `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `SEED_I_KNOW_THIS_IS_NOT_LOCAL`. The web app reads `VITE_API_URL` and `import.meta.env.PROD`.

`JWT_SECRET` falls back to a dev default outside production and **throws** when `NODE_ENV=production` (`modules/auth/auth.module.ts`), so a prod boot cannot sign tokens with the dev secret.

### Two database roles, and why it matters

- `DATABASE_URL` — the owner role. Used by migrations, the seed, and `drizzle-kit studio`.
- `APP_DATABASE_URL` — the `qvm_app` role, created by `drizzle/migrations/0002_app_role.sql`. This is the only connection the running API uses (`src/db/db.service.ts`).

`qvm_app` is deliberately not a superuser and not a table owner, because **PostgreSQL exempts superusers and table owners from row-level security**. Tenant isolation in this codebase is RLS, not `WHERE tenant_id = ?` — most services issue no tenant filter at all (see `apps/api/src/modules/rfq/rfq.service.ts`, where the workshop-branch lookup joins `tenant_workshops` with no `tenant_id` predicate and relies entirely on the policy). Pointing `APP_DATABASE_URL` at the owner role silently disables every policy and nothing fails loudly. This is the single highest-consequence configuration fact in the system.

Note that `0002_app_role.sql` creates the role with a **hardcoded local-dev password committed to the repo**. Production overrides it out-of-band — the restore runbook at the bottom of `deploy.sh` re-sets it from the server-only `apps/api/start.sh`. Do not ship the committed default anywhere real.

Every request runs inside `DbService.withContext()`, which opens a transaction and `set_config`s five session GUCs: `app.tenant_id`, `app.user_id`, `app.is_internal`, `app.environment`, `app.impersonator_id`. Querying a tenant table outside `withContext` is a bug.

### Accessing a workspace locally

In production each workspace lives at `<slug>.easycarty.store` and the subdomain is authoritative (`apps/web/src/lib/tenant.ts` → `currentSubdomain()`). On `localhost` there are no subdomains, so the client falls back to a cross-subdomain cookie / localStorage value and sends it as the `X-Tenant` header on every request (`apps/web/src/lib/api.ts`).

The same client also sends `X-Environment` (`live` | `sandbox`) on every request. Live/Sandbox is a **row-level** boundary inside one workspace, not a separate workspace — see ADR-0012. Both switchers live in the app header (`components/AppShell.tsx`), which also renders an unmissable banner while you are in Sandbox.

The seed creates two workspaces: `riyadh` (Qparts Riyadh) and `jeddah` (Qparts Jeddah).

### The API dev server does not hot-reload

`apps/api` runs as `node --import @swc-node/register/esm-register src/main.ts`. Restart it after every backend edit. `scripts/smoke.sh` compares the API process start time against the newest source mtime and refuses to run against a stale process, because reporting green results for code that isn't running has already happened once.

Do **not** run the API under `tsx`. esbuild does not emit `emitDecoratorMetadata`, which breaks Nest dependency injection (`docs/phases/phase-2-backend.md` §1). The seed and migrations use tsx/drizzle-kit normally.

---

## Seeded demo logins

> **These are DEV SEED credentials.** They are hardcoded in plain text in `apps/api/drizzle/seed/index.ts` and are therefore public to anyone with repo access. They exist so a fresh clone can log in immediately. **Never create these accounts in production, and never reuse these passwords anywhere.** The seed script itself refuses to run against a non-local host unless `SEED_I_KNOW_THIS_IS_NOT_LOCAL=yes` is set, because it truncates every table first.

| Email | Password | Persona | Access |
|---|---|---|---|
| `admin@qparts.local` | `admin1234` | platform | `super_admin` in `platform_members` — sees every workspace |
| `manager@qparts.local` | `manager1234` | workspace | `company_admin` in `riyadh` |
| `staff@qparts.local` | `staff1234` | workspace | `service_advisor` in `riyadh`, pinned to the Riyadh Main branch |
| `multi@qparts.local` | `multi1234` | workspace | `branch_manager` in `riyadh` + `service_advisor` in `jeddah` — exercises workspace switching |
| `vendor@qparts.local` | `vendor1234` | vendor | Admin of "Gulf Auto Parts Co.", lands on the vendor portal |
| `workshop@qparts.local` | `workshop1234` | workshop | Admin of "Al Faisal Motors", lands on the workshop portal |

All six are on the `@qparts.local` domain and named by role so the persona is obvious. The seed also creates one full RFQ → vendor invite → quote → winning-quote → confirmed-order chain in `riyadh`, so the portals have real data on first login. Three service providers are seeded and linked to `riyadh`, but **no service-provider user exists** — there is no seeded login for the provider persona.

---

## Tests

There is **no unit test framework** in this repo — no jest, no vitest, no `*.spec.ts`. All testing is bash + curl + psql against a running local stack. There is also no CI configuration and no linter config; the root `lint` script calls `pnpm --recursive lint` and no package defines a `lint` script, so it does nothing.

| Command | What it does |
|---|---|
| `corepack pnpm --filter @qvm/api db:verify` | Static RLS invariant check. Exits 1 if any `public` base table has RLS off, has RLS on with zero policies, carries `tenant_id` without `FORCE` or without a `current_tenant_id` policy, or carries `environment` without a **restrictive** `current_environment` policy. Fast, non-destructive, safe to run any time. Verified output today: `RLS verify OK — 93 tables all covered (42 environment-isolated).` |
| `corepack pnpm --filter @qvm/api test:smoke` | The main suite (self-described as 88 checks). Re-seeds, then drives schema/dedup, counterparty onboarding, bulk import, governance, individual-read privacy RLS, and Live/Sandbox isolation over HTTP. Requires the API running on `:4000` and the `qvm_postgres` container (it shells into `docker exec psql`). Exits non-zero on any FAIL. |
| `bash apps/api/scripts/guard-check.sh <base-url> <admin-token>` | Workflow-engine regression. Drives a full RFQ → send → quote → pick-winner chain twice to prove the status guard stays out of the way when no flow is configured and bites when one is. Invoked automatically at the end of `smoke.sh`; run standalone only when iterating on the workflow engine. Note it disables and re-enables the workflow freeze triggers and deletes every flow row — local only. |
| `corepack pnpm --filter @qvm/api test:smoke:prod` | Production variant. Refuses to run unless `PROD_SSH`, `SMOKE_ADMIN_PASS`, and `SMOKE_MANAGER_PASS` are set in the environment. Run from a developer machine, not from the server. |
| `corepack pnpm typecheck` | `tsc --noEmit` across all three packages. |

Note that `test:smoke` re-seeds, which truncates your local database. Anything you created by hand is lost.

---

## Deploying

`./deploy.sh` is the only supported path. It exists because a hand-written `rsync -az --delete` on 2026-07-25 deleted three prod-only paths that do not exist in the repo — the Postgres data directory, pm2's entrypoint script, and `.env` — and the database was recreated empty. It was recoverable only because a `pg_dump` had been taken minutes earlier.

The script, in order: dumps roles (`pg_dumpall --roles-only`) **and** data before touching anything; rsyncs with an explicit protect list (`pgdata`, `.env`, `apps/api/start.sh`, `apps/web/dist`, `infra/data`, `.git`, plus `node_modules` at any depth); installs dependencies **on the server** from the frozen lockfile; aborts if any `.sql` in `drizzle/migrations/` is missing from `meta/_journal.json` (drizzle only opens journalled files and still exits 0, so a forgotten entry ships as a green deploy against an unchanged schema); runs the migrations; runs `verify-rls.ts` **before letting traffic in**; builds the web bundle locally and rsyncs `dist/`; restarts pm2 and polls until `/api/me` answers 401; runs two HTTP checks that fail the deploy; then runs the production smoke suite — or skips it, with a message, if the smoke credentials are absent.

Both dumps are required: a plain `pg_dump` restores data but not cluster roles, and every `GRANT` then fails with "role qvm_app does not exist" while drizzle sees `0002_app_role.sql` already recorded and will not recreate it. The restore runbook is printed at the end of every deploy.

Configuration is by environment variable name only: `QVM_HOST`, `QVM_REMOTE`, `PROD_SSH`, `SMOKE_ADMIN_PASS`, `SMOKE_MANAGER_PASS`. `QVM_HOST` and `QVM_REMOTE` have defaults baked into `deploy.sh`; override them rather than editing the file. The nginx config, the pm2 ecosystem file, and `apps/api/start.sh` are prod-only and are **not** in this repo.

---

## State of the repo — read before you trust a screen

This codebase has real gaps. They are listed here rather than discovered later.

- **Notifications never dispatch.** `apps/api/src/modules/notifications/notifications.service.ts` writes a `notification_log` row and then logs a line. The branch where a real provider would be called is an empty comment (`// real provider dispatch goes here`) followed by `void secret`. There is no SMTP, WhatsApp, or webhook client anywhere in the repo. Consequence for the vendor flow: `vendor-rfq.service.ts` generates a raw quote token, stores only its SHA-256 hash, hands the raw link to the notifications layer — which drops it. Outside production the raw token is returned in the API response so tests can follow it; in production it is unrecoverable, so **the emailed vendor quote link cannot currently reach a vendor**. The authenticated vendor portal is the working path.
- **The fulfilment and finance half has no UI.** Purchase orders, deliveries, client invoices, returns, credit notes, shipping, approvals, pricing, insurance, master parts, vendor assignment and vendor finance all have guarded API endpoints and **zero** frontend callers — verified by grepping every `api.get/post/put/patch/del` call in `apps/web/src`. An order can be created and confirmed through the UI (`pages/RfqDetail.tsx` calls `/rfqs/:id/send`, `/items/:id/winning-quote`, `/confirm`) and then cannot be advanced without `curl`. There is also no `/orders/:id` detail page.
- **Two pages are entirely mock data.** `pages/InternalDashboard.tsx` (`/internal`, 1,376 lines) and `pages/ManagementOverview.tsx` (`/management-overview`, 987 lines) make no API calls; every button on the internal dashboard is a fake toast, including three separate "Vendor RFQ sent" buttons. `pages/Overview.tsx` mixes a real KPI strip and Recent-RFQs table (fed by `/rfqs` and `/orders`) with a hardcoded pipeline grid, donut, funnel, top-vendors list and trend chart, all in identical styling. All three files say so in a header comment — read it before believing a number.
- **`apps/web/src/App.tsx` holds a `WIRED` set of 25 paths.** Anything in the persona navigation outside that set renders a "Coming soon" placeholder. `apps/web/src/nav.tsx` marks **42** nav items `soon: true`.
- **9 of 26 item statuses and 3 of 14 vendor statuses have a writer.** Item: `new_rfq`, `priced`, `confirmed`, `delivered`, `invoice_issued`, `return`, `credit_note_issued`, `sent_insurance_approval`, `insurance_approved`. Vendor: `rfq`, `priced`, `confirmed`. The rest are the old system's vocabulary, seeded deliberately with their `legacy_id`s so the eventual data migration is a mapping rather than a translation (`drizzle/seed/reference-data.ts`).
- **Drizzle schema drift.** `drizzle/schema/workflow.ts` is missing five columns that migration `0049` added and that `common/status.service.ts` reads via raw SQL: `assignee_user_id`, `assignee_role`, `step_entered_at`, `due_at` on `workflow_record_state`, and `handoff` on `workflow_transitions`. The next `drizzle-kit generate` would emit `DROP COLUMN` for all five. Fix this before running `db:generate`.
- **MinIO is provisioned and unused.** The compose service and five `S3_*` variables exist; no `S3_*` variable is read anywhere in `apps/api/src`, and there is no upload code. An `attachments` table is declared in `drizzle/schema/crosscutting.ts` and is referenced by nothing in `src/`.
- **`@qvm/shared` is dead.** Declared as an API dependency, imported by nothing; the role enums are duplicated by hand in `drizzle/schema/enums.ts`, which says so in a comment.
- **The AI workflow assistant is real but off by default.** `common/ai.service.ts` calls Gemini directly over `fetch`, `modules/workflow/workflow.service.ts` consumes it, and `pages/admin/WorkflowCanvas.tsx` posts to `/admin/workflows/:id/assist`. It returns 503 unless `AI_PROVIDER=gemini` and `GEMINI_API_KEY` are set on the server. The model only ever emits structured JSON that the server validates against the real status catalog; it never writes SQL.
- **No rate limiting, no helmet, CORS is fully open** (`main.ts` passes `{ cors: true }`). No such dependency exists in `apps/api/package.json`.
- **The frontend breaks its own convention.** `docs/CONVENTIONS.md` §Frontend rule 1 requires a lazy route per page; `App.tsx` statically imports all 30-odd pages at the top of the file.
- **`ADR-0011` is cited in `drizzle/schema/org.ts` and in `drizzle/seed/index.ts` but does not exist** in `docs/decisions/` (which holds `0001`–`0010` and `0012`). Whatever the tenant↔workshop link decision was, it is only recorded in code comments.
- **The docs in `docs/` are Arabic and several are stale.** The root README you are replacing describes the project as Phase 0; `docs/ONBOARDING.md` still says the api and web apps have not been generated yet; `docs/phases/phase-3-roadmap.md` reports 81 tables and 24 migrations against today's 93 and 50; `ADR-0012` says 27 tables carry `environment` where the schema now has 43 such columns.

---

## Where to look next

Everything under `docs/` is written in Arabic. Freshness is noted honestly.

| Doc | What it covers | State |
|---|---|---|
| [`docs/README.md`](docs/README.md) | Reading order and the project's documentation rules | Current |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | Original setup walkthrough | **Stale** — its closing section says the apps are not built yet. Use the Local setup section above |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, multi-tenancy, Live/Sandbox, environments, scalability, monorepo layout, 7-phase roadmap | Mixed. §5 is current (correctly describes ADR-0012 superseding ADR-0004). §8's backend module list (`tenants`, `quotations`, `sandbox`, `files`, `reports`) does not match `src/modules/`, §2 still names MinIO as the file-storage layer, and §10 marks Phase 1 as "we are here" |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | Binding rules for DB, backend, frontend, git, and documentation | Current as a set of rules; the frontend lazy-route rule is not honoured by the code |
| [`docs/decisions/`](docs/decisions/) | 11 ADRs (`0001`–`0010`, `0012`; **`0011` is missing**). One decision per file, append-only — `0004` carries a superseded banner at the top rather than being edited away | Current |
| [`docs/design/schema-v1.md`](docs/design/schema-v1.md) | Schema design principles, enums vs reference tables, the order chain | Historical — pre-migration review draft |
| [`docs/design/new-schema-design.md`](docs/design/new-schema-design.md) | Table-by-table schema design with rationale | Historical |
| [`docs/reference/old-system-schema.md`](docs/reference/old-system-schema.md) | 1,704-line reference for the original `qvm_new_apps` schema: order chain, chain keys, status lifecycles, full column reference | The authoritative source for legacy behaviour |
| [`docs/phases/`](docs/phases/) | Execution logs for phases 0–3: what was done, which commands, which files | Phase 3 is the most recent and is itself out of date (see above) |

The ADRs are the highest-value reading. Start with `0003` (multi-tenancy), `0008` and `0010` (global vendors and the identity model), and `0012` (Live/Sandbox as a row-level boundary, which supersedes `0004`).

For the code itself, the useful order is `apps/web/src/nav.tsx` → `apps/web/src/App.tsx` (the `WIRED` set tells you what exists) → `apps/api/drizzle/seed/reference-data.ts` (the status vocabulary) → `apps/api/src/modules/rfq/rfq.service.ts` → `apps/api/src/modules/orders/orders.service.ts` → `apps/api/src/common/status.service.ts` → `apps/api/src/common/auth.guard.ts`. `status.service.ts` is the one to read slowly: it is the single status-write gateway, the audit-log writer, and the workflow guard, and its comments explain why all three had to be collapsed into one function before any of them could be trusted.