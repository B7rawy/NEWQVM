# QVM HTTP API Reference

Every endpoint in `apps/api/src/modules`, verified against the controller files. Read this alongside `docs/ARCHITECTURE.md` — this document is the surface; that one is the machinery behind it.

**Read the "Called by web?" column before you assume anything works end to end.** Roughly half of this API has no frontend caller. Those endpoints compile, are guarded, and have never been exercised by a user.

---

## 1. Basics

| Fact | Value | Source |
|---|---|---|
| Global prefix | `/api` — every path below is relative to it | `apps/api/src/main.ts:9` |
| Port | `API_PORT`, default `4000` | `main.ts:11` |
| CORS | `{ cors: true }` — **all origins allowed**, no allowlist | `main.ts:8` |
| Body validation | zod `.parse()` at each controller, no `ValidationPipe` | `main.ts:7` (comment), `docs/CONVENTIONS.md` §BE-4 |
| Rate limiting / helmet | **None.** No `@nestjs/throttler`, no `helmet` anywhere in the repo | grep over `apps/api/src` + `apps/api/package.json` |
| Global guard | **None.** Auth is opt-in per controller via `@UseGuards` | no `APP_GUARD` provider |
| Health endpoint | **None.** There is no `/health` or `/ready` route | grep |
| Content type | JSON in, JSON out. No file uploads anywhere — the Excel/CSV flows parse in the browser (SheetJS, lazily imported) and POST rows | `apps/web/src/components/ImportWizard.tsx:8, :95, :163` |

