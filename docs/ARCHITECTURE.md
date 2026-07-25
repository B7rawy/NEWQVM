# QVM — Architecture

This document explains how the QVM platform is put together: the two applications, how they talk to each other, and what happens to a single HTTP request from the moment it arrives until it hits Postgres. Every claim here was checked against the file it cites.

QVM is a multi-tenant B2B procurement platform for auto spare parts in Saudi Arabia. A repair workshop asks for parts, staff invite suppliers to quote, a winner is picked per line, and the result becomes an order. This document is about the machinery, not the business domain.

A note on citations: several code comments reference `CONVENTIONS §BE-4`, `§DB-2`, `§FE-1` and similar. `docs/CONVENTIONS.md` is written in Arabic and its rules are numbered under section headings (Database, Backend, Frontend, Git, Documentation) rather than labelled `BE-n`. The `§XX-n` form is the codebase's shorthand for "section, rule n" — e.g. `§BE-4` is Backend rule 4 (zod DTOs at the boundary), `§DB-2` is Database rule 2 (RLS on every table, app connects as `qvm_app`), `§FE-1` is Frontend rule 1 (lazy route per page).

---

## 1. The two applications

| | `apps/api` (`@qvm/api`) | `apps/web` (`@qvm/web`) |
|---|---|---|
| Stack | NestJS 10, Drizzle 0.36, `postgres` 3.4 driver | React 18, Vite 5, Tailwind 3, react-router-dom 6 |
| Module system | ESM (`"type": "module"`, `.js` import specifiers) | ESM |
| Dev run | `node --import @swc-node/register/esm-register src/main.ts` | `vite` (port 5200, `host: true`) |
| Source size | 8,547 lines of TS | 11,545 lines of TS/TSX |
| Talks to | PostgreSQL 16 only | the API only |

They are joined by a pnpm workspace (`pnpm-workspace.yaml` globs `apps/*` and `packages/*`; root `package.json` pins `packageManager: pnpm@9.15.0`, `engines.node >= 22`). A third package, `packages/shared`, exists and is declared as an API dependency (`apps/api/package.json`) — but nothing imports it. `grep -rn "@qvm/shared" apps/api/src apps/web/src` returns zero hits. It holds `packages/shared/src/roles.ts` (`UserScope`, `PlatformRole`, `CompanyRole`, `VendorRole`), and those values are re-declared by hand as Postgres enums in `apps/api/drizzle/schema/enums.ts` — whose comment even says "Mirrors @qvm/shared enums". Treat it as dead weight, not as a source of truth.

### Why SWC and not tsx

`apps/api/README.md` (Arabic) states the rule, and it is worth knowing before you try to "fix" the dev script: **do not run the API with `tsx`.** esbuild does not emit `emitDecoratorMetadata`, and without it Nest's dependency injection cannot resolve constructor parameter types. SWC config lives in `apps/api/.swcrc`. Migrations and the seed script use `tsx`/`drizzle-kit` normally — they have no decorators.

There is also no watch mode. `pnpm --filter @qvm/api dev` starts the process once; a code change requires a restart. `apps/api/scripts/smoke.sh` compares the API process start time against the newest source mtime and aborts (`"ABORT: the running API started before the newest source edit"`) rather than reporting green results for code that is not running.

### Infrastructure

`infra/docker-compose.yml` defines two services:

- **postgres** — `postgres:16-alpine`, container `qvm_postgres`, host port `${POSTGRES_PORT:-5433}`, data in `infra/data/postgres`.
- **minio** — `minio/minio:latest`, ports 9000/9001, container `qvm_minio`.

MinIO is provisioned and unused. `.env.example` defines `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, but `grep -rn "S3_" apps/api/src` returns nothing. There is no upload endpoint and no S3 client in `apps/api/package.json`.

Three different Postgres port defaults exist and disagree: `infra/docker-compose.yml` falls back to `5433`, `.env.example` and `DbService`'s hardcoded fallback use `5434`, and `drizzle.config.ts`'s fallback uses `5432`. In practice `.env` decides; the fallbacks only bite when a variable is missing.

---

## 2. How the two apps talk

### Base URL

`apps/web/src/lib/api.ts`:

```ts
const BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "" : "http://localhost:4000");
```

In production `VITE_API_URL` is empty, so `BASE` is `""` and every call is same-origin — nginx serves the SPA and proxies `/api` to the Node process. That nginx config is **not in this repo**; the only evidence of the topology is this line plus the same-origin health checks in `deploy.sh` (`curl … https://easycarty.store/api/me`). `apps/api/start.sh` is likewise prod-only — it is not in the repo, and `deploy.sh`'s `PROTECT` array lists it (alongside `.env`, `pgdata`, `infra/data`) as a path that exists only on the server and must never be transferred or deleted.

The API mounts everything under `/api` via `app.setGlobalPrefix("api")` (`apps/api/src/main.ts`). There is no API versioning.

### The three headers

Every browser request carries them (`apps/web/src/lib/api.ts`, `request()`):

| Header | Value | Meaning |
|---|---|---|
| `authorization` | `Bearer <jwt>` | who you are |
| `x-tenant` | workspace slug | which workspace you are acting in (fallback only — see below) |
| `x-environment` | `live` \| `sandbox` | which parallel data set you are acting on |

`x-environment` is sent unconditionally. `x-tenant` is sent when a workspace is resolved.

### Subdomain beats header

`apps/api/src/common/request-context.ts`, `resolveTenantSlug()`: the **subdomain is authoritative**. `riyadh.easycarty.store` resolves the tenant `riyadh` and the `X-Tenant` header is ignored. The header is the fallback for the apex domain and for local dev, where there are no subdomains. Six names are reserved and treated as apex: `www`, `app`, `api`, `admin`, `static`, `assets`. The same list is duplicated client-side in `apps/web/src/lib/tenant.ts`.

The rationale is that a URL is visible and shareable; a header is not. If two things can name the workspace, the one the user can see should win.

### Session storage is cookie-first, and that is deliberate

`apps/web/src/lib/api.ts` and `lib/tenant.ts`. Four session keys (`qvm_token`, `qvm_ws`, `qvm_env`, `qvm_real_token`) are written to **both** `localStorage` and a cookie scoped to `.<rootDomain>` (`SameSite=Lax`, `max-age` 24h, `Secure` on https), and read **cookie-first**. localStorage is per-origin, and "view as" plus workspace switching routinely hop between the apex and a workspace subdomain — a stale same-origin copy would otherwise outrank the value just written on the other origin.

The environment key matters most here. The comment in `api.ts` is explicit: a localStorage-only copy silently reverted to Live on every hop, and reverting to Live is the one direction that must never happen by accident.

`setSharedCookie` is a no-op on localhost (`rootDomain()` returns null), so local dev is pure localStorage.

### The server is the authority on environment

`GET /api/me` echoes back `environment: ctx.environment` — the value the **server** resolved, not the one the browser sent (`apps/api/src/modules/me/me.controller.ts`). `apps/web/src/lib/auth.tsx`, `loadMe()`, compares it against the local belief and overwrites the local one on disagreement. Without this a stripped or misspelled header would leave the UI showing a Sandbox banner while writes went to Live.

### Cross-workspace targeting

`ReqOpts.tenant` in `apps/web/src/lib/api.ts` aims a single request at another workspace without switching the app into it. Platform staff administer many workspaces from one screen (the flow builder was the first case), and forcing a subdomain hop per workspace loses the admin sidebar every time. This widens no access: `AuthGuard` still requires a real membership or link for everyone who is not platform staff.

### Failure handling in the client

`apps/web/src/lib/auth.tsx` distinguishes "the server had a moment" from "your credentials are bad". A status of `0` (fetch never reached the server) or `>= 500` triggers up to five retries with linearly increasing backoff (`2000 * (attempt + 1)` ms) and **keeps the session**. Anything else is treated as an auth failure and recovered in the least destructive order: return from impersonation → drop a bad subdomain and retry on the apex → log out. The comment records why: an API restart during a deploy used to sign everyone out mid-session and, because the environment is part of the session, silently drop them back to Live.

---

## 3. Bootstrap — what is and is not configured

`apps/api/src/main.ts` is 17 lines:

```ts
const app = await NestFactory.create(AppModule, { cors: true });
app.setGlobalPrefix("api");
app.useGlobalFilters(new ZodExceptionFilter());
await app.listen(Number(process.env.API_PORT ?? 4000));
```

Stated plainly, because omissions matter as much as inclusions:

- **`cors: true` allows all origins.** There is no allowlist anywhere.
- **There is no global guard.** No `APP_GUARD` provider, no `useGlobalGuards`. Authentication is opt-in per controller. Verified by grep: `APP_GUARD` does not appear in `apps/api/src`. This contradicts Backend rule 2 in `docs/CONVENTIONS.md` ("every endpoint behind an explicit guard — no endpoint open by default").
- **There is no `ValidationPipe`,** and that is deliberate — the comment on line 7 points at `CONVENTIONS §BE-4`. Validation is a zod `.parse()` at each controller boundary.
- **There is no helmet, no rate limiter, no cookie-parser.** Grep returns nothing for any of them.

The single global filter is `ZodExceptionFilter`.

### JWT configuration

`apps/api/src/modules/auth/auth.module.ts` registers `JwtModule` with `global: true`, so `JwtService` is injectable anywhere. Its `jwtSecret()` helper throws if `JWT_SECRET` is unset **and** `NODE_ENV === "production"`; outside production it falls back to a hardcoded development string. Token TTL comes from `JWT_EXPIRES_IN`, default `1d`. Impersonation tokens get their own TTL from `IMPERSONATION_TTL`, default `30m` (`modules/admin/impersonation.service.ts`) — a variable that is read in code but absent from `.env.example`.

---

## 4. The request lifecycle

### The diagram

```
                          BROWSER  (apps/web)
                          ─────────────────────────────────────────
                          lib/api.ts  request()
                            authorization: Bearer <jwt>
                            x-tenant:      <slug>        (apex/dev fallback)
                            x-environment: live|sandbox  (always sent)
                                       │
                                       │  https://<slug>.<root>/api/...
                                       ▼
                          nginx  →  serves SPA, proxies /api   (not in repo)
                                       │
  ══════════════════════════════════════▼══════════════════════════════════════
                          API  (apps/api)  —  setGlobalPrefix("api")
                                       │
   ┌───────────────────────────────────▼────────────────────────────────────┐
   │ 1. AuthGuard.canActivate            src/common/auth.guard.ts           │
   │    a. Bearer present?                          → 401 missing token     │
   │    b. jwt.verifyAsync → { sub, imp?, impTenant? } → 401 invalid token   │
   │    c. resolveTenantSlug(req)  subdomain ≫ X-Tenant                     │
   │    d. ── TRANSACTION #1  withContext({tenantId:null, isInternal:true}) │
   │         users.is_active(sub)                   → 401 deactivated       │
   │         users.is_active(imp)   if impersonating → 401 deactivated      │
   │         platform_members       → platformRole / isInternal             │
   │         ── only if a slug was resolved: ──                             │
   │         tenants ⟕ tenant_memberships (by slug) → tenantId, role        │
   │         else vendor_users ⋈ tenant_vendors        (link check)         │
   │         else workshop_users ⋈ tenant_workshops    (link check)         │
   │         else service_provider_users ⋈ tenant_service_providers         │
   │       ── COMMIT (GUCs discarded with the tx)                           │
   │    e. build RequestContext { userId, tenantSlug, tenantId, role,       │
   │         isInternal, platformRole, environment, impersonatorId }        │
   │    f. impTenant ≠ tenantId ?                   → 403 view-as confined  │
   │    g. slug requested but no access ?           → 403 no access         │
   │    h. req.ctx = ctx                                                    │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 2. RolesGuard.canActivate           src/common/roles.guard.ts          │
   │    @PlatformOnly()  → ctx.isInternal or 403                            │
   │    @Roles(a,b,c)    → isInternal passes; else ctx.role ∈ list or 403    │
   │    neither          → any authenticated caller; RLS is the only scope   │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 3. Controller                                                          │
   │    schema.parse(body)              zod → ZodError → 400 (global filter) │
   │    requireTenantCtx(req)  /  openCtx(req)      src/common/request-…    │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 4. Service → DbService.withContext(ctx, work)   src/db/db.service.ts   │
   │    ── TRANSACTION #2, connected as role qvm_app (NON-superuser)        │
   │       select set_config('app.tenant_id',       …, true),               │
   │                        ('app.user_id',         …, true),               │
   │                        ('app.is_internal',     …, true),               │
   │                        ('app.environment',     …, true),               │
   │                        ('app.impersonator_id', …, true)                │
   │       ↑ third arg = true → TRANSACTION-LOCAL; cannot leak across the   │
   │         pooled connection (postgres(url, { max: 10 }))                 │
   │       work(tx)  — drizzle queries, mostly WITHOUT any tenant_id filter  │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ 5. PostgreSQL 16 enforces                                              │
   │    current_tenant_id() / app_user_id() / app_is_internal()   0001      │
   │    current_environment()                                     0041      │
   │                                                                        │
   │    tenant_isolation      PERMISSIVE                                    │
   │      tenant_id = current_tenant_id() OR app_is_internal()              │
   │    environment_isolation RESTRICTIVE   ← AND-ed, survives the OR-escape │
   │      environment = current_environment()                               │
   │    global_read / global_write            (tables with no tenant_id)    │
   │                                                                        │
   │    BEFORE INSERT/UPDATE  trg_set_row_audit                             │
   │      created_by / updated_by ← app_user_id(), never from the body      │
   └───────────────────────────────────┬────────────────────────────────────┘
                                       ▼
                          COMMIT — GUCs die with the transaction
                                       │
                          plain JSON response (no envelope)
```

### Step 1 — `AuthGuard` (`apps/api/src/common/auth.guard.ts`, 161 lines)

The guard's job is to turn a bearer token plus a hostname into a `RequestContext`. Three things about it are worth understanding.