In production the SPA and the API are served from the same origin (`VITE_API_URL` is empty, so the client's `BASE` is `""` and requests go to `/api/...`). In dev `BASE` falls back to `http://localhost:4000` (`apps/web/src/lib/api.ts:12`). The nginx config is not in the repo.

### Errors

A thrown `ZodError` is converted by the one global filter:

```json
{ "statusCode": 400, "error": "Bad Request", "message": ["items: an RFQ needs at least one item"] }
```

`message` is an **array** of `"path: message"` strings for validation failures (`apps/api/src/common/zod-exception.filter.ts:11-16`). Everything else is a standard Nest exception body where `message` is a plain string.

| Status | Typical cause |
|---|---|
| 400 | zod validation; `"no workspace resolved (subdomain / X-Tenant)"`; a business rule (over-delivery, unknown status code, RFQ already confirmed) |
| 401 | `"missing bearer token"`, `"invalid token"`, `"user is deactivated"`, `"invalid credentials"` |
| 403 | `"this action is restricted to platform staff"`, `"insufficient role for this action"`, `"no access to this workspace"`, `"unknown or inactive workspace"`, `"view-as is limited to the workspace it was granted in"` |
| 404 | Record missing **or** in the other environment — deliberately the same response, see §3 |
| 409 | Duplicate identity / flow already active (a Postgres `23505` is translated by some services to 400 instead — `invoice.service.ts:28`, `purchasing.service.ts:22`) |
| 503 | `AiService` only, when the model provider is off, misconfigured, or rate-limited |

---

## 2. `X-Tenant` — which workspace this request is about

QVM is multi-tenant. A **workspace** (a `tenants` row) is one Qparts operating unit, and almost all data belongs to exactly one. Every request must resolve to a workspace or be one of the few that tolerate none.

Resolution happens in `resolveTenantSlug` (`apps/api/src/common/request-context.ts:31-40`):

1. **The subdomain is authoritative.** If `Host` ends in `.${APP_ROOT_DOMAIN}` (default `qvm.localhost`), the leading label is the workspace slug. `riyadh.easycarty.store` → `riyadh`.
2. `RESERVED_SUBDOMAINS = {www, app, api, admin, static, assets}` are treated as the apex, not as workspaces (`request-context.ts:24`).
3. **`X-Tenant` is the fallback**, used on the apex domain and in local dev where there are no subdomains. The value is trimmed and lowercased.
4. No subdomain and no header → no workspace.

The slug is only a *request*. `AuthGuard` then verifies access (`apps/api/src/common/auth.guard.ts:151-157`): the tenant must exist and be active, and the caller must be platform staff, a `tenant_memberships` member, or reach it through an active `tenant_vendors` / `tenant_workshops` / `tenant_service_providers` link. Otherwise 403.

The resolved `tenantId` is pushed into the Postgres session as `app.tenant_id` (`apps/api/src/db/db.service.ts:43-48`) and row-level security does the filtering. **Services mostly do not write `WHERE tenant_id = ?`** — the database enforces it. This is why a wrong or missing `X-Tenant` produces an empty result or a 400, never another workspace's data.

Two consequences a caller must know:

- Endpoints that call `requireTenantCtx` (or the equivalent hand-written check most controllers use) throw **400 `"no workspace resolved (subdomain / X-Tenant)"`** when no workspace resolved. Marked "workspace required" below.
- Platform staff may aim a single request at any workspace by sending `X-Tenant` explicitly, without navigating into it. The web client exposes this as `ReqOpts.tenant` (`apps/web/src/lib/api.ts:70-79`) and the workflow builder uses it.

The client sends `X-Tenant` on every call, sourced cookie-first from a cross-subdomain cookie so that "view as" hops between apex and subdomain do not lose it (`apps/web/src/lib/api.ts:29`, `apps/web/src/lib/tenant.ts:66-85`).

---

## 3. `X-Environment` — Live or Sandbox

Every *operational* row in the database carries an `environment` column of `live` or `sandbox`. Master data (vendors, workshops, users, price lists, reference vocabulary) is shared. A sandbox is a parallel set of transactions against the same catalogue, not a second company.

`resolveEnvironment` (`request-context.ts:20-22`):

```ts
return (req.header("x-environment") ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "live";
```

**It fails open to `live`.** Only an exact case-insensitive `sandbox` selects sandbox. A dropped, misspelled or proxy-stripped header can never widen access — it lands you where you already were. The value is pushed into the session as `app.environment`, and a **RESTRICTIVE** RLS policy (`environment = current_environment()`, USING and WITH CHECK) is AND-ed onto every table carrying the column (`apps/api/drizzle/migrations/0041_environment_rls.sql`). 43 tables in the Drizzle schema declare `environment`; `order_number_counters` is deliberately excluded, so **42 tables** carry the policy. A sandbox session cannot read or write a live row even under the internal escape hatch — which is the point of RESTRICTIVE rather than a second permissive policy, since the cross-workspace portals legitimately run as internal.

Two things follow:

- **Wrong-environment reads return 404, not 403.** `assertEnvironment` (`apps/api/src/common/env-guards.ts:21-28`) throws the identical "not found" message for "row does not exist" and "row is in the other environment". A 403 would confirm the row exists and let a sandbox session enumerate live document ids.
- **`GET /api/me` echoes back the environment the server resolved** (`apps/api/src/modules/me/me.controller.ts:66-69`). This is the only way a client can discover it believes it is in Sandbox while actually writing to Live.

The client always sends the header (`apps/web/src/lib/api.ts:80`), also cookie-first, because reverting to Live silently is the one direction that must never happen by accident.

One endpoint cannot use the header at all: the public `/quote-access/:token/quote` is reached from an emailed URL. `VendorRfqService.submitQuoteByToken` (`apps/api/src/modules/rfq/vendor-rfq.service.ts:122-170`) therefore looks the token up **twice, once per environment**, and then writes in the environment the RFQ itself is in.

---

## 4. Authentication

`Authorization: Bearer <jwt>`. Tokens are signed with `JWT_SECRET` (the module throws at boot if it is unset and `NODE_ENV=production`; otherwise it falls back to a dev string) and expire after `JWT_EXPIRES_IN`, default `1d` (`apps/api/src/modules/auth/auth.module.ts:9-22`).

Claims read by the guard (`auth.guard.ts:42-45`):

| Claim | Meaning |
|---|---|
| `sub` | the acting user id |
| `imp` | the **real** actor's id when this is a "view as" session |
| `impTenant` | the workspace a non-platform "view as" is confined to |

Every authenticated request re-reads `users.is_active` for `sub`, and for `imp` when present. Deactivating an account kills live tokens immediately rather than at TTL. If `impTenant` is set and the resolved workspace differs, the request is 403'd — a `company_admin` cannot inherit workspaces that the *target* belongs to but they do not.

The context the guard builds (`auth.guard.ts:130-142`) is:

```
{ userId, tenantSlug, tenantId, role, isInternal, platformRole, environment, impersonatorId }
```

`role` precedence: tenant membership role → `"vendor"` → `"workshop"` → `"service_provider"` → platform role.

---

## 5. Authorization

Two decorators, one guard (`apps/api/src/common/roles.guard.ts`).

| Decorator | Rule |
|---|---|
| `@PlatformOnly()` | requires `ctx.isInternal` (an active row in `platform_members`). A workspace membership role can **never** satisfy it. |
| `@Roles(...)` | **platform staff pass unconditionally**; everyone else needs `ctx.role` in the list. |
| neither | any authenticated caller passes; RLS is the only remaining scope. |

`@PlatformOnly` exists separately because the `membership_role` and `platform_role` Postgres enums share five value strings (`super_admin`, `staff`, `account_manager`, `purchasing`, `part_extractor`). `@Roles("super_admin")` would have been satisfiable by a *tenant* membership. Never list a platform-tier role name in `@Roles` (`apps/api/src/common/roles.decorator.ts:6-11`).

Guard coverage. There are **32 controller files containing 33 controller classes** — `purchasing.controller.ts` declares two (`PurchasingController`, `PurchaseOrdersController`).

| Guards | Controller classes |
|---|---|
| `AuthGuard, RolesGuard` | 24 |
| `AuthGuard` only | 7 — `me`, `account`, `workspaces`, `admin/impersonate`, `vendor`, `workshop`, `provider`. These derive ownership in the service and 403 there |
| **none** | 2 — `auth` (public login/signup) and `quote-access` (public, token-gated) |

Roles by tier (`packages/shared/src/roles.ts`):

- Platform: `super_admin`, `staff`, `account_manager`, `purchasing`, `part_extractor`
- Company: `company_admin`, `branch_manager`, `service_advisor`
- Vendor: `vendor_admin`, `vendor_user`

Two caveats on that list:

- `packages/shared` is declared as a dependency in `apps/api/package.json` but **is not imported anywhere in `apps/api/src`**. The API's enums are hand-maintained in `apps/api/drizzle/schema/enums.ts`.
- The two have already drifted: the `platform_role` Postgres enum has **seven** values — the five above plus `finance_manager` and `pricing_supervisor` (`enums.ts:31-40`). `packages/shared` does not know about those two.

---

## 6. Endpoint reference

Legend for **Called by web?**: **yes** = at least one `api.*()` call in `apps/web/src` hits it; **no** = no caller anywhere in the frontend. Verified by mapping every controller route against every `api.get/post/put/patch/del` path in the web app.

"Workspace required" means the handler 400s without a resolved `X-Tenant`/subdomain.

---

### 6.1 `auth` — public

`apps/api/src/modules/auth/auth.controller.ts` — **no guards at all**.

| Method | Path | Who | Body | Returns | Called by web? |
|---|---|---|---|---|---|
| POST | `/auth/login` | anyone | `{email, password}` | `{token, user:{id, fullName}}` | yes |
| POST | `/auth/signup` | anyone | `{kind: "vendor"\|"workshop", fullName, email, password (min 8), mobile? (min 6)}` | `{token, user:{id, fullName}}` | yes |

`login` verifies against a real argon2 hash of a random secret when the account does not exist, so response time does not reveal whether an email is registered (`auth.service.ts:25-28, :52`).

`signup` creates the user, a **pending** vendor/workshop directory identity, and the admin link, atomically. The account can log in immediately but is gated from transactional actions until activated — see `/account/activate`.

---

### 6.2 `me`

`AuthGuard` only. No workspace required.

| Method | Path | Returns |
|---|---|---|
| GET | `/me` | `{user, tenant:{slug,id}, role, environment, isInternal, platformRole, isVendor, isWorkshop, activationStatus, counterpartyType, persona, impersonating, impersonatorName}` |

`persona` ∈ `platform | vendor | workshop | service_provider | workspace` (`me.controller.ts:53-61`). The frontend selects its whole navigation tree from this one field. `environment` is the server's resolution, not an echo of the header.

Called by web: **yes**.

---

### 6.3 `workspaces`

`AuthGuard` only.

| Method | Path | Returns | Called by web? |
|---|---|---|---|
| GET | `/workspaces` | `{count, workspaces:[{id, slug, name, via, role}]}` | yes |
| GET | `/workspaces/branches` | `{branches:[{id, name, workshop}]}` — workshop branches of the **active** workspace | yes |

`/workspaces` unions four access paths: platform staff (all active tenants), `tenant_memberships`, `vendor_users` ⋈ `tenant_vendors`, `workshop_users` ⋈ `tenant_workshops`. `via` tells you which one matched. Service-provider users are **not** in this union, even though `AuthGuard` grants them workspace access via `tenant_service_providers` — a provider will not see their workspaces in the switcher. This is the workspace-switcher backbone; switching means navigating to the workspace subdomain.

`/workspaces/branches` deliberately runs with `isInternal: false` so platform staff see the active workspace's branches, not every workspace's.

---

### 6.4 `account` — counterparty self-service

`AuthGuard` only.

| Method | Path | Body | Effect | Called by web? |
|---|---|---|---|---|
| POST | `/account/activate` | `{mobile}` (min 6) | Activates a pending self-registered account. 409 if that mobile already identifies another individual | yes |
| POST | `/account/upgrade` | `{legalName, taxNumber}` | Individual → Company: creates the company identity and re-parents history | yes |

---

### 6.5 `admin/workspaces` — tenant administration

`@PlatformOnly()` at the class level. All routes platform-staff only.

| Method | Path | Body | Called by web? |
|---|---|---|---|
| GET | `/admin/workspaces` | — | yes |
| POST | `/admin/workspaces` | `{name, slug}` | yes |
| GET | `/admin/workspaces/:id` | — | **no** |
| GET | `/admin/workspaces/:id/detail` | — | yes |
| PATCH | `/admin/workspaces/:id` | `{name?, isActive?, settings?}` | yes |
| GET | `/admin/workspaces/:id/linkable/:kind` | `kind` ∈ `vendor \| workshop`, else 400 | yes |
| POST | `/admin/workspaces/:id/link/:kind/:entityId` | `{classification?}` | yes |
| POST | `/admin/workspaces/:id/unlink/:kind/:entityId` | — | yes |
| PATCH | `/admin/workspaces/:id/members/:membershipId` | `{role?, workshopBranchId?, isActive?}` (company roles only) | **no** |

Linking never touches the counterparty identity itself — it writes a `tenant_vendors` / `tenant_workshops` row. Vendors and workshops are global directory entities shared across workspaces.

---

### 6.6 `admin/users` — members inside one workspace

`AuthGuard, RolesGuard`.

| Method | Path | Guard | Workspace required | Body | Called by web? |
|---|---|---|---|---|---|
| GET | `/admin/users/roles` | none — **any authenticated caller** | **no** | — | yes |
| GET | `/admin/users?includeInactive=true` | none — **any authenticated caller** | yes | — | yes |
| POST | `/admin/users` | `@Roles("company_admin")` | yes | `{email, fullName, phone?, role, workshopBranchId?, password?}` | yes |
| PATCH | `/admin/users/:membershipId` | `@Roles("company_admin")` | yes | `{role?, workshopBranchId?, isActive?}` | yes |

`role` must be one of the three company roles (`COMPANY_ROLES`, `users-admin.service.ts:8`). Omitting `password` creates a pending invite (null hash).

**The two GET routes carry no role decorator.** Any authenticated caller with a resolved workspace — including a vendor or workshop user reaching that workspace through a link — can list its members. The workshop navigation contains a live link to this page (`apps/web/src/nav.tsx:270`; it is labelled "Soon" in the sidebar but is a real `NavLink`, and `/admin/users` is a real route in `App.tsx:133`). On the apex domain `tenantId` is null and the list handler 400s instead, which is the only thing limiting it today.

---

### 6.7 `admin/platform` — Qparts' own staff

`@PlatformOnly()` at the class level. **Writes additionally require `platformRole === "super_admin"`, enforced inside the service** (`platform-staff.service.ts:32-35`): staff may look, only a super admin may change. You cannot edit your own row, and the last active super admin cannot be removed.

| Method | Path | Body | Called by web? |
|---|---|---|---|
| GET | `/admin/platform/staff` | — | yes |
| POST | `/admin/platform/staff` | `{email, fullName?, role, password?}` | yes |
| PATCH | `/admin/platform/staff/:id` | `{role?, isActive?}` | yes |
| GET | `/admin/platform/users?q=` | — every account platform-wide with its platform role + memberships | yes |

`role` must be a platform role. Granting one is the most privileged action in the system.

---

### 6.8 `admin/impersonate` — "view as"

`AuthGuard` only, **deliberately not `@PlatformOnly`**: authority is mixed and is enforced in `ImpersonationService.start` (`impersonation.controller.ts:7-11`).

| Method | Path | Body | Called by web? |
|---|---|---|---|
| POST | `/admin/impersonate` | `{userId}` → `{token}` | yes |
| POST | `/admin/impersonate/stop` | — (call with the **borrowed** token) | yes |

Rules: platform staff may view as any active user **except** other platform staff. A `company_admin` may view as users only within a workspace they administer, and the minted token is stamped `impTenant` so it cannot be carried elsewhere. **No chaining** — you must stop before starting another (`impersonation.controller.ts:29`). TTL comes from `IMPERSONATION_TTL`, default 30 minutes (`impersonation.service.ts:92`). Both start and stop write to `platform_audit` (`:83`, `:107`).

---

### 6.9 `rfqs` — the entry point of the order chain

`AuthGuard, RolesGuard`. Workspace required on all.

| Method | Path | Guard | Body / query | Returns | Status effect | Called by web? |
|---|---|---|---|---|---|---|
| GET | `/rfqs?queue=` | none | `queue` optional | `{count, rfqs}` (limit 50) | — | yes |
| GET | `/rfqs/:id` | none | — | `{rfq, items, vendors}` | — | yes |
| POST | `/rfqs` | `@Roles(company_admin, branch_manager, service_advisor)` | see below | `{id, orderNumber, itemCount}` | rfq + every item → **`new_rfq`** | yes |
| POST | `/rfqs/:id/send` | `@PlatformOnly` | `{vendorIds: uuid[]}` (min 1) | `{rfqId, sent, isSandbox, results}` | each new `rfq_vendors` row → vendor status **`rfq`** | yes |
| GET | `/rfqs/:id/quotes` | `@PlatformOnly` | — | `{rfqId, rows}` | — | yes |
| POST | `/rfqs/:id/items/:itemId/winning-quote` | `@PlatformOnly` | `{quoteItemId}` | `{itemId, winningQuoteId}` | that `rfq_item` → **`priced`** | yes |

`POST /rfqs` body (`rfq.service.ts:9-28`):

```jsonc
{
  "workshopBranchId": "uuid",           // required; must belong to a workshop LINKED to this workspace
  "plateNumber": "…", "vin": "…",
  "carBrandId": "uuid", "model": "…",
  "orderType": "regular" | "bulk",       // default "regular"
  "deliveryType": "delivery" | "pickup", // default "delivery"
  "items": [                             // min 1 — "an RFQ needs at least one item"
    { "partNumber": "…", "partDescription": "…", "quantity": 1,
      "brandClassId": "uuid", "partCategoryId": "uuid" }
  ]
}
```

Two things worth knowing about create:

- The order number is issued by the atomic `next_order_number(tenant, prefix, region, environment)`, not `MAX()+1`. The prefix is the first three characters of the region code uppercased plus `-`, or `RFQ-` — flagged in code as a placeholder (`rfq.service.ts:57`). In sandbox the segment `SBX-` is inserted **after** the prefix, so a sandbox document reads `RIY-SBX-42` (`0040_environment_isolation.sql:79`).
- **That number is reused by the order.** `OrdersService.confirm` sets `orderNumber: rfq.order_number` (`orders.service.ts:77`). A workshop quoted a number on the phone gets the same string for the RFQ, the order and the invoice.

`?queue=` is **opt-in**. Without it the query is byte-identical to the pre-routing version. With it, `queuePredicate` (`apps/api/src/modules/workflow/routing.ts`) filters by the workspace's active flow routing. The web app sends `?queue=rfqs`.

`list` and `detail` deliberately force `isInternal: false` (`rfq.controller.ts:30, :35`) — platform staff are scoped back to the active workspace. "See all workspaces" is the switcher, not a merged list.

`send` response `results[]` is `[{vendorId, notify: "sent"|"suppressed", token?}]`, and `sent` is the number of vendors processed. **`token` is present only when `NODE_ENV !== "production"`** (`vendor-rfq.service.ts:105-112`). In production the raw token exists only inside the outbound email — which is never actually sent, see §8.

---

### 6.10 `quote-access` — public vendor quoting

`apps/api/src/modules/rfq/quote-access.controller.ts` — **no guards**. The emailed token is the credential.

| Method | Path | Body | Status effect | Called by web? |
|---|---|---|---|---|
| POST | `/quote-access/:token/quote` | `{items: [{rfqItemId, offeredCost, slaHours?, availableQty?, alternativePartNumber?, notes?}]}` (min 1) | `rfq_vendors` row → vendor status **`priced`** | **no** |

The token is SHA-256 hashed and matched against `rfq_vendors.token_hash`, checked against `token_expires_at` (7-day TTL, `vendor-rfq.service.ts:11`), then writes run in a context scoped to the token's tenant and the RFQ's environment so RLS still applies. `status_logs.changed_by` is **null** on this path — the system records honestly that it does not know which human submitted.

There is no UI for this. It is exercised only by the shell scripts: `apps/api/scripts/smoke.sh` and `apps/api/scripts/guard-check.sh`.

---

### 6.11 `orders`

`AuthGuard, RolesGuard`. Workspace required on both.

| Method | Path | Guard | Returns | Status effect | Called by web? |
|---|---|---|---|---|---|
| POST | `/rfqs/:id/confirm` | `@Roles(company_admin, branch_manager, service_advisor)` | `{orderId, orderNumber, confirmedItems}` | rfq → **`confirmed`**; winning `rfq_items` → **`confirmed`**; winning `rfq_vendors` → vendor **`confirmed`** | yes |
| GET | `/orders?queue=` | none | `{count, orders}` (limit 50) | — | yes (`?queue=orders`) |

Only items carrying a `winning_vendor_quote_item_id` are confirmed, **and** their current status must be exactly `priced`: having a winner is not sufficient, because the winner id survives a later status change. Without that check a cancelled item still became a real order line — proven on 2026-07-25 (`orders.service.ts:47-63`). It fails closed and names the offending items rather than silently skipping them. `order_items ↔ rfq_items` is 1:1 and DB-enforced, so an RFQ can only be confirmed once.

There is **no `GET /orders/:id`**. Since delivery, invoicing and returns all hang off `/orders/:id/...`, this is the missing hinge in the API surface.

---

### 6.12 `purchasing`

Two controller classes in one file, both `AuthGuard, RolesGuard`, workspace required.

| Method | Path | Guard | Body | Returns | Called by web? |
|---|---|---|---|---|---|
| POST | `/orders/:id/purchase-orders` | `@PlatformOnly` | — | `{orderId, purchaseOrders, breakdown}` | **no** |
| GET | `/orders/:id/purchase-orders` | `@PlatformOnly` | — | `{orderId, purchaseOrders}` | **no** |
| POST | `/purchase-orders/:poId/invoice` | `@PlatformOnly` | `{amount}` (positive) | `{purchaseOrderId, invoiceAmount}` | **no** |

Creation groups order lines by the *derived* vendor (`order_item → rfq_vendor_item → rfq_vendor → vendor`) into one PO each, and moves those vendor rows to `confirmed`. Idempotent two ways: a check-then-insert plus a `23505` catch on `purchase_orders_order_vendor_uq`, because the check loses to a concurrent duplicate (`purchasing.service.ts:20-22`). Recording the vendor invoice total is set-once and feeds the statement and the payment-allocation cap.

---

### 6.13 `delivery`

`AuthGuard, RolesGuard`. Workspace required on both.

| Method | Path | Guard | Body | Returns | Status effect | Called by web? |
|---|---|---|---|---|---|---|
| POST | `/orders/:id/deliveries` | `@PlatformOnly` | `{items: [{orderItemId, qty}]}` (min 1) | `{deliveryId, orderId, deliveredItems}` | order items whose cumulative qty reaches `approved_qty` → **`delivered`** | **no** |
| GET | `/orders/:id/deliveries` | none — any authenticated member | — | `{orderId, deliveries}` | — | **no** |

Partial and split delivery are supported. Over-delivery is blocked, and quantities in one payload are **aggregated per order item before** the cap check — otherwise two lines for the same item in one request would each pass individually (`delivery.service.ts:52`). Note `deliveredItems` in the response is the raw number of payload lines, not the aggregated item count.

---

### 6.14 `invoicing`

`AuthGuard, RolesGuard`. Workspace required on both.

| Method | Path | Guard | Returns | Status effect | Called by web? |
|---|---|---|---|---|---|
| POST | `/orders/:id/invoice` | `@PlatformOnly` | `{invoiceId, invoiceNumber, totalBeforeVat, vat, totalInclVat, items}` | order → **`invoice_issued`** | **no** |
| GET | `/orders/:id/invoice` | none | `{orderId, invoices}` | — | **no** |

One invoice per order, DB-enforced by `invoices_order_uq` with a `23505` catch that returns 400 `"invoice already issued for this order"`. VAT is a hard-coded 15% (`invoice.service.ts:8`). Line unit price comes from `rfq_items.selling_price` when set, otherwise from `PricingService.computeIn` — and the comment at `invoice.service.ts:18-22` is honest that until the pricing engine populates `selling_price` this falls back to the winning quote **cost**.

---

### 6.15 `returns`

`AuthGuard, RolesGuard`. Workspace required on all three.

| Method | Path | Guard | Body | Returns | Status effect | Called by web? |
|---|---|---|---|---|---|---|
| POST | `/orders/:id/returns` | `@Roles(company_admin, branch_manager, service_advisor)` | `{items: [{orderItemId, qty, returnReasonId?, responsibility?}]}` (min 1) | `{returnId, orderId, returnedItems}` | those `order_items` → **`return`** | **no** |
| GET | `/orders/:id/returns` | none | — | `{orderId, returns}` | — | **no** |
| POST | `/returns/:returnId/credit-note` | `@PlatformOnly` | — | `{creditNoteId, creditNoteNumber, total, items}` | return + its items → **`credit_note_issued`** | **no** |

`responsibility` ∈ `internal | vendor | client | delivery_agent`. Same aggregate-then-check pattern as delivery (`returns.service.ts:60`): you cannot return more than was delivered, net of prior returns.

---

### 6.16 `insurance`

`AuthGuard, RolesGuard`. Workspace required on all five.

| Method | Path | Guard | Body | Status effect | Called by web? |
|---|---|---|---|---|---|
| POST | `/insurance/companies` | `@PlatformOnly` | `{name, suggestedDiscountPct?, fileFormat?: "separate"\|"combined", contactInfo?}` | — | **no** |
| GET | `/insurance/companies` | none | — | — | **no** |
| POST | `/rfqs/:id/payer` | `@PlatformOnly` | `{payerType: "cash_client"\|"credit_client"\|"insurance", insuranceCompanyId?}` | — | **no** |
| POST | `/rfqs/:id/insurance/send-for-approval` | `@PlatformOnly` | — | rfq → **`sent_insurance_approval`** | **no** |
| POST | `/rfqs/:id/insurance/approve` | `@Roles(company_admin, branch_manager, service_advisor)` | — | rfq → **`insurance_approved`** | **no** |

`payerType: "insurance"` requires `insuranceCompanyId` and the insurer must belong to this workspace; cash/credit force it to null so a stray insurer id can never be stored (`insurance.service.ts:49-60`).

**Caveat worth flagging:** this is the only module that still writes `status_id` directly (`insurance.service.ts:100`), bypassing `StatusService`. It has its own hand-written state machine (insurance-payer RFQs only, never a confirmed one, only along legal edges) but the move produces **no `status_logs` row** and is not checked against the workspace's workflow.

---

### 6.17 `pricing` — all `@PlatformOnly`, workspace required

| Method | Path | Body / query | Called by web? |
|---|---|---|---|
| POST | `/pricing/basis` | `{payerScenario, insuranceCompanyId?, priceBasis: "agency_price"\|"vendor_price"\|"calculated_margin", adjustmentType?: "discount"\|"markup" (default markup), adjustmentPct?: 0–999.99}` | **no** |
| POST | `/pricing/agency-price` | `{partNumber, price, source?}` | **no** |
| GET | `/pricing/compute?cost=&scenario=` | `scenario` ∈ `cash_client \| credit_client \| insurance`, default `cash_client` | **no** |

A **discount** above 100% is rejected by a `superRefine` — no negative prices (`pricing.service.ts:15-18`). A markup may go to 999.99.

---

### 6.18 `vendors`

Vendors are a **global directory**. A workspace reaches one through `tenant_vendors`. Identity writes are platform-only; a workspace onboards through `/counterparty/submissions`.

| Method | Path | Guard | Workspace required | Body | Called by web? |
|---|---|---|---|---|---|
| GET | `/vendors` | none | no | — | yes |
| GET | `/vendors/available?tenantId=` | `@PlatformOnly` | no | — | **no** |
| GET | `/vendors/:id` | none | no | — | yes |
| POST | `/vendors` | `@PlatformOnly` | no | see below | yes |
| PATCH | `/vendors/:id` | `@PlatformOnly` | no | `{legalName?, commercialRegistrationNumber?, taxNumber?, primaryEmail?, primaryPhone?, vendorType?, paymentTermsDays?}` | **no** |
| POST | `/vendors/:id/status` | `@Roles("company_admin")` | no | `{status: "active"\|"suspended"\|"archived", tenantId?}` | yes |
| POST | `/vendors/:id/link` | `@PlatformOnly` | no | `{tenantId?, classification?}` | **no** |
| GET | `/vendors/:id/branches` | none | **yes** | — | **no** |
| POST | `/vendors/branches` | `@Roles("company_admin")` | **yes** | `{vendorId, name, regionId?, cityId?, address?}` | **no** |

`POST /vendors` body:

```jsonc
{
  "counterpartyType": "company" | "individual",   // default "company"
  "legalName": "…",                                // required, min 2
  "taxNumber": "…",        // REQUIRED when company
  "primaryPhone": "…",     // REQUIRED when individual
  "commercialRegistrationNumber": "…", "primaryEmail": "…",
  "vendorType": "agency" | "commercial" | "external",
  "paymentTermsDays": 30, "classification": "…",
  "tenantId": "uuid"       // platform staff only: target another workspace
}
```

The company→tax / individual→mobile rule is enforced by `superRefine` (`vendors.service.ts:22-27`) and mirrored by a scoped partial unique index — a duplicate identity returns a **409** telling you to link the existing one instead, never a second row.

Route order matters: `@Get("available")` is declared before `@Get(":id")` so the literal wins.

`GET /vendors` returns the workspace's linked vendors; for platform staff with **no** active workspace it returns the global directory instead (`vendors.service.ts:55-57`). The same "unscoped platform staff → global" rule applies to `/providers` and `/org/workshops`.

---

### 6.19 `providers` — service providers (shipping, inspection, claims)

Same global-directory shape as vendors. No workspace required (all four use `openCtx`).

| Method | Path | Guard | Body | Called by web? |
|---|---|---|---|---|
| GET | `/providers` | none | — | yes |
| POST | `/providers` | `@PlatformOnly` | `{counterpartyType?, scope?: "internal"\|"external", legalName, serviceType?, taxNumber?, primaryEmail?, primaryPhone?, classification?, tenantId?}` | yes |
| POST | `/providers/:id/status` | `@PlatformOnly` | `{status: "active"\|"suspended"\|"archived"}` | yes |
| POST | `/providers/:id/link` | `@PlatformOnly` | `{classification?, tenantId?}` | **no** |

Same mandatory-identifier rule and same 409 on duplicate.

---

### 6.20 `org` — workshops, branches, geography

| Method | Path | Guard | Workspace required | Body / query | Called by web? |
|---|---|---|---|---|---|
| GET | `/org/workshops` | none | no | — | yes |
| GET | `/org/workshops/:id` | none | no | — | yes |
| POST | `/org/workshops` | `@PlatformOnly` | no | `{counterpartyType?, name, taxNumber?, primaryPhone?, primaryEmail?, tenantId?}` | yes |
| GET | `/org/branches` | none | no | — | yes |
| POST | `/org/branches` | `@Roles("company_admin")` | **yes** | `{workshopId, name, regionId?, cityId?, orderCategory?: "regular"\|"bulk", isBulk?}` | yes |
| GET | `/org/regions` | none | no | — | yes |
| GET | `/org/cities?regionId=` | none | no | — | **no** |

---

### 6.21 `counterparty` — governed onboarding

The whole point of this module: a workspace **proposes** a counterparty, it never writes the directory. An exact key match (company→tax, individual→mobile) auto-links; anything new or ambiguous lands in a platform review queue. Directory writes happen under an internal session so the *decision* authorises them, not raw RLS. No route requires a resolved workspace at the controller level — `tenantId` in the body targets one.

| Method | Path | Guard | Body | Called by web? |
|---|---|---|---|---|
| POST | `/counterparty/submissions` | `@Roles("company_admin")` | `{kind: "vendor"\|"workshop", counterpartyType?, legalName, taxNumber?, commercialRegistrationNumber?, mobile?, email?, classification?, tenantId?}` | yes |
| GET | `/counterparty/submissions` | `@Roles("company_admin")` | — | yes |
| POST | `/counterparty/import` | `@Roles("company_admin")` | `{kind, filename?, tenantId?, rows: [...]}` (1–1000 rows) | yes |
| GET | `/counterparty/review` | `@PlatformOnly` | — | yes |
| POST | `/counterparty/submissions/:id/approve` | `@PlatformOnly` | `{notes?, classification?}` | yes |
| POST | `/counterparty/submissions/:id/merge` | `@PlatformOnly` | `{targetEntityId, notes?}` | yes |
| POST | `/counterparty/submissions/:id/reject` | `@PlatformOnly` | `{notes?}` | yes |
| POST | `/counterparty/:kind/:entityId/account` | `@PlatformOnly` | `{email, fullName?, phone?, password?}` | yes |
| POST | `/counterparty/:kind/:entityId/accounts/bulk` | `@PlatformOnly` | `{rows: [{email, fullName?, phone?, password?}]}` (1–500) | yes |

Because `@Roles` lets platform staff through unconditionally, staff can also submit and import on a workspace's behalf by passing `tenantId`.

`kind` for the account routes ∈ `vendor \| workshop \| service_provider`, else 400. Note the submission/import routes accept only `vendor \| workshop`. Omitting `password` creates an invited account with no hash.

`POST /counterparty/submissions` returns `{submissionId, status, autoLinked, entityId?, matchCount}`. It deliberately returns a **count** of candidate matches and never their names or ids — a workspace must not learn about counterparties it has no relationship with (`counterparty.service.ts:256`).

Bulk import fields are intentionally *not* strictly validated at the zod layer (`importSchema.rows[].email` is a plain string, `legalName` defaults to `""`) because import data is messy; rows are validated one by one and failures are reported per row rather than rejecting the file (`counterparty.service.ts:68-88`). The `accounts/bulk` route is the opposite — it does require real emails.

Route-order note: the literal `submissions/:id/…` routes are declared **before** `:kind/:entityId/account`, which has the same segment count. Reordering them would break onboarding.

---

### 6.22 `parts` — master data

`AuthGuard, RolesGuard`. Reads open to any authenticated caller, writes platform-only.

| Method | Path | Guard | Query / body | Workspace required | Called by web? |
|---|---|---|---|---|---|
| GET | `/parts/clean?pn=` | none | `pn` | **no** | **no** |
| GET | `/parts/detect-category?name=` | none | `name` | yes | **no** |
| GET | `/parts?q=` | none | `q` | yes | **no** |
| POST | `/parts` | `@PlatformOnly` | `{nameEn?, nameAr?, partCategoryId?, synonyms?}` | yes | **no** |
| POST | `/parts/:id/synonyms` | `@PlatformOnly` | `{synonym}` (1–120 chars) | yes | **no** |

`/parts/clean` exposes `cleanPartNumber` (`parts.service.ts:12-18`), the single normaliser used everywhere a part number is entered: trim, uppercase, collapse any run of whitespace / `.` / `/` / `_` / `-` into one `-`, strip leading and trailing dashes. It is the join key for vendor stock and quote matching.

---

### 6.23 `shipping` — workspace required on all

| Method | Path | Guard | Body | Called by web? |
|---|---|---|---|---|
| POST | `/shipping/carriers` | `@PlatformOnly` | `{carrierName, carrierModel: "on_demand_same_city"\|"hub_dropoff_pickup"\|"hub_and_spoke"\|"independent_driver"}` | **no** |
| GET | `/shipping/carriers` | none | — | **no** |
| POST | `/shipping/shipments` | `@PlatformOnly` | `{orderId, carrierSettingId?, cost?}` | **no** |
| POST | `/shipping/drivers` | `@PlatformOnly` | `{ownerType: "private"\|"marketplace", userId?, vehicleDetails?}` | **no** |
| POST | `/shipping/orders/:id/broadcast` | `@PlatformOnly` | — | **no** |
| POST | `/shipping/delivery-requests/:id/accept` | `@PlatformOnly` | — | **no** |

`createCarrier` inserts without a `tenant_id` — `shipping_carriers` is a global table.

---

### 6.24 `approvals` — workspace required on all

| Method | Path | Guard | Body | Called by web? |
|---|---|---|---|---|
| POST | `/approvals/policies` | `@PlatformOnly` | `{name, entityType, levels: [{approverUserId, isRequired?}]}` (min 1 level) | **no** |
| POST | `/approvals/requests` | `@PlatformOnly` | `{entityType, entityId}` | **no** |
| POST | `/approvals/requests/:id/act` | none — any authenticated caller may attempt; the service checks the named approver | `{action: "approve"\|"reject", comment?}` | **no** |
| GET | `/approvals/requests/:id` | none | — | **no** |

`entityType` is a free-form string, not an enum — nothing constrains it to a real table. Levels are numbered by array position (`levelOrder = i + 1`). This module is entirely unwired: nothing in the rest of the API creates an approval request, and `workflow_transitions.requiresApproval` does not call into it.

---

### 6.25 `infra` — audit log and calendar

`@Controller()` with no prefix, so these sit at the API root. Workspace required on all.

| Method | Path | Guard | Query / body | Called by web? |
|---|---|---|---|---|
| GET | `/audit-log?entityType=&entityId=` | `@PlatformOnly` | — | **no** |
| GET | `/calendar` | none | — | **no** |
| POST | `/calendar/working-days` | `@PlatformOnly` | `{workingDays: number[]}` (0–6) | **no** |
| POST | `/calendar/holidays` | `@PlatformOnly` | `{date, name?}` | **no** |
| GET | `/calendar/deadline?from=&days=` | none | both required | **no** |

`AuditService.record` writes inside the caller's transaction, so an audit row commits or rolls back with the action it describes. `query` returns the most recent 100 rows (`infra.service.ts:48`).

---

### 6.26 `vendor-assignment` — workspace required on both

| Method | Path | Guard | Body | Called by web? |
|---|---|---|---|---|
| POST | `/vendor-selection-rules` | `@PlatformOnly` | `{workshopBranchId?, partCategoryId?, cityId?, automationMode?: "suggest"\|"auto", vendorIds: uuid[]}` | **no** |
| GET | `/rfqs/:id/suggested-vendors` | `@PlatformOnly` | — | **no** |

Rules match on branch + item category + city; a null field is a wildcard. The suggestion returns distinct vendors that are linked to this workspace **and** active, plus a flag saying whether any matching rule is `auto`.

**Nothing acts on that flag.** `automationMode: "auto"` exists in the schema and in the response, and the doc comment says "caller may then auto-send" (`vendor-assignment.service.ts:46-49`), but no caller auto-sends an RFQ. This endpoint only suggests.

---

### 6.27 `vendor-finance` — all `@PlatformOnly`, workspace required

| Method | Path | Body | Called by web? |
|---|---|---|---|
| POST | `/vendor-finance/payments` | `{vendorId, amount, reference?, allocations?: [{purchaseOrderId, amount}]}` | **no** |
| GET | `/vendor-finance/statement/:vendorId` | — | **no** |
| POST | `/vendor-finance/financing` | `{vendorId, requestedAmount}` | **no** |

Allocations must not exceed the payment amount, and are aggregated **per PO before** the invoice-amount cap is checked, so duplicate allocation lines in one payload cannot bypass it (`vendor-finance.service.ts:28-35`). The financing interest rate is a single hard-coded constant, `FINANCING_INTEREST_PCT = 2.5` (`vendor-finance.service.ts:7`).

---

### 6.28 `vendor-selfservice` — all `@PlatformOnly`, workspace required

| Method | Path | Body / query | Called by web? |
|---|---|---|---|
| POST | `/vendor-selfservice/stock` | `{vendorId, items: [{partNumber, nameEn?, nameAr?, partType?, quantity?, wholesalePrice?, retailPrice?}]}` (min 1) | **no** |
| GET | `/vendor-selfservice/stock/:vendorId?mask=1` | — | **no** |
| POST | `/vendor-selfservice/pricing-policy` | `{vendorId, scopeType?: "global"\|"region"\|"client_branch", regionId?, workshopBranchId?, adjustmentType?, adjustmentPct?: 0–100}` | **no** |
| GET | `/vendor-selfservice/resolve-price?vendorId=&base=&regionId=&branchId=` | `vendorId` + numeric `base` required | **no** |

Despite the name, **no vendor can call any of this.** The controller comment says so: gated `@PlatformOnly` "for now"; internal staff manage on behalf, and real vendor-role access is deferred until vendor auth is wired into the guard (`vendor-selfservice.controller.ts:13-16`).

Stock upload **merges** by cleaned part number — it never replaces the catalogue.

---

### 6.29 `vendor` — vendor portal (cross-workspace)

`AuthGuard` only. There is no tenant or role context: the service derives `vendor_id` from `vendor_users` and filters by it, so a vendor sees only its own rows across every linked workspace, and a non-vendor gets a 403 from the service.

| Method | Path | Body | Status effect | Called by web? |
|---|---|---|---|---|
| GET | `/vendor/overview` | — | — | yes |
| GET | `/vendor/quotations` | — | — | yes |
| GET | `/vendor/quotations/:id` | — | — | yes |
| POST | `/vendor/quotations/:id/quote` | same `submitQuoteSchema` as the public token path | `rfq_vendors` → vendor **`priced`** | yes |
| GET | `/vendor/orders` | — | — | yes |
| GET | `/vendor/profile` | — | — | yes |

`:id` here is an `rfq_vendors` id (the invitation), not an RFQ id.

Two gates on submit (`vendor-portal.service.ts:156-161`): `assertEnvironment` — the request must belong to the environment the vendor is currently working in; and `activation_status === "active"` — a pending self-registered account cannot quote. The actual write reuses `VendorRfqService.writeQuoteItems`, shared with the public token path so the two cannot diverge.

---

### 6.30 `workshop` — workshop portal (cross-workspace)

`AuthGuard` only, same ownership-derivation contract via `workshop_users`.

| Method | Path | Body | Called by web? |
|---|---|---|---|
| GET | `/workshop/overview` | — | yes |
| GET | `/workshop/requests` | — | yes |
| GET | `/workshop/requests/:id` | — | yes |
| GET | `/workshop/context` | — returns `{workspaces, branches}` for the new-request form | yes |
| GET | `/workshop/branches` | — | yes |
| GET | `/workshop/orders` | — | yes |
| POST | `/workshop/requests` | `{tenantId, workshopBranchId, plateNumber?, vin?, model?, orderType?, items: [{partNumber?, partDescription?, quantity}]}` | yes |

`tenantId` in the body is which linked workspace should serve the request — a workshop belongs to several. The handler verifies in one query that the branch is owned by the caller's workshop **and** that workspace is linked and active, requires `activation_status === "active"`, then delegates to `RfqService.create` in the chosen tenant with `deliveryType` fixed to `"delivery"` (`workshop-portal.service.ts:171-199`). The environment comes from the caller's session, not a hard-coded `live` — hard-coding it meant a workshop testing in Sandbox silently filed a real request. Response is the same `{id, orderNumber, itemCount}` as `POST /rfqs`.

---

### 6.31 `provider` — service-provider portal

`AuthGuard` only. One endpoint, because a provider has no RFQ→quote loop — it delivers a service.

| Method | Path | Returns | Called by web? |
|---|---|---|---|
| GET | `/provider/overview` | provider identity + `workspaces` it serves + `teammates` | yes |

---

### 6.32 `admin/workflows` — the workflow engine

`@PlatformOnly()` at the class level. **Eight of the thirteen routes additionally require `platformRole === "super_admin"`**, enforced in the service: `create`, `saveGraph`, `assist`, `activate`, `retire`, `newVersion`, `remove`, and `returnRecord` (the `0066` break-glass). Staff may look; only a super admin may change.

Two routes are marked `@WorkspaceRoute` instead — `my-work` and `claim` — because they are the workspace's own queue, and the class-level door made them unreachable for the exact people custody hands work to. `returnRecord` is deliberately NOT one of them: the ordinary way home is the arrow, open to whoever the author allowed, and this exists only for when that arrow's holders cannot take it.

| Method | Path | super_admin? | Body | Called by web? |
|---|---|---|---|---|
| GET | `/admin/workflows/catalog` | no | — | yes |
| GET | `/admin/workflows` | no | — | yes |
| GET | `/admin/workflows/my-work` | no | — | yes |
| GET | `/admin/workflows/:id` | no | — | yes |
| POST | `/admin/workflows` | **yes** | `{flowKey, nameEn, nameAr, statusDomain?: "item"\|"vendor", isDefault?, entryMode?: "selected"\|"handoff"}` | yes |
| PUT | `/admin/workflows/:id/graph` | **yes** | see below | yes |
| POST | `/admin/workflows/records/:entity/:id/claim` | no | `{userId?}` | yes |
| POST | `/admin/workflows/records/:entity/:id/return` | **yes** | `{toCode?}` | **no** |
| POST | `/admin/workflows/:id/assist` | **yes** | `{messages: [{role: "user"\|"assistant", text}] (1–40), graph?}` | yes |
| POST | `/admin/workflows/:id/activate` | **yes** | — | yes |
| POST | `/admin/workflows/:id/retire` | **yes** | — | yes |
| POST | `/admin/workflows/:id/new-version` | **yes** | — | yes |
| DELETE | `/admin/workflows/:id` | **yes** | — | **no** |

`GET /admin/workflows` returns every flow in the workspace + environment, ordered the way the engine tries them (`status_domain`, then `selection_priority desc`, then oldest) — so filtering the response to the *active* flows of one domain gives exactly the sequence a new record is matched against. Each row carries `selection_priority` and `selection_summary` — the routing rule rendered as a sentence (`describeSelection`), because `null` and `{}` look almost identical in jsonb and mean opposite things. Activating a second flow in the same status domain is allowed; activating a second **default** is a 409 naming the flow that already holds the fallback slot.

`GET /catalog` returns the governed vocabulary the canvas and the AI may reference: `{itemStatuses, vendorStatuses, roles, pages, holders}`. `roles` is `WORKFLOW_ROLES` (`apps/api/src/modules/workflow/roles.ts`) — the **union of `membership_role` and `platform_role`**, because `effectiveRoles` reads both and a flow may legitimately name either; it is also the closed set `validateGraph` refuses an unknown `ownerRoles` / `allowedRoles` against, so what the picker offers is exactly what a save accepts. `holders` counts how many people can actually act under each role here, from the same shared definition — an active membership in this workspace **or** an active platform member, since platform staff belong to no workspace and hold their role in all of them. It is used to refuse activating a flow whose non-terminal steps are owned by a role nobody has.

`PUT /:id/graph` — **the graph is one document keyed by status CODE, not uuid** (`workflow.service.ts:13-18`). That single choice makes canvas-authoring, AI-authoring and half-each the same feature.

```jsonc
{
  "nameEn": "…", "nameAr": "…",
  "selectionCondition": null | {} | {…},  // null = never auto-selected; {} = matches everything.
                                          // Same schema as a transition's condition, and EVALUATED
                                          // when a record enters (0065). Omit to keep what is stored.
  "selectionPriority": 0,                 // ties between two flows that both match: highest first,
                                          // then oldest. Omit to keep what is stored.
  "canvas": { … },
  "steps": [{ "status": "new_rfq", "isEntry": true, "isTerminal": false,
              "slaHours": 24, "x": 0, "y": 0, "sortOrder": 0,
              "pages": ["rfqs"], "ownerRoles": ["purchasing"] }],   // 1–200
  "transitions": [{ "from": "new_rfq", "to": "priced", "labelEn": "…", "labelAr": "…",
                    "requiresApproval": false, "allowedRoles": [],
                    "condition": {}, "priority": 0,
                    "handoff": "pool" | "keep" | "actor",
                    "toFlowKey": null | "insurance" }]              // 0–1000
                    // toFlowKey (0066) makes the arrow a BORDER: taking it also hands the record to
                    // the active version of that flow, landing on that flow's step for `to`. It must
                    // not name this flow's own key, and both ends are re-checked at activation.
}
```

Only a **draft** can be saved; the save is a full replace (delete transitions → delete steps → re-insert), idempotent by construction. Database triggers (migration 0047) enforce draft-only editing, so these checks exist for good error messages, not for safety.

`POST /:id/assist` **proposes only — nothing is persisted** (`workflow.service.ts:689`). The model is handed only the governed catalog for this flow's status domain, and the reply then passes three checks in order: the same `saveGraphSchema` zod parse the human save path uses; a rejection of the whole reply if any returned status code is not in the catalog; then the same `validateGraph`. Returns `{reply, drew: true, flow, steps, transitions}`, or `{reply, drew: false}` for a conversational turn with nothing to draw. Requires `AI_PROVIDER=gemini` and `GEMINI_API_KEY`; otherwise 503.

`POST /:id/activate` is stricter than saving (`assertActivatable`): ≥1 step, exactly one entry, ≥1 terminal, no non-terminal step without an outgoing transition, every step reachable from entry, **every step able to reach some terminal** (a backwards BFS added by `0066` — the older checks all pass on `entry→X, X→Y, Y→X, entry→T`, in which a record at X orbits for ever), a non-default flow must have a selection condition **or `entryMode: "handoff"`**, and no non-terminal step may name an `ownerRoles` entry with zero holders. `0066` adds both directions of every border: each `toFlowKey` must name a flow with an active version containing the destination status, and no active flow may cross INTO this flow_key at a status this version does not contain. It returns `{id, status, warnings}` — a handoff flow whose terminal hands nothing back is WARNED about and still activated, because a sub-flow that legitimately ends some records is indistinguishable from one whose way home was never drawn. Activation retires the predecessor first, because the partial unique index permitting one active version is not deferrable.

`POST /:id/retire` refuses while an ACTIVE flow crosses into this one (`0066`) — a drawn border must not become a dead end. A version bump is unaffected: `activate()` retires the predecessor in its own transaction, so the key never stops resolving.

`POST /records/:entity/:id/return` is BREAK GLASS (`0066`): super_admin only, valid only while the record is away in a sub-flow (`origin_flow_id` set). It finds the return arrow the author drew from where the record stands and takes it through `StatusService` like any other move — same guard, same gates, one `status_logs` row with a real actor — so it cannot produce a state an ordinary return could not. `toCode` picks between several ways home; it is required only when more than one is drawn. It refuses when none is, rather than dropping the record on a status nobody connected.

`POST /records/:entity/:id/claim` deliberately does **not** move the status — claiming is responsibility, not progress. It refuses handing a record to someone lacking the step's role, because that would strand it where nobody looks.

**Route-order hazard, already handled:** `@Get("my-work")` is declared before `@Get(":id")` (`workflow.controller.ts:50-58`). Reversing them would make `/my-work` parse as a flow id.

**Worth flagging honestly:** `my-work` and `claim` are personal-queue features but sit behind class-level `@PlatformOnly`. No workspace user, vendor or workshop can reach their own queue today.

---

## 7. What is not called by the web app

Fourteen modules have zero frontend callers. Verified by mapping every controller route against every `api.get/post/put/patch/del` in `apps/web/src`.

| Module | Endpoints unreachable from the UI |
|---|---|
| `purchasing` | `POST/GET /orders/:id/purchase-orders`, `POST /purchase-orders/:poId/invoice` |
| `delivery` | `POST/GET /orders/:id/deliveries` |
| `invoicing` | `POST/GET /orders/:id/invoice` |
| `returns` | `POST/GET /orders/:id/returns`, `POST /returns/:returnId/credit-note` |
| `insurance` | all 5 |
| `pricing` | all 3 |
| `parts` | all 5 |
| `shipping` | all 6 |
| `approvals` | all 4 |
| `infra` | all 5 |
| `vendor-assignment` | both |
| `vendor-finance` | all 3 |
| `vendor-selfservice` | all 4 |
| `quote-access` | the one public route |

Plus these individual routes on otherwise-wired controllers:

`GET /admin/workspaces/:id` · `PATCH /admin/workspaces/:id/members/:membershipId` · `GET /vendors/available` · `PATCH /vendors/:id` · `POST /vendors/:id/link` · `GET /vendors/:id/branches` · `POST /vendors/branches` · `POST /providers/:id/link` · `GET /org/cities` · `DELETE /admin/workflows/:id` (the web client has no `api.del` call anywhere).

**The practical consequence:** an order can be created and confirmed through the UI and then cannot be advanced any further without `curl`. Everything from purchase orders through delivery, invoicing, returns, credit notes and vendor payments is API-only.

---

## 8. Caveats a caller must know

1. **Notifications never dispatch.** `NotificationsService.send` writes a `notification_log` row and then, where the provider call would be, has `void secret;` and a log line (`apps/api/src/modules/notifications/notifications.service.ts:61-65`). No SMTP, WhatsApp or webhook client exists in the repo. `providerLive` also requires `NODE_ENV === "production"` **and** a configured provider (`EMAIL_PROVIDER` other than `console`, or `WHATSAPP_ENABLED=true`), so outside prod everything is recorded as `suppressed`. **The emailed `/quote-access/:token` link — the only way a vendor without a portal account can quote — is generated, hashed, stored, and then discarded.**

2. **Status vocabulary is much larger than what the API writes.** `item_statuses` seeds 26 rows; nine have a writer in this codebase (`new_rfq` at insert, `priced`/`confirmed`/`delivered`/`invoice_issued`/`return`/`credit_note_issued` through `StatusService`, and `sent_insurance_approval`/`insurance_approved` written directly by `InsuranceService`). `vendor_statuses` seeds 14; three have a writer (`rfq` at insert, `priced`, `confirmed`). The rest are the old system's vocabulary, seeded deliberately with their `legacy_id`s so a future migration is a mapping rather than a translation. They are selectable in the workflow builder and render correctly in badges, but nothing moves a record into them.

3. **Status changes go through one gateway — except one.** `StatusService` (`apps/api/src/common/status.service.ts`) is the only place a status column is updated on an existing record; it reads the old value first so `status_logs.from_status_id` is real, takes the actor from the request context (never from the body), refuses no-ops without logging them, refuses partial moves when any id is missing, and applies the workflow guard. `InsuranceService.transition` bypasses all of it. Records created with an initial status (RFQ, order, delivery, return) set `status_id` in the INSERT and therefore also produce no `status_logs` row for that first value.

4. **The workflow guard is permissive until configured.** With no active default flow, or a record bound to none, or a record whose current status is not a step in the flow, `assertTransitionAllowed` returns silently and the system behaves exactly as it did before the engine existed. Enforcement switches on per workspace the moment an admin activates a flow, and only for records that entered under it. A platform `super_admin` is a deliberate break-glass exemption from the role gates.

5. **Queue routing does not reach the portals.** `apps/api/src/modules/workflow/pages.ts` declares seven routable pages including `workshop_requests`, `workshop_orders`, `vendor_quotations` and `vendor_confirmed`. `queuePredicate` is applied in exactly two places — `RfqService.list` and `OrdersService.list`. Routing a status to a portal page in the builder is accepted and silently ignored.

6. **The `/internal` page is marked `wired: false`** in the routable-page catalog (`pages.ts:45-46`) while simultaneously being a live frontend route (`apps/web/src/App.tsx:131`) rendering a fully hard-coded mock dashboard — the file says so itself: "All data below is hardcoded Saudi B2B auto-parts MOCK data. No API calls." (`apps/web/src/pages/InternalDashboard.tsx:27`). The AI prompt appends `(NOT BUILT YET — avoid)` for it (`workflow.service.ts:592`).

7. **No unit tests, no CI config.** All testing is bash + curl + psql: `apps/api/scripts/smoke.sh`, `guard-check.sh`, `smoke-prod.sh`, `verify-rls.ts`, wired up as `pnpm --filter @qvm/api test:smoke` / `db:verify`. There are no `*.spec.ts` files, no test framework in any `package.json`, and no `.github/` directory.

8. **The `AiService` supports Gemini only.** The root `.env.example:41` advertises `claude` as a value for `AI_PROVIDER`; `AiService.enabled` returns false for anything that is not `gemini` (`apps/api/src/common/ai.service.ts:18-22`). Default when unset is `off`.

---

## 9. Quick call example

```bash
# 1. authenticate
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"…","password":"…"}' | jq -r .token)

# 2. any subsequent call — three headers
curl -s http://localhost:4000/api/rfqs \
  -H "authorization: Bearer $TOKEN" \
  -H "x-tenant: <workspace-slug>" \
  -H "x-environment: live"
```

On a deployed subdomain (`<slug>.<APP_ROOT_DOMAIN>`) the `x-tenant` header is redundant — the subdomain wins. `x-environment` is never redundant, and omitting it means Live.