**Deactivation takes effect immediately, not at token expiry.** `users.is_active` is re-read on every single request. When the token carries an `imp` claim (impersonation), the **impersonator's** row is checked too — a borrowed session dies the moment the real actor is deactivated.

**The bootstrap lookups run as internal.** They open a transaction with `{ tenantId: null, userId, isInternal: true }` because these queries *precede* tenant scoping: you cannot scope by a tenant you have not resolved yet. This is a genuine privilege escalation window, narrowed by keeping the block to a fixed, short list of identity queries and nothing else.

**Access is resolved through four independent paths**, tried in order. All four require a slug to have been resolved and a matching active tenant row; the vendor/workshop/provider checks only run when the membership lookup produced no role.

| Path | Query | Resulting `ctx.role` |
|---|---|---|
| membership | `tenants ⟕ tenant_memberships` on slug, `is_active` | the membership role |
| vendor link | `vendor_users ⋈ tenant_vendors` where `status = 'active'` | `"vendor"` |
| workshop link | `workshop_users ⋈ tenant_workshops` where `status = 'active'` | `"workshop"` |
| provider link | `service_provider_users ⋈ tenant_service_providers` where `status = 'active'` | `"service_provider"` |

Falling through all four leaves `ctx.role` as the platform role. `ctx.isInternal` is set purely by the presence of an active `platform_members` row.

Two refusals happen after the context is built:

- **Impersonation containment.** If the token carries `impTenant` (stamped by `ImpersonationService` when a `company_admin` grants a view-as) and the resolved `tenantId` differs, 403. Without it the actor would inherit every workspace the *target* belongs to — including ones the actor has no access to. `impersonation.service.ts` also refuses to let a `company_admin` impersonate a platform account, because the guard derives `isInternal` from the token's `sub`.
- **Workspace gate.** If a slug was requested, the tenant must exist and be active, and the caller must be internal, a member, or hold one of the three links.

**Cost.** This block is a full transaction issuing between two and seven queries (2 with no slug; 7 with a slug, an impersonation claim, and fall-through to the provider check), and it is separate from the transaction the service later opens. A typical authenticated request therefore opens **at least two Postgres transactions**. Nothing caches it.

### Step 2 — `RolesGuard` (`apps/api/src/common/roles.guard.ts`, 35 lines)

Three cases, read from handler-then-class metadata via `Reflector.getAllAndOverride`:

| Decorator | Rule |
|---|---|
| `@PlatformOnly()` | requires `ctx.isInternal`. A membership role can never satisfy it. |
| `@Roles("a", "b")` | platform staff pass unconditionally; everyone else needs `ctx.role` in the list. |
| neither (or an empty list) | any authenticated caller passes. RLS is the only remaining scope. |

**Why `@PlatformOnly` exists as a separate decorator** rather than `@Roles("super_admin")`: the `membership_role` and `platform_role` Postgres enums share five value names — `super_admin`, `staff`, `account_manager`, `purchasing`, `part_extractor` (`apps/api/drizzle/schema/enums.ts`). A tenant membership carrying the string `super_admin` would satisfy a `@Roles("super_admin")` check. The comment in `roles.decorator.ts` states the rule for new code: **never list a platform-tier role name in `@Roles`.**

**Guard coverage**, counted across all 33 `@Controller` classes:

| Guards | Count | Which |
|---|---|---|
| `AuthGuard, RolesGuard` | 24 | the domain and admin controllers |
| `AuthGuard` only | 7 | `me`, `account`, `workspaces`, `admin/impersonate`, `vendor`, `workshop`, `provider` |
| **none** | 2 | `auth` (public login/signup), `quote-access` (public, token-gated) |

The seven `AuthGuard`-only controllers are not an oversight. The portals derive ownership inside the service — `requireCounterparty(tx, userId, "vendor")` returns the caller's `vendor_id` and everything is filtered by it — so a route-level role check would add nothing. `admin/impersonate` has mixed authority (platform staff and `company_admin` can both use it, under different rules) and enforces it in the service.

Note that `@PlatformOnly()` is used far more at method level than at class level. Only three controllers carry it on the class (`admin/workspaces`, `admin/platform`, `admin/workflows`); the rest sprinkle it per route — `vendors`, `providers`, `shipping`, `pricing`, `insurance`, `counterparty`, `parts`, `purchasing`, `delivery`, `invoicing`, `returns`, `approvals`, `vendor-finance`, `vendor-assignment`, `infra`, `org`, `rfq`, `vendor-selfservice`.

### Step 3 — the controller

Controllers do two things. Example, `apps/api/src/modules/rfq/rfq.controller.ts`:

```ts
@Post()
@Roles("company_admin", "branch_manager", "service_advisor")
create(@Req() req: Request, @Body() body: unknown) {
  const dto: CreateRfqDto = createRfqSchema.parse(body);
  return this.rfq.create(requireTenantCtx(req), dto);
}
```

Note `@Body() body: unknown` — the DTO type comes from `z.infer`, so there is one definition of the shape and it is enforced at runtime.

Two context helpers live in `request-context.ts`:

- `requireTenantCtx(req)` — throws 400 `"no workspace resolved (subdomain / X-Tenant)"` if `tenantId` is null.
- `openCtx(req)` — tolerates a null tenant, for platform-staff global reads.

Both forward `environment` and `impersonatorId` explicitly so a controller cannot silently drop them. (`VendorSelfServiceController` hand-rolls the same object in a private `ctx()` method instead of calling `requireTenantCtx` — same shape, one more copy.)

One pattern worth copying: `RfqController.list` and `.detail` spread `{ ...requireTenantCtx(req), isInternal: false }`. Platform staff are deliberately forced back into single-workspace scope for list views. "See all workspaces" is the workspace switcher, not a merged list. `WorkspacesController.branches()` does the same.

### Step 4 — `DbService.withContext` (`apps/api/src/db/db.service.ts`)

```ts
async withContext<T>(ctx: RlsContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return this.db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id',       ${ctx.tenantId ?? ""},              true),
      set_config('app.user_id',         ${ctx.userId ?? ""},                true),
      set_config('app.is_internal',     ${ctx.isInternal ? "true":"false"}, true),
      set_config('app.environment',     ${ctx.environment ?? "live"},       true),
      set_config('app.impersonator_id', ${ctx.impersonatorId ?? ""},        true)`);
    return work(tx as unknown as Tx);
  });
}
```

The third argument to `set_config` is `true`, meaning **transaction-local**. This is not cosmetic: the driver pools ten connections (`postgres(url, { max: 10 })`), and a session-level `SET` would survive the transaction and be inherited by whichever request picked up that connection next. Transaction-local scoping makes leakage structurally impossible.

`app.impersonator_id` is set on every transaction and **nothing reads it**. `grep -rn "app.impersonator_id" apps/api/drizzle/` returns no hits. The inline comment is honest about this: it is reserved for future DB-side audit triggers; today the application writes `impersonator_id` explicitly where it needs it.

### Step 5 — Postgres

Session helper functions, all declared `SET search_path = ''` so a hostile `search_path` cannot shadow them:

| Function | Migration | Definition |
|---|---|---|
| `current_tenant_id()` | `0001_security_functions.sql` | `nullif(current_setting('app.tenant_id', true), '')::uuid` |
| `app_user_id()` | `0001` | same shape for `app.user_id` |
| `app_is_internal()` | `0001` | `coalesce(current_setting('app.is_internal', true), 'false') = 'true'` |
| `current_environment()` | `0041_environment_rls.sql` | `coalesce(nullif(current_setting('app.environment', true), ''), 'live')::environment_type` |

Three policy families:

| Family | Predicate | Kind | Applied by |
|---|---|---|---|
| `tenant_isolation` | `tenant_id = current_tenant_id() OR app_is_internal()` (USING and WITH CHECK) | permissive | `apply_tenant_rls()` — defined in `0010_rls_helpers.sql`, rewritten in `0041` |
| `global_read` / `global_write` | read `USING (true)`; write `app_is_internal()` | permissive | `apply_global_rls()` — `0010` |
| `environment_isolation` | `environment = current_environment()` (USING and WITH CHECK) | **restrictive** | `apply_environment_rls()` — `0041` |

`0001` predates the helpers: it applies the same two policy families with two one-shot `DO $$` loops over `information_schema`, and installs the audit triggers the same way.

**Why the environment policy had to be RESTRICTIVE** is the sharpest reasoning in the schema, spelled out at the top of `0041_environment_rls.sql`. Permissive policies are OR-ed. `tenant_isolation` contains `OR app_is_internal()`, and the cross-workspace vendor, workshop and provider portals legitimately run as internal. A permissive environment predicate would therefore be short-circuited by exactly the escape hatch used in the places where the Live/Sandbox boundary matters most. Restrictive policies are AND-ed with the permissive set, so the boundary holds unconditionally.

`current_environment()` defaults an unset GUC to `'live'`. This is a deliberate fail-open-to-real: a forgotten header can never widen access, only land you where you already were.

`apply_tenant_rls()` was rewritten in `0041` so that **any table carrying an `environment` column gets the restrictive policy automatically**. That single line is what prevents a future operational table from silently joining the system without the boundary. Note `apply_global_rls()` was *not* given the same treatment — global tables carry no `environment` column today, so nothing is missing, but the asymmetry is worth knowing.

Two triggers are attached the same way (`0001`, and re-attached by both helpers in `0010`):

- `set_row_audit()` — BEFORE INSERT OR UPDATE on every table with `updated_by`. On INSERT it fills `created_by` from `app_user_id()`. On UPDATE it **restores** `old.created_at` and `old.created_by` and sets `updated_by` from the session. The author comes from the session GUC, never from the request body — this is the fix for the old system's spoofable audit identity.
- `set_created_by()` — BEFORE INSERT on tables that have `created_by` but no `updated_by` (append-only logs, where an `updated_by` would be meaningless).

Document numbering uses `next_order_number(tenant, prefix, region [, environment])`, an `INSERT … ON CONFLICT DO UPDATE … RETURNING` that replaces the old `MAX()+1 FOR UPDATE` pattern. Defined in `0001`; `0040_environment_isolation.sql` **drops and replaces** it (not overloads — a 3-arg call would become ambiguous) with a 4-arg version whose counter key is `(tenant_id, prefix, environment)`, so a sandbox test can never burn a live order number. Sandbox numbers get a visible `SBX-` infix.

### Consequence: services rarely filter by tenant

Because RLS is the boundary, service queries mostly omit `tenant_id` entirely. From `apps/api/src/modules/rfq/rfq.service.ts`, the branch lookup inside `create`:

```sql
from workshop_branches wb
join workshops w  on w.id = wb.workshop_id
join tenant_workshops tw on tw.workshop_id = wb.workshop_id and tw.status <> 'archived'
```

There is no `tenant_id` predicate. `tenant_workshops` is tenant-scoped, so the policy on that table supplies it. This is the intended style. It is also why section 5 matters so much.

---

## 5. Why the API connects as `qvm_app`, and what breaks if it does not

`DbService` reads **`APP_DATABASE_URL`**, which must point at the `qvm_app` role. Migrations, the seed, and `verify-rls.ts` use **`DATABASE_URL`**, which points at the owner. Two variables, two roles, on purpose.

`qvm_app` is created in `apps/api/drizzle/migrations/0002_app_role.sql` as a plain login role with no special attributes — not a superuser, not the owner of any table. It is granted `SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE, SELECT` on sequences and `EXECUTE` on functions, plus matching default privileges for future objects.

**PostgreSQL exempts two kinds of role from row-level security:**

1. Superusers, and any role with `BYPASSRLS`, ignore all policies.
2. A table's **owner** is exempt from its own policies — unless the table has `FORCE ROW LEVEL SECURITY`.

Case 2 is why `apply_tenant_rls()` issues both `ENABLE` and `FORCE ROW LEVEL SECURITY` on every tenant table.

Case 1 is the one that has no defence in the database. If `APP_DATABASE_URL` is ever pointed at the owner or a superuser:

- Every `tenant_isolation` policy stops applying. Cross-tenant reads and writes succeed.
- Every `environment_isolation` policy stops applying. Sandbox sessions read and mutate Live rows.
- `global_write`'s `app_is_internal()` check stops applying.
- **Nothing errors.** No log line, no exception, no failed request. Queries that were being silently narrowed simply return more rows. Because the services do not carry their own `WHERE tenant_id = ?` clauses, there is no second layer to catch it.

This is the single highest-consequence configuration fact in the system. It is stated in the header comment of `db.service.ts`, in `0002_app_role.sql`, and in Database rule 2 of `docs/CONVENTIONS.md`.

### The backstop

`apps/api/scripts/verify-rls.ts` (run as `pnpm --filter @qvm/api db:verify`, and by `deploy.sh` at step 4, before the new web bundle and API restart) exits 1 if any `public` base table:

1. has RLS disabled;
2. has RLS enabled but **zero** policies — which silently blocks `qvm_app` entirely, an outage rather than a leak;
3. carries `tenant_id` without `FORCE ROW LEVEL SECURITY`, or without a policy whose `qual`/`with_check` mentions `current_tenant_id`;
4. carries `environment` without a **RESTRICTIVE** policy mentioning `current_environment` (one hard-coded exemption, `order_number_counters`).

Its header names the incident that motivated it: the policy loop in `0001` was one-shot and covered only the tables that existed at that moment. `platform_audit` was created later by `0029` with no RLS at all, and `qvm_app` had unrestricted cross-tenant read, write and delete on the impersonation audit ledger until `0034_audit_hardening.sql` closed it (`pa_read` internal-only select, `pa_insert` internal-or-own-tenant, and deliberately **no** update/delete policy).

The check does not, and cannot, catch a misconfigured `APP_DATABASE_URL`.

### Where the blanket policies were narrowed

`global_read USING (true)` is correct for `car_brands`. It was wrong for tables holding personal data, and three migrations replaced it in specific places:

| Migration | Table(s) | New policy | Predicate |
|---|---|---|---|
| `0032_individual_read_privacy.sql` | `vendors`, `workshops` | `directory_read` | company rows public; individual rows only to internal or a linked workspace |
| `0038_service_providers.sql` | `service_providers` | `directory_read` | same shape, via `tenant_service_providers` |
| `0045_user_read_privacy.sql` | `users` | `user_self_or_internal_read` | internal, or your own row |
| `0045` | `platform_members` | `platform_member_internal_read` | internal, or your own membership |

`0032` and `0045` carry the same warning in capitals: **do not re-run `apply_global_rls()` on these tables** — it would recreate the permissive `global_read` and reopen the hole. This is a real trap for anyone adding a column to `users` and reaching for the standard helper.

`0045`'s header is also explicit about what it did *not* fix: `vendor_users`, `workshop_users` and `service_provider_users` still leak the person↔company mapping to any authenticated session. They are read from 17 files including the shared counterparty helper, so narrowing them was left to its own verification pass. That gap is still open.

---

## 6. Module map

`apps/api/src/app.module.ts` (141 lines) imports four global modules plus `AuthModule` and `WorkflowModule`, then registers **31 controllers and 29 providers flat on the root module**. Only `auth` and `workflow` are real Nest sub-modules; every other directory under `src/modules/` is a controller/service pair wired directly into `AppModule`. This contradicts Backend rule 1 in `docs/CONVENTIONS.md` ("a module per domain") and is the main structural debt in the API. It works because the four cross-cutting services are `@Global()`, so nothing needs per-module import wiring.

### Global modules

| Module | File | Exports |
|---|---|---|
| `DbModule` | `src/db/db.module.ts` | `DbService` (`@Global`) |
| `NotificationsModule` | `src/modules/notifications/notifications.module.ts` | `NotificationsService` (`@Global`) |
| `StatusModule` | `src/common/status.module.ts` | `StatusService` (`@Global`) |
| `AiModule` | `src/common/ai.module.ts` | `AiService` (`@Global`) |
| `AuthModule` | `src/modules/auth/auth.module.ts` | `AuthGuard`, `RolesGuard`; registers `JwtModule` globally |

`WorkflowModule` is a plain (non-global) module holding `WorkflowController` + `WorkflowService`.

### Domain modules

There are 29 directories under `src/modules/`, but `admin/` holds four controller/service pairs, so the route surface is wider than the directory count. Base routes below come from the `@Controller()` decorators (five controllers declare `@Controller()` with no prefix and put the full path on each method); the gate column is the class-level guard.

| Module | Base route(s) | Gate | What it is |
|---|---|---|---|
| `auth` | `/auth` | none (public) | argon2 login + counterparty self-registration |
| `me` | `/me` | Auth | current user, resolved workspace/role, persona, server-resolved environment |
| `workspaces` | `/workspaces`, `/workspaces/branches` | Auth | every workspace the caller can reach (see caveat below) |
| `account` | `/account` | Auth | counterparty self-service: activate, upgrade individual → company |
| `admin/workspaces-admin` | `/admin/workspaces` | Auth+Roles+`@PlatformOnly` (class) | tenant CRUD, link/unlink counterparties |
| `admin/users-admin` | `/admin/users` | Auth+Roles | members inside one workspace |
| `admin/platform-staff` | `/admin/platform` | Auth+Roles+`@PlatformOnly` (class) | Qparts' own staff + global people directory |
| `admin/impersonation` | `/admin/impersonate` | Auth | "view as"; authority is mixed, so enforced in the service |
| `rfq` | `/rfqs` | Auth+Roles | entry point of the order chain |
| `rfq/quote-access` | `/quote-access/:token/quote` | **none** | public, token-gated vendor quote submission |
| `orders` | `/rfqs/:id/confirm`, `/orders` | Auth+Roles | confirm an RFQ into an order |
| `purchasing` | `/orders/:id/purchase-orders`, `/purchase-orders` | Auth+Roles | group confirmed lines into one PO per vendor (two controller classes) |
| `delivery` | `/orders/:id/deliveries` | Auth+Roles | partial/split delivery |
| `invoicing` | `/orders/:id/invoice` | Auth+Roles | client invoice |
| `returns` | `/orders/:id/returns`, `/returns/:returnId/credit-note` | Auth+Roles | returns and credit notes |
| `vendors` | `/vendors` | Auth+Roles | global vendor directory + per-workspace links |
| `providers` | `/providers` | Auth+Roles | service providers (shipping, inspection, claims) |
| `org` | `/org` | Auth+Roles | workshops, branches, regions, cities |
| `counterparty` | `/counterparty` | Auth+Roles | governed onboarding: submit → match → review queue |
| `vendor-portal` | `/vendor` | Auth | cross-workspace vendor self-service (6 routes) |
| `workshop-portal` | `/workshop` | Auth | cross-workspace workshop self-service (7 routes) |
| `provider-portal` | `/provider/overview` | Auth | one endpoint |
| `vendor-selfservice` | `/vendor-selfservice` | Auth+Roles | stock upload, pricing policies, price resolution |
| `vendor-finance` | `/vendor-finance` | Auth+Roles | vendor payments, statements, financing |
| `vendor-assignment` | `/vendor-selection-rules`, `/rfqs/:id/suggested-vendors` | Auth+Roles | rule-based vendor suggestion |
| `pricing` | `/pricing` | Auth+Roles | pricing basis per payer scenario |
| `insurance` | `/insurance/companies`, `/rfqs/:id/payer`, `/rfqs/:id/insurance/*` | Auth+Roles | insurer as payer, approval round-trip |
| `parts` | `/parts` | Auth+Roles | parts master data; exports `cleanPartNumber` |
| `shipping` | `/shipping` | Auth+Roles | carriers, shipments, drivers |
| `approvals` | `/approvals` | Auth+Roles | multi-level approval policies and requests |
| `infra` | `/audit-log`, `/calendar/*` | Auth+Roles | append-only audit + working-day calendar |
| `workflow` | `/admin/workflows` | Auth+Roles+`@PlatformOnly` (class) | the workflow engine authoring surface |
| `notifications` | — | — | global service only, no controller |

Three controllers deserve a note.

**`WorkflowController`** carries `@PlatformOnly()` at the class level, and `WorkflowService.requireSuperAdmin()` additionally checks `ctx.platformRole === "super_admin"` on every write (`create`, `saveGraph`, `activate`, `retire`, `newVersion`, `remove`, `assist`). The split is stated in the file: platform staff may *look*, only a super admin may *change*.

**`VendorSelfServiceController`** has a class comment saying it is "Gated @PlatformOnly for now (internal manages on behalf); full vendor-role self-service opens once vendor-user auth is wired into the guard." In practice `@PlatformOnly()` sits on all four of its routes individually, not on the class — same effect today, but a new route added without the decorator would be open to any authenticated caller.

**`WorkspacesController.list()`** claims to return every reachable workspace, but its `UNION` covers only four sources: platform staff, `tenant_memberships`, `vendor_users → tenant_vendors`, and `workshop_users → tenant_workshops`. **Service-provider users are missing.** `AuthGuard` will let a provider user into a workspace they are linked to, but the switcher will not list it. Response shape is `{ count, workspaces }`.

### The schema layer

`apps/api/drizzle/schema/` holds 28 files: a barrel (`index.ts`), a column-builder file (`_shared.ts`), an enums file (`enums.ts`), and 25 domain files. `drizzle.config.ts` reads the barrel. There are 50 journalled migrations, `0000`–`0049` (verified against `migrations/meta/_journal.json`: 50 entries, zero orphans).

**RLS is applied by hand-written SQL, not by Drizzle.** Drizzle generates the DDL; every migration that adds a table must call `apply_tenant_rls()` or `apply_global_rls()` itself. `0001` was a one-shot loop over `information_schema` and covers only what existed then — its header says so. `verify-rls.ts` is the backstop for forgetting.

`deploy.sh` adds a second backstop: a Python pre-flight that diffs the `.sql` files on disk against `meta/_journal.json` and aborts the deploy on any orphan. Drizzle only opens journalled files and still exits 0, so a forgotten journal entry would otherwise ship as a green deploy against an unaltered schema.

---

## 7. `src/common` — what each file is the single point of

Thirteen files, 932 lines total. Each one exists because the same logic was previously written more than once, and the differences between copies were bugs.

| File | Lines | Single point of |
|---|---|---|
| `auth.guard.ts` | 161 | turning a token + hostname into a `RequestContext` |
| `roles.guard.ts` | 35 | route-level role checks |
| `roles.decorator.ts` | 18 | `@Roles(...)` and `@PlatformOnly()` metadata keys |
| `request-context.ts` | 67 | the context type, subdomain resolution, environment resolution, and the two `…Ctx(req)` extractors |
| `env-guards.ts` | 28 | the Live/Sandbox check on a document loaded for write |
| `tenant-target.ts` | 15 | deciding which workspace a write is *for* |
| `counterparty.helpers.ts` | 34 | resolving a user's vendor/workshop/provider identity |
| `rfq-guards.ts` | 9 | refusing a mutation on an already-confirmed RFQ |
| `zod-exception.filter.ts` | 17 | turning a `ZodError` into a 400 |
| `status.service.ts` | 337 | **every** status-column write, and the workflow guard |
| `ai.service.ts` | 195 | **every** outbound model call |
| `status.module.ts` / `ai.module.ts` | 9 / 7 | `@Global()` wrappers |

### `env-guards.ts` — 404, not 403

```ts
if (!row || row.environment !== envOf(ctx))
  throw new NotFoundException(`${what} not found in this workspace`);
```

The message is **identical** for "does not exist" and "exists in the other environment". The comment gives the reason: a 403 would confirm the row exists, letting a Sandbox session enumerate real Live document ids. Reads are filtered by the RLS predicate; writes are guarded here, so the two directions cannot drift apart.

### `counterparty.helpers.ts` — one precedence order

`resolveCounterparty(tx, userId)` returns `{ kind, entityId }` with a fixed precedence: vendor → workshop → service provider. `/me` uses it to compute the persona; the three portals use `requireCounterparty(tx, userId, kind)` to derive the entity they filter by. Because both sides call the same function, the portal you land on and the data you can read cannot disagree. The comment records that this was "previously repeated five ways".

### `tenant-target.ts` — who may write where

```ts
export function targetTenant(ctx: RlsContext, dtoTenantId?: string): string
```

Platform staff may name any workspace in the request body; everyone else is pinned to their active one (403 otherwise). Previously duplicated in `VendorsService` and `CounterpartyService`.

### `status.service.ts` — the status-write gateway

This is the most consequential file in `common/`. Its header states what it replaced: **22 direct status-column writes across 8 services**, and a fully designed `status_logs` table with zero writers and zero rows. That gap is why stage-speed reporting, early-vs-late cancellation classification, and "reject a cancellation and restore the previous status" had no data source.

`ENTITIES` names the ten tables it may write and which vocabulary each speaks (`item` for nine — `rfqs`, `rfq_items`, `orders`, `order_items`, `purchase_orders`, `deliveries`, `returns`, `invoices`, `credit_notes`; `vendor` for `rfq_vendors`).

`transitionMany()`, the core:

1. resolve the code to an id — an unknown code is a 400, not a silent no-move;
2. read the current `status_id` **before** the write, so `from_status_id` in the log is real;
3. refuse the whole batch if any id is missing, rather than moving a subset;
4. filter to rows that genuinely change — a self-transition writes no log row, so history is a record of actual movement;
5. call the workflow guard;
6. one `UPDATE … where id in (…)`;
7. one `INSERT INTO status_logs` per moved row, with `changed_by` from `ctx.userId`.

The ordering argument in the header is the transferable lesson: the 22 write sites were collapsed into one function **before** the workflow rule engine was added, so the rule lives in one place rather than twenty. "A rule engine bolted onto one of twenty paths enforces nothing."

`effectiveRoles()` re-reads `tenant_memberships ∪ platform_members` from the database on every permission check rather than trusting `ctx.role`. The reason is stated: `AuthGuard` picks **one** role with an unordered `limit 1`, which is fine for coarse route gating but wrong for a rule naming either of two roles a user holds.

`assertTransitionAllowed()` is the workflow guard. Four design decisions matter:

- **Permissive until configured.** With no active default flow and no flow binding on the record, it returns silently and the system behaves exactly as it did before the engine existed. Enforcement switches on per workspace the moment an admin activates a flow, and only for records that entered under it. Any other rollout would have frozen live orders on ship day. A record whose *current* status is not a step in the flow is also let through — you cannot judge a move you have no map for.
- **Records bind to a flow version and never migrate.** The final `ON CONFLICT DO UPDATE` on `workflow_record_state` deliberately does not update `flow_id`. Publishing a new version cannot strand an in-flight order.
- **Two independent role gates**, the step's `owner_roles` and the edge's `allowed_roles`. An empty list is silence, not denial. `super_admin` bypasses both — break-glass for a workspace that restricted a step to a role nobody holds.
- **Custody is recorded, not just permitted.** The edge's `handoff` value (`pool` / `keep` / `actor`) decides who holds the record after the move, and a pooled record with exactly one eligible owner is auto-assigned. `step_entered_at` and `due_at` (from the step's `sla_hours`) are written on the same row.

Performance note: the guard runs **per record**, issuing roughly four to seven queries each. `transitionMany`'s batching stops at the UPDATE; both the guard and the log insert are per-row loops.

**Known bypasses.** Two writes to a status column exist outside this gateway:

- `modules/insurance/insurance.service.ts` line 100 does a raw `update rfqs set status_id = …`. It has its own hand-written state machine, but the move produces no `status_logs` row and is not checked against the workspace's workflow.
- `modules/rfq/vendor-rfq.service.ts` sets `status_id` in an `INSERT … ON CONFLICT` on `rfq_vendor_items`. That entity is not in the `ENTITIES` map at all, so its status has no gateway; this is a creation-time stamp rather than a transition. The same function then calls `status.transitionMany` for the `rfq_vendor` row, which is in the map.

Also note `history()`: its joins resolve `item_statuses` only, so a `vendor`-domain log row comes back with null `from_code` / `to_code`.

### `ai.service.ts` — the model boundary

Provider comes from `AI_PROVIDER`. `enabled` returns true only when it is `gemini` **and** `GEMINI_API_KEY` is set; every other value, including the `claude` that `.env.example` advertises, returns false. The only injection site in the codebase is `WorkflowService` (`grep -rn "AiService"` → one hit outside `common/ai*`).

`json(system, user, schema)` posts to Gemini's `generateContent` with `responseMimeType: "application/json"`, a response schema, `temperature: 0.2` and a 30-second abort timeout. Two details are worth keeping:

- **Credential ambiguity is handled by retry.** The key is sent as a query parameter first and retried once as a bearer token on 400/401, because Google now issues API keys with an `AQ.` prefix that is indistinguishable from an OAuth token. Only `ya29.` is treated as unambiguously OAuth.
- **The provider's raw body is never surfaced to the caller** — some Google error shapes echo the API key back. Errors are translated into specific `ServiceUnavailableException` messages, including per-minute vs per-day quota (parsed out of the `QuotaFailure` `quotaId`), `API_KEY_INVALID` (which Google returns as a 400, not a 401), and `SERVICE_DISABLED`.

The service never touches the database, and its caller validates everything the model returns against the governed catalog before anything is persisted.

### `NotificationsService` — designed as a boundary, stubbed as an implementation

`src/modules/notifications/notifications.service.ts`, 79 lines. Architecturally it is the single side-effect boundary: Backend rule 3 in `docs/CONVENTIONS.md` forbids any other service from calling an external provider, and every attempt is written to `notification_log` inside the caller's transaction, so the log row commits or rolls back with the action that triggered it.

```ts
const providerLive =
  input.environment !== "sandbox" &&
  process.env.NODE_ENV === "production" &&
  this.providerEnabled(input.channel);
const status = providerLive ? "sent" : "suppressed";
await tx.insert(schema.notificationLog).values({ … });
if (status === "sent") {
  // real provider dispatch goes here (SMTP/WhatsApp/webhook), using `secret` for the link.
  void secret;
  this.logger.log(`SEND ${input.channel} → ${input.recipient} [${input.template}]`);
}
```

**Nothing is ever sent.** There is no SMTP, WhatsApp or HTTP client in `apps/api/package.json`. In production with `EMAIL_PROVIDER` set to anything other than `console`, the row is written with `status = 'sent'` and a log line is printed — `void secret` discards the payload. The concrete consequence: in production the emailed `/quote-access/:token` link, which is the only way a vendor without a portal account can quote, is generated, SHA-256 hashed into `rfq_vendors.token_hash`, and then thrown away. (`vendor-rfq.service.ts` does return the raw token in the API response outside production, as a dev/test convenience, so the flow is exercisable locally.)

One API detail is load-bearing. `NotifyInput.environment` is **required, not defaulted**, and the comment explains why: a default of `'live'` inside a Sandbox transaction writes a Live `notification_log` row, the restrictive `WITH CHECK` rejects it, and **the enclosing business transaction rolls back** — a failure that only ever appears in Sandbox, so Live tests never catch it. `AuditService.record` in `modules/infra/infra.service.ts` repeats the same reasoning for the same reason.

---

## 8. Error handling and response shapes

### Success

There is **no response envelope**. A controller returns whatever the service returns, serialized as JSON. Shapes are per-endpoint and ad hoc:

| Shape | Example |
|---|---|
| the created resource's identifiers | `RfqService.create` → `{ id, orderNumber, itemCount }` |
| a bare acknowledgement | `{ ok: true }` — 14 occurrences across 8 service files |
| a named collection with a count | `{ count, workspaces }`, `{ count, rfqs }`, `{ count, entries }` (`AuditService.query`) |
| a raw row array | several `list()` methods return the rows directly |

There is no pagination convention. Seven queries hard-code `limit 50` or `limit 100` with no cursor or total.

### Errors

All errors are Nest `HttpException` subclasses, so the wire format is Nest's default:

```json
{ "statusCode": 400, "message": "…", "error": "Bad Request" }
```

Thrown across `apps/api/src`:

| Exception | Status | Count | Typical use |
|---|---|---|---|
| `BadRequestException` | 400 | 95 | validation beyond zod, illegal state transitions, unknown status codes |
| `NotFoundException` | 404 | 36 | missing rows — **and wrong-environment rows**, see `env-guards.ts` |
| `ForbiddenException` | 403 | 25 | role and ownership refusals |
| `ConflictException` | 409 | 20 | uniqueness, mostly translated from `23505` |
| `ServiceUnavailableException` | 503 | 9 | all from `AiService` |
| `UnauthorizedException` | 401 | 4 | three in `AuthGuard`, one in `AuthService.login` |

**Zod errors** are the one custom shape. `ZodExceptionFilter` catches `ZodError` and returns `message` as an **array** of `"path: message"` strings:

```json
{ "statusCode": 400, "error": "Bad Request", "message": ["items: an RFQ needs at least one item"] }
```

Note the client-side consequence. `apps/web/src/lib/api.ts` does `new ApiError(res.status, data?.message ?? res.statusText)`, and `ApiError extends Error`. When `message` is an array, the `Error` constructor stringifies it, so a multi-issue validation failure surfaces in the UI as a comma-joined run-on string. Not a bug exactly, but not a designed message either.

**Unique-violation translation.** Eleven services catch Postgres error code `23505` and re-throw a `ConflictException` or `BadRequestException` with a domain message: `vendors`, `purchasing`, `auth`, `org`, `providers`, `shipping`, `counterparty`, `vendor-assignment`, `account`, `approvals`, `invoicing`. This is belt-and-braces: the service does a check-then-insert *and* catches the race that the check loses. The DB-side backstops came from two migrations — `0007_review_hardening.sql` added `orders_rfq_uq` (one order per RFQ); `0034_audit_hardening.sql` added `invoices_order_uq` and `purchase_orders_order_vendor_uq`.

**What is not handled.** Any other thrown error becomes a Nest 500 with no custom formatting. There is no request-id correlation, no structured logging (the codebase uses Nest's `Logger`; the one `console.log` is the startup banner in `main.ts`, with an eslint-disable on it), and no error-reporting integration.

---

## 9. Architectural gaps worth knowing on day one

Stated plainly, each verified against the file named.

| Gap | Evidence |
|---|---|
| **Notifications never dispatch.** Rows are logged as `sent` in production and nothing leaves the process. The vendor quote link is the visible casualty. | `modules/notifications/notifications.service.ts`; no mail/HTTP client in `apps/api/package.json` |
| **31 of 56 navigation destinations are placeholders.** `App.tsx` keeps an explicit `WIRED` set of 25 paths; every other nav path renders `<ComingSoon/>`. Includes `/reports`, `/invoices`, `/returns`, `/deliveries`, `/pricing`, `/statements`, and most of the vendor and provider portals. | `apps/web/src/App.tsx` (`WIRED`, `Placeholder`), `apps/web/src/nav.tsx` |
| **CORS is fully open; there is no rate limiting, no helmet.** | `src/main.ts`; grep |
| **No global guard.** An endpoint with no `@UseGuards` is fully public. Two exist today (both intentionally), but nothing structurally prevents a third by accident — and Backend rule 2 forbids it. | `app.module.ts`, grep for `APP_GUARD` |
| **`/workspaces` omits service-provider links.** A provider user can be authorised into a workspace by `AuthGuard` that the switcher will never list. | `modules/workspaces/workspaces.controller.ts` `list()` UNION |
| **`vendor_users` / `workshop_users` / `service_provider_users` are still world-readable** to any authenticated session, leaking the person↔company mapping. Explicitly deferred. | `0045_user_read_privacy.sql` header |
| **`app.impersonator_id` is written on every transaction and read by nothing.** | `db.service.ts`; grep of `drizzle/migrations` |
| **`packages/shared` is dead.** Declared dependency, zero imports; role enums duplicated by hand. | grep for `@qvm/shared` |
| **MinIO / S3 is provisioned and unused.** No upload path exists. | `infra/docker-compose.yml`, grep for `S3_` |
| **31 controllers live flat on `AppModule`.** Only `auth` and `workflow` are real Nest modules, contradicting Backend rule 1. | `app.module.ts` |
| **The web app has no lazy routes.** `App.tsx` statically imports all 34 page components, contradicting Frontend rule 1. | `apps/web/src/App.tsx`; `grep "lazy("` returns nothing |
| **Insurance status changes bypass `StatusService`** — no `status_logs` row, no workflow check. | `modules/insurance/insurance.service.ts:100` |
| **Two Postgres transactions per authenticated request**, with no caching of the `AuthGuard` bootstrap lookups. | `auth.guard.ts` + any service |
| **No unit tests, no CI, no linter config.** All testing is bash + curl + psql (`scripts/smoke.sh` — 88 checks, `guard-check.sh`, `smoke-prod.sh`, `verify-rls.ts`). The root `lint` script calls `pnpm --recursive lint`; no package defines one, and there is no eslint config anywhere. | `package.json`; no `.github/` |
| **Both READMEs are stale.** The root (Arabic) says the project is at "Phase 0 (foundation)"; `apps/api/README.md` describes `src/modules/` as containing only `auth/`, `me/`, `rfq/`. There are 29 module directories and 50 migrations. | file contents |
| **No module READMEs**, though documentation rule 3 requires one per module. `find apps/api/src -name "README*"` returns nothing. | `docs/README.md` rules |
| **ADR-0011 is cited in code but absent.** `rfq.service.ts`, `drizzle/schema/org.ts` and the seed reference it; `docs/decisions/` contains `0001`–`0010` and `0012`. | `ls docs/decisions` |

---

## 10. Running it locally

```bash
cp .env.example .env          # then fill in the secrets
corepack pnpm install
corepack pnpm db:up           # docker compose -f infra/docker-compose.yml up -d
corepack pnpm db:migrate      # drizzle-kit migrate, uses DATABASE_URL (owner role)
corepack pnpm db:seed         # tsx drizzle/seed/index.ts
corepack pnpm dev             # api on 4000, web on 5200, in parallel
```

Then, optionally: `pnpm --filter @qvm/api db:verify` (RLS invariants) and `pnpm --filter @qvm/api test:smoke` (re-seeds, then runs the 88-check suite — it will refuse to run against an API process older than your last edit).

Environment variables, **by name only** — never commit values. From `.env.example`:

`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `DATABASE_URL`, `APP_DATABASE_URL`, `API_PORT`, `NODE_ENV`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `APP_ROOT_DOMAIN`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `EMAIL_PROVIDER`, `WHATSAPP_ENABLED`, `PAYMENT_MODE`, `VITE_API_URL`, `AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`.

Read in code but **missing from `.env.example`**: `IMPERSONATION_TTL` (`modules/admin/impersonation.service.ts`), `SMOKE_BASE` (`scripts/smoke.sh`), and the deploy-only variables consumed by `deploy.sh` — `QVM_HOST`, `QVM_REMOTE`, `PROD_SSH`, `SMOKE_ADMIN_PASS`, `SMOKE_MANAGER_PASS`.

The two that decide whether the security model works:

- **`DATABASE_URL`** — the owner role. Migrations, seed, and `verify-rls.ts` only.
- **`APP_DATABASE_URL`** — the `qvm_app` role. The running API, always. See section 5.

`APP_ROOT_DOMAIN` defaults to `qvm.localhost` in `auth.guard.ts`. On plain `localhost` there are no subdomains, so `resolveTenantSlug` falls through to the `X-Tenant` header and everything is header-driven.

### Deploying

`deploy.sh` is the only supported path, and its header explains why in blunt terms: a hand-written `rsync -az --delete` once wiped `pgdata/`, `apps/api/start.sh` and `.env` from the server, destroying the database. The script, in order: backs up (`pg_dumpall --roles-only` **and** `pg_dump` — a data-only dump restores rows but not the `qvm_app` role, and drizzle will not recreate it because `0002` is already journalled), rsyncs with an exclusion list, installs from the frozen lockfile on the server, checks for orphaned migrations, migrates, runs `verify-rls.ts`, builds and ships the web bundle, restarts pm2, polls `/api/me` for a 401 as the readiness signal, runs two HTTP smoke checks that fail the deploy, and finally runs `smoke-prod.sh` if the smoke credentials are present. The file ends with a restore runbook.

---

## 11. File index

Start here when following any of the above.

**Entry and wiring**
`apps/api/src/main.ts` · `apps/api/src/app.module.ts`

**Security core**
`apps/api/src/common/auth.guard.ts` · `roles.guard.ts` · `roles.decorator.ts` · `request-context.ts` · `env-guards.ts` · `tenant-target.ts` · `counterparty.helpers.ts` · `rfq-guards.ts`

**Database core**
`apps/api/src/db/db.service.ts` · `apps/api/src/db/db.module.ts` · `apps/api/drizzle/schema/index.ts` · `enums.ts` · `_shared.ts` · `apps/api/drizzle.config.ts`

**RLS SQL**
`apps/api/drizzle/migrations/0001_security_functions.sql` · `0002_app_role.sql` · `0010_rls_helpers.sql` · `0032_individual_read_privacy.sql` · `0034_audit_hardening.sql` · `0040_environment_isolation.sql` · `0041_environment_rls.sql` · `0045_user_read_privacy.sql`

**Cross-cutting services**
`apps/api/src/common/status.service.ts` · `ai.service.ts` · `apps/api/src/modules/notifications/notifications.service.ts` · `apps/api/src/modules/infra/infra.service.ts`

**Worked example of the whole lifecycle**
`apps/api/src/modules/rfq/rfq.controller.ts` → `rfq.service.ts` → `vendor-rfq.service.ts` → `apps/api/src/modules/orders/orders.service.ts`

**Client contract**
`apps/web/src/lib/api.ts` · `apps/web/src/lib/tenant.ts` · `apps/web/src/lib/auth.tsx` · `apps/web/src/App.tsx` · `apps/web/src/nav.tsx`

**Operations**
`deploy.sh` · `apps/api/scripts/verify-rls.ts` · `smoke.sh` · `guard-check.sh` · `smoke-prod.sh` · `infra/docker-compose.yml`