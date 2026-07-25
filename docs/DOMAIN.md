# QVM — The Business Domain

QVM is a multi-tenant B2B platform for buying automotive spare parts in Saudi Arabia. This document explains the business it automates, the five kinds of user it serves, and the full lifecycle of an order from the first request to final settlement.

It is written for an engineer who knows the stack but has never seen a spare-parts procurement flow. Every claim below was checked against a file in this repository; paths are relative to the repo root. Where something is designed but not built, it says so.

---

## 1. The business problem

A car comes into a repair workshop with a broken part. The workshop needs that exact part, today, at a price it can quote to the car's owner or to an insurer. It does not know which of the dozens of suppliers in the Kingdom has it in stock, what each would charge, or how fast each can deliver.

Calling five suppliers one at a time is how this is done without software. QVM is the intermediary that does it in one pass:

1. The **workshop** files a request listing what it needs — plate number, VIN, model, and one line per part.
2. **Qparts staff** clean the request up. Part numbers arrive wrong, abbreviated, or missing entirely, so the status vocabulary has a dedicated stage for extracting them (`extract_pn`).
3. Staff select which **vendors** to invite and send the request to all of them at once.
4. Each vendor prices the request **line by line**, without seeing the others' prices.
5. Staff pick a winner **per line**. Different lines of the same request routinely go to different vendors — one has the mirror, another has the bumper.
6. The winning lines become a confirmed **order**, which is split into one **purchase order per vendor**.
7. Parts are delivered (often in several partial shipments), invoiced to the client with 15% KSA VAT, and — when something arrives wrong — returned and credited.

### Two structural facts that shape most of the code

**The document number is issued once and never changes.**
`RfqService.create` (`apps/api/src/modules/rfq/rfq.service.ts:63`) calls the atomic `public.next_order_number(tenant, prefix, region, environment)`. When the request is confirmed, `OrdersService.confirm` reuses it verbatim:

```ts
orderNumber: rfq.order_number, // persists from the RFQ
```
(`apps/api/src/modules/orders/orders.service.ts:77`)

A workshop that quotes a number on the phone gets the same string whether the record is still an unpriced request, a confirmed order, or an issued invoice.

The function is defined in `apps/api/drizzle/migrations/0040_environment_isolation.sql:68`. Three details matter and are easy to get wrong from the call site alone:

- the counter's conflict key is `(tenant_id, prefix, environment)` — `region_id` is stored on the counter row but is *not* part of the key;
- there is **no zero-padding**. The result is `prefix || counter`, e.g. `RIY-1`, `RIY-2`;
- a sandbox document gets a visible `SBX-` infix (`RIY-SBX-1`) so a test document can never be mistaken for a real one.

Invoices and credit notes draw from the same counter with different prefixes — `INV-` (`invoice.service.ts:108`) and `CN-` (`returns.service.ts:149`) — so they get their own sequences, not the order's number.

**Everything is per-line.** Status lives on the header *and* on each item. One line can be `unavailable` while its siblings are `delivered`. The order line ↔ request line relationship is 1:1, enforced by `order_items_rfq_item_uq` (`apps/api/drizzle/schema/orders.ts:62`), and one order per request by `orders_rfq_uq` (`orders.ts:32`). A request can therefore be confirmed only once. The first line of defence is an explicit application check — `assertRfqNotConfirmed` in `apps/api/src/common/rfq-guards.ts`, which every RFQ mutation calls — with the unique indexes as the database backstop when two requests race.

### Live and Sandbox

Every operational row carries an `environment` of `live` or `sandbox`. This is a row-level boundary inside one database, not a separate deployment.

Which tables are split is visible in the schema: `rfq.ts`, `orders.ts`, `purchasing.ts`, `fulfillment.ts`, `shipping.ts`, `approvals.ts`, `billing.ts`, `vendor_finance.ts`, `workflow.ts`, `crosscutting.ts` and the pricing *logs* declare an `environment` column. `vendors.ts`, `org.ts` (workshops), `service_providers.ts`, `identity.ts` (users), `tenancy.ts`, `reference.ts` (the status vocabulary, regions, cities), `parts.ts`, `insurance.ts` and `pricing_engine.ts` (profit margins, pricing-basis settings, agency price reference) do not. In short: master data and configuration are shared between the two environments; transactions are split.

`assertEnvironment` (`apps/api/src/common/env-guards.ts:21`) blocks cross-environment writes, and returns **404, not 403**, on purpose:

> identical message for "missing" and "wrong environment" — the difference must not be observable

A 403 would confirm the row exists and let a Sandbox session enumerate real document ids.

---

## 2. The vocabulary: workspace, workshop, vendor, provider

| Term | What it is | Table |
|---|---|---|
| **Workspace** (tenant) | One Qparts operating unit. Owns its own users, requests, orders, and a subdomain (`tenants.slug` → `<slug>.easycarty.store`). | `tenants` |
| **Workshop** | The customer: a repair shop that needs parts. | `workshops` |
| **Vendor** | The supplier: a parts seller who quotes and ships. | `vendors` |
| **Service provider** | A partner who performs a *service* rather than selling a part — shipping, parts inspection, insurance claims. | `service_providers` |

### Counterparties are global, workspaces are not

`workshops`, `vendors`, and `service_providers` carry **no `tenant_id`**. Each is a global directory identity. A workspace reaches one through a link table that *does* carry `tenant_id`:

| Global identity | Its portal users | Link to a workspace |
|---|---|---|
| `vendors` | `vendor_users` | `tenant_vendors` |
| `workshops` | `workshop_users` | `tenant_workshops` |
| `service_providers` | `service_provider_users` | `tenant_service_providers` |

The reasoning is in the file headers of `apps/api/drizzle/schema/vendors.ts:9-15` and `org.ts:9-14`: the same real supplier serves several operators. If the vendor row were tenant-scoped you would hold N duplicate rows for one legal entity with no way to say they are the same company. Transaction rows (`rfq_vendors`, `purchase_orders`, …) always carry their own `tenant_id`, so history stays isolated per workspace even when the counterparty is shared.

This is also why the vendor, workshop, and provider portals are **cross-workspace** while the staff screens are not. `VendorPortalService` derives `vendor_id` from `vendor_users` (`apps/api/src/modules/vendor-portal/vendor-portal.service.ts:25`) and filters every query by it, returning that vendor's rows across every workspace it supplies.

### Individual vs company

Both vendors and workshops carry `counterparty_type` of `individual` or `company`, and the deduplication key differs by type — company on tax number, individual on mobile. Both are partial unique indexes (`apps/api/drizzle/schema/vendors.ts:36-43`, mirrored in `org.ts:33-40`):

```ts
uniqueIndex("vendors_company_tax_uq").on(t.taxNumber)
  .where(sql`counterparty_type = 'company' AND tax_number IS NOT NULL`)
uniqueIndex("vendors_individual_mobile_uq").on(t.primaryPhone)
  .where(sql`counterparty_type = 'individual' AND primary_phone IS NOT NULL`)
```

A one-man garage has no commercial registration; a company does. Enforcing one key for both would either reject legitimate individuals or let duplicate companies in.

Vendors additionally carry `vendor_type` of `agency` | `commercial` | `external` (`apps/api/drizzle/schema/enums.ts:129`). It is a business category, not a legal form — the comment at `apps/api/src/modules/vendors/vendors.service.ts:16` says exactly that. **It drives no behaviour today.** It is settable on create/update and returned in vendor lists and the vendor's own profile, and nothing else reads it. In particular the pricing engine does not: `PricingService.computeIn` (`apps/api/src/modules/pricing/pricing.service.ts:70`) keys on payer scenario, insurer, part number, part category, brand class and cost — never on the vendor.

### Activation

A self-registered counterparty is born `pending`. `AuthService.signup` (`apps/api/src/modules/auth/auth.service.ts:63`) creates the user, an `individual` directory entity with `activation_status = 'pending'`, and the admin link (`vendor_users.is_vendor_admin` / `workshop_users.is_workshop_admin`) — then returns a token so they can log in immediately. They just cannot transact yet:

- `VendorPortalService.submitQuote` → 403 `"activate your account before submitting quotes"` (`vendor-portal.service.ts:161`)
- `WorkshopPortalService.createRequest` → 403 `"activate your account before creating requests"` (`workshop-portal.service.ts:183`)

`POST /api/account/activate` completes it by supplying a mobile number. If that mobile already identifies another individual, the request does not fail — it becomes a pending submission in the platform review queue so an admin can merge the two identities (`apps/api/src/modules/account/account.service.ts:33-62`). Note the doc-comment above that method (`account.service.ts:22`) is stale: it still says "409 when it already identifies another individual", which is not what the code does.

`POST /api/account/upgrade` converts an individual into a company, creating the company row and re-parenting every foreign-key reference discovered from the Postgres catalog (`pg_constraint`), in both environments inside one transaction, then archiving the individual row and sending a transition notice to every linked workspace.

---

## 3. The five personas

The persona is computed server-side by `GET /api/me` (`apps/api/src/modules/me/me.controller.ts:53-61`) and the frontend selects its entire navigation tree from it (`navForPersona`, `apps/web/src/nav.tsx:290`).

| Persona | Who | Resolved from | Sees |
|---|---|---|---|
| `platform` | Qparts staff | a row in `platform_members` | every workspace |
| `workspace` | client-company staff | a `tenant_memberships` row for the active workspace | one workspace |
| `vendor` | a supplier's users | a `vendor_users` row | its own rows, across every linked workspace |
| `workshop` | the repair shop's users | a `workshop_users` row | its own rows, across every linked workspace |
| `service_provider` | shipping / inspection / claims partners | a `service_provider_users` row | its own record and workspaces |

Precedence is vendor → workshop → service_provider, resolved by one shared helper (`resolveCounterparty`, `apps/api/src/common/counterparty.helpers.ts:10`) that `/me` and all three portals call. Having one implementation means the portal you land on and the data you can read cannot disagree. `platform` outranks everything: `ctx.isInternal` is checked first.

### Roles

Two separate role sets exist. They are **not** perfectly mirrored, and that is worth knowing before you rely on either:

| Set | Postgres enum (`apps/api/drizzle/schema/enums.ts`) | TypeScript (`packages/shared/src/roles.ts`) |
|---|---|---|
| Platform | `platform_role` (line 31): `super_admin`, `staff`, `account_manager`, `purchasing`, `part_extractor`, `finance_manager`, `pricing_supervisor` | `PlatformRole` has only the **first five**. `finance_manager` and `pricing_supervisor` exist in the DB enum only. |
| Workspace / counterparty | `membership_role` (line 10): those first five names again, plus `company_admin`, `branch_manager`, `service_advisor`, `vendor_admin`, `vendor_user` | split across `CompanyRole` and `VendorRole` (the workshop-side and vendor-side names) |

The comment at `enums.ts:28-30` explains the two extra DB values: they were added "to reconcile the role list ↔ code mismatch flagged by QNEW-48-A". The shared TS enum was not updated with them, so do not treat `packages/shared/src/roles.ts` as the complete list.

The two enums **share five value strings**. That collision is why the codebase has two decorators rather than one (`apps/api/src/common/roles.guard.ts`, `roles.decorator.ts`):

- `@PlatformOnly()` requires `ctx.isInternal`. A tenant membership role can never satisfy it, no matter what it is called.
- `@Roles(...)` passes platform staff unconditionally; everyone else must hold a listed role **in this workspace**.

If `@Roles("super_admin")` were used for a platform capability, a tenant membership named `super_admin` would satisfy it. `@PlatformOnly` closes that.

There is a subtlety worth knowing before you write workflow rules. `AuthGuard` picks **one** role per request with an unordered `limit 1` (`auth.guard.ts:82-88`). That is fine for coarse route gating but wrong for a rule that names either of two roles a user holds, so `StatusService.effectiveRoles()` re-reads *all* the user's roles from the database on every permission check (`apps/api/src/common/status.service.ts:59`).

### What each persona can do

**Platform staff** own the middle of the pipeline. Every `@PlatformOnly` route is theirs: sending a request to vendors, comparing quotes, picking winners, raising purchase orders, recording vendor invoices, deliveries, client invoices, credit notes, shipping, pricing configuration, vendor payments, and the counterparty review queue. They can also enter any workspace via the switcher and impersonate any non-platform user ("view as").

**Workspace staff** (`company_admin`, `branch_manager`, `service_advisor`) create requests, confirm them into orders, mark the insurer's approval, and file returns. `company_admin` additionally manages workspace members and submits/imports counterparties for onboarding (`counterparty.controller.ts:33-53`).

**Vendors** see their quotation queue across every workspace they supply, submit and revise quotes until confirmation, view orders they won, and read their own profile. Six endpoints, all under `/api/vendor`.

**Workshops** file requests into any workspace they are linked to, track them, and view their confirmed orders and branches. Seven endpoints under `/api/workshop`.

**Service providers** get exactly one endpoint, `GET /api/provider/overview`. The service file explains why (`apps/api/src/modules/provider-portal/provider-portal.service.ts:7-12`): a provider has no request-to-quote loop of its own, so the portal is just identity, workspaces, and people.

### Impersonation

`POST /api/admin/impersonate` mints a token carrying `imp` (the real actor) and, for a non-platform grant, `impTenant` (the one workspace the borrowed session is pinned to). `AuthGuard` re-validates the impersonator on every request (`auth.guard.ts:64-70`), so deactivating an admin kills borrowed sessions immediately rather than at token expiry. Platform staff may view as anyone except other platform staff; a `company_admin` only within a workspace they administer. Chaining is refused — you must stop before starting another. Start and stop both write to `platform_audit`. The borrowed token is short-lived (`IMPERSONATION_TTL`, default 30m).

---

## 4. The order lifecycle

Every row below is a real endpoint (all paths carry the global `api` prefix set in `apps/api/src/main.ts:9`). The last column is the honest part: much of the second half has a working backend and no button anywhere.

| # | Stage | Endpoint | Who | Status effect | UI? |
|---|---|---|---|---|---|
| 1 | Workshop files a request | `POST /api/workshop/requests` | workshop | request + lines → `new_rfq` | yes |
| 1b | Staff file it on their behalf | `POST /api/rfqs` | company_admin, branch_manager, service_advisor (+ platform) | same | yes |
| 2 | Set who pays | `POST /api/rfqs/:id/payer` | platform | none | **no** |
| 2b | Insurance approval round-trip | `POST /api/rfqs/:id/insurance/send-for-approval` (platform), `.../approve` (workspace roles) | platform / workspace | `sent_insurance_approval` → `insurance_approved` | **no** |
| 3 | Suggest vendors from rules | `GET /api/rfqs/:id/suggested-vendors` | platform | none | **no** |
| 4 | Invite vendors | `POST /api/rfqs/:id/send` | platform | each invitation → vendor status `rfq` | yes |
| 5a | Vendor quotes via emailed link | `POST /api/quote-access/:token/quote` | unauthenticated, token-gated | invitation → `priced` | no page |
| 5b | Vendor quotes in the portal | `POST /api/vendor/quotations/:id/quote` | vendor | same | yes |
| 6 | Compare quotes | `GET /api/rfqs/:id/quotes` | platform | none | yes |
| 7 | Pick a winner per line | `POST /api/rfqs/:id/items/:itemId/winning-quote` | platform | that line → `priced` | yes |
| 8 | Confirm into an order | `POST /api/rfqs/:id/confirm` | workspace roles or platform | request, winning lines, winning vendors → `confirmed` | yes |
| 9 | Raise purchase orders | `POST /api/orders/:id/purchase-orders` | platform | PO + items created at vendor status `confirmed` | **no** |
| 10 | Record vendor invoice total | `POST /api/purchase-orders/:poId/invoice` | platform | none | **no** |
| 11 | Ship | `POST /api/shipping/shipments`, `/api/shipping/orders/:id/broadcast`, `/api/shipping/delivery-requests/:id/accept` | platform | none | **no** |
| 12 | Deliver (partial allowed) | `POST /api/orders/:id/deliveries` | platform | fully-delivered lines → `delivered` | **no** |
| 13 | Invoice the client | `POST /api/orders/:id/invoice` | platform | order → `invoice_issued` | **no** |
| 14 | Workshop returns items | `POST /api/orders/:id/returns` | workspace roles | those lines → `return` | **no** |
| 15 | Issue the credit note | `POST /api/returns/:returnId/credit-note` | platform | return + lines → `credit_note_issued` | **no** |
| 16 | Vendor payment / statement | `POST /api/vendor-finance/payments`, `GET /api/vendor-finance/statement/:vendorId` | platform | none | **no** |

### Stage 1 — the request

`createRfqSchema` (`rfq.service.ts:9-28`) requires a `workshopBranchId` and at least one item. The branch is resolved by joining `workshop_branches ⋈ workshops ⋈ tenant_workshops` (`rfq.service.ts:46-52`), which is what enforces that the branch belongs to a workshop linked to *this* workspace. There is no explicit `tenant_id` filter — the link table is tenant-scoped and row-level security supplies it.

The customer name is **snapshotted** onto the request header at creation (`customerNameSnapshot: branch.workshop_name`, `rfq.service.ts:87`). Renaming a workshop two years later must not silently rewrite historical documents. The same pattern appears on purchase orders (`vendorNameSnapshot`, `purchasing.service.ts:86`).

The order-number prefix is the first three characters of the branch's region code, uppercased, falling back to `RFQ-`. The code labels this a placeholder: `// per-(tenant, prefix) sequence; prefix derived from region (placeholder — configurable later)`.

The workshop portal does not duplicate any of this. `WorkshopPortalService.createRequest` (`workshop-portal.service.ts:171`) does the ownership and activation checks, then calls `RfqService.create` with the chosen tenant — so both entry points produce identical rows.

### Stage 4 — inviting vendors

`VendorRfqService.send` (`vendor-rfq.service.ts:43`) checks per vendor that the workspace link is `tenant_vendors.status = 'active'` **and** the directory row is `is_active` **and** `activation_status = 'active'` (`vendor-rfq.service.ts:68-72`) — a suspended or half-registered supplier cannot be invited. It then writes one `rfq_vendors` row per vendor and fires one notification each.

### Stage 5 — the tokenised vendor access link

This is the most interesting piece of the flow, because it lets a supplier with no account quote from an email.

**Minting.** For each invited vendor, `send` generates 24 random bytes as a base64url token and stores **only its SHA-256 hash**, with a 7-day expiry (`TOKEN_TTL_DAYS = 7`, `vendor-rfq.service.ts:11`):

```ts
const rawToken = randomBytes(24).toString("base64url");
...
tokenHash: hashToken(rawToken),
tokenExpiresAt: expiresAt,
```

The raw link goes to the notification service as a separate `secret` argument that is documented as never persisted (`vendor-rfq.service.ts:90-91`); `notification_log` stores only non-secret metadata. The raw token is echoed back in the API response **only** when `NODE_ENV !== "production"` (`vendor-rfq.service.ts:107`), as a dev convenience.

**Redeeming.** `POST /api/quote-access/:token/quote` is the one controller in the API with **no guard at all** (`apps/api/src/modules/rfq/quote-access.controller.ts`). The token is the credential.

Resolution has a wrinkle that is worth reading in full, because it explains a design constraint the whole system lives under. An emailed URL carries no `X-Environment` header, and the restrictive RLS policy filters by an environment session variable that defaults to `live`. A single lookup would therefore make every Sandbox link return "invalid token". So the service searches each environment in turn (`vendor-rfq.service.ts:124-152`):

> Two cheap reads on a rare path, and no SECURITY DEFINER escape hatch — the old system's 156 open definer functions are exactly the sin this rebuild exists to undo.

Once resolved, the writes run in a *second* context scoped to the token's tenant with `isInternal: false`, and the environment taken from the RFQ itself — so a sandbox link can only ever write sandbox rows.

**One write path.** Both the token flow and the authenticated portal call the same `writeQuoteItems` (`vendor-rfq.service.ts:177`), so they cannot drift. It rejects the write if the request is already confirmed, discards any line that does not belong to this request, and upserts the rest — a vendor may revise its quote right up to confirmation. On the token path `actorUserId` is `null`, and the comment is explicit that this is deliberate:

> status_logs records that honestly rather than attributing the change to whoever happened to send the RFQ.

A quote line carries offered cost, optional SLA hours, available quantity, an alternative part number, and notes (`submitQuoteSchema`, `vendor-rfq.service.ts:16-29`).

### Stage 7 — picking winners

`selectWinner` (`vendor-rfq.service.ts:243`) validates that the quote actually belongs to this request and this line, refuses to run if the request is already confirmed ("winners are locked"), sets `rfq_items.winning_vendor_quote_item_id`, and moves the line to `priced`.

### Stage 8 — confirmation

`OrdersService.confirm` (`orders.service.ts:21`) takes only lines that have a winning quote — but having a winner is deliberately **not** sufficient. There is a pre-approval state check at line 57 whose comment records the bug it fixes:

> the winner id survives a later status change, so without this a cancelled item still became a real order line (proven 2026-07-25 — the item was at 'cancelled' and confirm returned 201).

It fails closed and names the offending lines rather than skipping them, because skipping would confirm a partial order and look successful.

The order inherits the request's environment and its order number. Winning vendors' invitations are also advanced to `confirmed` (`orders.service.ts:104-112`), which is what drives the "won" counter in the vendor portal.

### Stage 9 — purchase orders

`PurchasingService.createForOrder` derives each line's vendor rather than storing it twice: `order_item → rfq_vendor_item → rfq_vendor → vendor` (`purchasing.service.ts:48-55`). Lines are grouped by vendor into one purchase order each, and the cost stays on the quote row — `purchase_items` links to the quote (`vendorQuoteItemId`) instead of copying the price.

Note this service does **not** go through the status gateway: the PO and its items are *created* already carrying the `confirmed` vendor status, which is an insert rather than a transition on an existing record. Nothing in `status_logs` records it.

Idempotency is belt-and-braces: a check-then-insert, *plus* a catch on Postgres error `23505` mapped to the same 400, because the check loses to a concurrent duplicate.

### Stage 12 — delivery

`DeliveryService.create` supports partial and split delivery. Over-delivery is blocked, and quantities within a single payload are **aggregated per line before** the cap is checked (`delivery.service.ts:52-54`) — otherwise two lines for the same item in one request would each pass individually. A line only flips to `delivered` once its cumulative delivered quantity reaches the approved quantity.

### Stage 13 — the client invoice

One invoice per order, idempotent, with a `VAT_RATE = 0.15` constant for KSA VAT (`invoice.service.ts:8`). Unit price is `rfq_items.selling_price` if set, otherwise computed by `PricingService.computeIn` from cost, payer scenario, and insurer. The header comment is honest that the engine may not have set it yet:

> until the pricing engine (roadmap QNEW-30) sets rfq_items.selling_price, we fall back to the winning quote cost as a documented placeholder.

That fallback is real: `computeIn` "falls back to cost if nothing is configured" (`pricing.service.ts:65-68`), and nothing in the UI configures it.

### Stages 14–15 — returns and credit notes

`ReturnsService.create` uses the same aggregate-then-check pattern: you cannot return more than was delivered, net of prior returns. Each returned line can carry a reason and a `responsibility` of `internal` | `vendor` | `client` | `delivery_agent` (`returns.service.ts:15`) — the field that decides who eats the cost.

The credit note is a separate platform-only step. Its unit price falls back through `invoice_items.unit_price → rfq_items.selling_price → the winning quote cost` (`returns.service.ts:125`), so a return against an already-invoiced order credits what was actually charged.

### Who pays: the payer scenario

`payer_type` (`cash_client` | `credit_client` | `insurance`) sits on the request header. Setting it is platform-only; an `insurance` payer must name an insurance company, and that company must belong to the same workspace — insurers *are* tenant-owned (`insurance_companies.tenant_id`), unlike vendors and workshops. When the payer is an insurer, the request goes out for approval before it can be confirmed; that is the entire purpose of the two insurance statuses.

`InsuranceService.transition` (`insurance.service.ts:77-105`) runs its own small state machine: only insurance-payer requests, never a confirmed one, no double-approve, and approval only from `sent_insurance_approval`. It takes a `FOR UPDATE` row lock first. **It is the one place in the codebase that writes a status column directly**, bypassing the status gateway — see §6.

---

## 5. The status vocabulary

Two vocabularies exist because a vendor's view of its own invitation ("I quoted, I lost, I shipped") is not the same as the item's view of itself. Both are seeded from `apps/api/drizzle/seed/reference-data.ts` and stored in **reference tables** (`item_statuses`, `vendor_statuses`), not Postgres enums. The stated reason (`enums.ts:3-7`) is that admin-extensible vocabulary should not need a migration — though note that no endpoint currently inserts into either table, so extending them today means editing the seed.

Each row keeps `legacyIds` — the integer `list_data` ids from the system QVM replaces — so migrating historical rows is a mapping rather than a translation. One deliberate cleanup: the old duplicate `Canceled` (18) and `Cancelled` (268) collapse into a single `cancelled` row carrying **both** legacy ids.

`ITEM_STATUSES` declares **26** entries — 24 preserved from the old system plus two added for the insurance flow (`reference-data.ts:24-56`). If you see the number 25 quoted anywhere, it is wrong.

### All 26 item statuses, in lifecycle order

Ordered by `sortOrder`. "Written?" means some code path actually moves a record into it today, verified by grepping every `toCode:` and every `item_statuses where code =` lookup in `apps/api/src`.

| # | Code | Label | Plain English | Written? |
|---|---|---|---|---|
| 1 | `new_rfq` | New RFQ | Just filed. Nobody has looked at it yet. | yes |
| 2 | `extract_pn` | Extract PN | The part number is missing, wrong, or ambiguous. A part-extractor has to identify the actual part before anyone can price it. | no |
| 3 | `ready_for_quotation` | Ready For Quotation | Cleaned up. Part numbers are trusted; it can go out to suppliers. | no |
| 4 | `tendering` | Tendering | Out with suppliers, quotes being collected. | no |
| 5 | `sent_to_vendor` | Sent To Vendor | The invitation has been dispatched to a specific supplier. | no |
| 6 | `added_by_vendor` | Added by Vendor | The line was introduced by a supplier rather than the customer — typically an alternative or superseding part. | no |
| 7 | `priced` | Priced | A winning quote has been chosen for this line. It is ready to confirm. | yes |
| 8 | `unavailable` | Unavailable | No supplier can supply it. Dead end for this line; siblings continue. | no |
| 9 | `sent_insurance_approval` | Sent for Insurance Approval | Insurer-paid job, waiting on the insurer's sign-off before ordering. | yes |
| 10 | `insurance_approved` | Approved by Insurance | The insurer agreed to pay. Ordering may proceed. | yes |
| 11 | `confirmed` | Confirmed | The customer committed. This is now a real order line. | yes |
| 12 | `processing` | Processing | Being picked and prepared, by the supplier or the warehouse. | no |
| 13 | `out_for_delivery` | Out for Delivery | Physically in transit. | no |
| 14 | `dn_sign_pending` | DN Sign Pending | Delivered, but the delivery note is not signed yet — no proof of receipt. | no |
| 15 | `delivered` | Delivered | Handed over and accepted. | yes |
| 16 | `pending_invoice` | Pending Invoice | Delivered and awaiting billing. | no |
| 17 | `invoice_issued` | Invoice Issued | The client invoice exists. Money is now owed. | yes |
| 18 | `cancellation_request` | Cancellation Request | Someone asked to cancel; not yet decided. | no |
| 19 | `cancelled` | Cancelled | Cancelled. Terminal. (Merges the old system's two spellings.) | no |
| 20 | `claim_sent` | Claim Sent | A claim was raised against a supplier or carrier — damage, wrong part, loss. | no |
| 21 | `return_request` | Return Request | The customer asked to send it back; not yet accepted. | no |
| 22 | `return` | Return | The return is accepted and in progress. | yes |
| 23 | `rn_sign_pending` | RN Sign Pending | Goods came back but the return note is unsigned. | no |
| 24 | `pending_credit_note` | Pending Credit Note | Return complete, credit not yet issued. | no |
| 25 | `credit_note_issued` | Credit Note Issued | The customer has been credited. | yes |
| 26 | `settled` | Settled | Fully paid and closed. Terminal. | no |

### The 14 vendor statuses

Applied to a supplier's invitation (`rfq_vendors`), not to the item. In `sortOrder` order — this is a catalogue, not a state machine; no transitions between them are declared anywhere in code:

`rfq` (RFQ Sent) · `priced` · `prior_price_confirmed` · `confirmed` (Confirmed Order) · `cancelled` · `unavailable` · `processing` · `ready_for_pickup` · `delivered` · `invoice_uploaded` · `return_request` · `returned` · `return_invoice_uploaded` · `settled`.

Three are written today: `rfq` on send (`vendor-rfq.service.ts:59`), `priced` on quote (`vendor-rfq.service.ts:220`), `confirmed` on order confirmation (`orders.service.ts:111`) and again — as an insert default — on purchase-order creation (`purchasing.service.ts:66`).

### Summary

```
item_statuses:    9 of 26 have a writer
vendor_statuses:  3 of 14 have a writer
```

The remaining 17 and 11 exist in the seeded catalog, are selectable in the workflow builder, and render in status badges — but no code moves a record into them. They are the old system's vocabulary, preserved on purpose so the eventual data migration is a mapping. Do not read a status's presence in the table as evidence that a stage is implemented.

---

## 6. How status changes are governed

`apps/api/src/common/status.service.ts` is the **only** place a status column is updated on an existing record. Its header states the problem it replaced: 22 direct status writes across 8 services, and a fully-designed `status_logs` table with zero writers and zero rows. That gap is why stage-speed reporting, early-vs-late cancellation analysis, and "reject a cancellation and restore what it was before" had no data source.

`transition` / `transitionMany` do four things that matter:

- read the current value **before** writing, so the log's `from_status_id` is real;
- refuse a no-op — a self-transition writes no log row, so history records actual movement;
- take the actor from the request context, never from a caller-supplied id;
- refuse the entire batch if any id is missing, rather than moving a subset silently.

The gateway knows ten entity kinds (`ENTITIES`, `status.service.ts:24-34`) and which vocabulary each speaks: `rfq`, `rfq_item`, `order`, `order_item`, `purchase_order`, `delivery`, `return`, `invoice`, `credit_note` speak `item`; `rfq_vendor` speaks `vendor`.

**One documented exception.** `InsuranceService.transition` still writes `update rfqs set status_id = …` directly (`apps/api/src/modules/insurance/insurance.service.ts:100`). Its own state machine is sound, but the move produces no `status_logs` row and is not checked against the workspace's workflow. Insurance status changes are therefore invisible to time-in-status reporting and to the flow engine.

### The workflow engine, briefly

Each workspace can draw its own state machine per environment and per status domain (`workflow_flows` / `workflow_steps` / `workflow_transitions` / `workflow_record_state`), and `assertTransitionAllowed` enforces it inside the same gateway. Three design choices are worth carrying into any change you make:

- **Permissive until configured.** With no active default flow — and no binding on the record — the guard returns silently and the system behaves exactly as it did before the engine existed. Rolling it out any other way would have frozen live orders on the day it shipped. The same applies per record: if the record's *current* status is not a step in the flow, the move is allowed, because the record is not really executing that flow.
- **Records pin to a flow version.** A record binds to the version live when it first moves and stays there (`flow_id` is deliberately not updated on conflict), so publishing a new version cannot strand an in-flight order.
- **Two independent role gates.** A step's `owner_roles` (who is responsible while a record sits there) and an edge's `allowed_roles` (who may fire that arrow). An empty list means silence, not denial. `super_admin` bypasses both, as break-glass for a workspace that has restricted a step to a role nobody holds.

The same code also records **custody**: each edge declares a `handoff` of `pool` (release to the destination step's owners), `keep` (current holder retains it), or `actor` (whoever made the move takes it). A pooled record whose destination step has exactly one possible owner is auto-assigned.

Activation is stricter than saving (`workflow.service.ts:764-820`): it refuses a flow with no entry step, more than one entry step, no terminal step, a non-terminal step with no outgoing edge, an unreachable step, or a **non-terminal** step whose owner role nobody in that workspace holds — because every order would stall there.

### Queue routing and its safety rule

`queuePredicate` (`apps/api/src/modules/workflow/routing.ts`) turns "which status shows on which page" into a `WHERE` clause. Its rule, stated at line 9:

> A status that the flow routes NOWHERE appears on EVERY page, exactly as it does today. Only a status deliberately routed somewhere is filtered out of the pages it was not routed to.

Without it, the first time an admin routed a single status, every other status would silently vanish from every queue, and the failure would surface as a customer phone call rather than an error. The predicate reads only `status = 'active'` flows, so a draft being edited changes nothing anyone sees. Callers that pass `undefined` get `sql\`true\`` — the query is byte-identical to before routing existed.

The page catalog (`apps/api/src/modules/workflow/pages.ts`) declares seven routable pages and carries a `wired: boolean` on each — deliberately, so that routing a live status to a mock screen is visible rather than discovered later. `/internal` is the one page marked `wired: false`.

---

## 7. What is not built

Verified by mapping every `api.get/post/patch/del` call in `apps/web/src` against every route in `apps/api/src/modules/*/*.controller.ts`.

### The entire fulfilment and finance half has no UI

Purchase orders, deliveries, client invoices, returns, credit notes, shipping, approvals, vendor payments, statements, and financing all have working, guarded backend services. **None of them has a frontend caller.** Unreachable from the browser:

```
POST/GET  /api/orders/:id/purchase-orders
POST      /api/purchase-orders/:poId/invoice
POST/GET  /api/orders/:id/deliveries
POST/GET  /api/orders/:id/invoice
POST/GET  /api/orders/:id/returns
POST      /api/returns/:returnId/credit-note
POST      /api/rfqs/:id/payer
POST      /api/rfqs/:id/insurance/send-for-approval | /approve
POST/GET  /api/insurance/companies
GET       /api/rfqs/:id/suggested-vendors
POST      /api/vendor-selection-rules
POST/GET  /api/shipping/*
POST/GET  /api/approvals/*
POST/GET  /api/vendor-finance/*
POST/GET  /api/vendor-selfservice/*
POST/GET  /api/parts/*
POST/GET  /api/pricing/*
GET       /api/audit-log
GET/POST  /api/calendar/*
```

The practical consequence: **an order can be created and confirmed through the UI, and then cannot be advanced any further without curl.**

There is also no order detail page. `apps/web/src/pages/Orders.tsx:53` renders rows with `cursor-pointer` but no click handler, and `App.tsx` declares no `/orders/:id` route. Since delivery, invoicing, and returns are all `POST /api/orders/:id/…`, that missing page is the natural home for the list above.

### Notifications never actually send

`apps/api/src/modules/notifications/notifications.service.ts` is designed as the single side-effect boundary — nothing may send email, WhatsApp, or a webhook except through it, and every attempt is written to `notification_log`. The dispatch branch is a stub (line 61):

```ts
if (status === "sent") {
  // real provider dispatch goes here (SMTP/WhatsApp/webhook), using `secret` for the link.
  void secret;
  this.logger.log(`SEND ${input.channel} → ${input.recipient} [${input.template}]`);
}
```

`void secret` discards the quote link. There is no SMTP, WhatsApp, or HTTP client dependency in `apps/api/package.json`. And `providerLive` requires `NODE_ENV === "production"` **and** a configured provider (`EMAIL_PROVIDER` other than `console`, or `WHATSAPP_ENABLED`) **and** a non-sandbox environment, so on a default deployment every message is logged as `suppressed`.

The chain of consequence matters for §4 stage 5a: the emailed `/quote-access/:token` link — the only way a supplier without a portal account can quote — is generated, hashed, stored, and then never delivered. In non-production the raw token comes back in the API response, which is how the smoke scripts exercise it. In production it is generated and discarded.

### Vendor auto-assignment only suggests

`vendor_selection_rules` supports an `automationMode` of `suggest` or `auto`, and `VendorAssignmentService.suggest` returns `autoSend: true` when a matching rule says `auto` (`vendor-assignment.service.ts:82`). The method itself *is* reachable — `GET /api/rfqs/:id/suggested-vendors` calls it — but nothing reads `autoSend`. No code path auto-sends a request to vendors, and no frontend calls the endpoint either.

### Two mock frontend pages

- `apps/web/src/pages/InternalDashboard.tsx` (`/internal`) — header comment at line 27: *"All data below is hardcoded Saudi B2B auto-parts MOCK data. No API calls."* Every button is a transient toast. "Send Vendor Request" shows a success message and does nothing, which is the dangerous one. It also carries a second status map keyed by the old numeric `list_data` ids that has already drifted from the seed file — line 42 still shows the merged-away spelling `"Canceled"` for id 18.
- `apps/web/src/pages/ManagementOverview.tsx` (`/management-overview`) — header comment at line 31: *"All numbers are hardcoded demo data."* To its credit, this is the only mock screen that labels itself, with a "Demo data" / "بيانات تجريبية" badge (line 575).

`apps/web/src/pages/Overview.tsx` is mixed, and its own header comment (lines 32-45) says which half is which: the `/rfqs` and `/orders` fetches, the derived KPI strip, and the "Recent RFQs" table are real; the pipeline status grid, distribution donut, needs-attention alerts, conversion funnel, top-vendors list and the requests-vs-orders trend are inline mock data. The real and fake numbers sit adjacent with identical styling.

### Other verified gaps

- **Queue routing does not reach the portal pages.** `pages.ts` declares `workshop_requests`, `workshop_orders`, `vendor_quotations`, and `vendor_confirmed` as routable, and the builder accepts routing statuses to them — but `queuePredicate` is imported in exactly two files, `rfq.service.ts` and `orders.service.ts`. The portal services never call it, so that configuration is saved and silently ignored.
- **Vendor self-service is `@PlatformOnly` as a stopgap.** Stock upload and pricing policies are managed by internal staff on the vendor's behalf; the controller comment (`vendor-selfservice.controller.ts:14-15`) says real vendor-role access opens "once vendor-user auth is wired into the guard".
- **31 of 56 navigation paths render a "Coming soon" placeholder.** 25 paths are listed in the `WIRED` set (`apps/web/src/App.tsx:66`); everything else in the persona nav trees falls through to `Placeholder()`.
- **Financing uses one hard-coded rate.** `FINANCING_INTEREST_PCT = 2.5` at `apps/api/src/modules/vendor-finance/vendor-finance.service.ts:7`, described in the code as a "single system-wide fixed rate".
- **The AI assistant is Gemini-only** (`apps/api/src/common/ai.service.ts:20` — any `AI_PROVIDER` other than `gemini` reports disabled) and has exactly one caller: proposing a workflow graph on the canvas (`workflow.service.ts:658`). It never writes to the database — the proposal is parsed through the same zod schema as the save path, rejected if it invents statuses, and then handed to the canvas for a human to review and save.

---

## 8. Reading order for a new engineer

1. `apps/web/src/nav.tsx` — the five personas and the entire intended surface area in one file.
2. `apps/web/src/App.tsx` — the `WIRED` set tells you what of that surface actually exists.
3. `apps/api/drizzle/seed/reference-data.ts` — the status vocabulary and its legacy mapping.
4. `apps/api/src/modules/rfq/rfq.service.ts` → `vendor-rfq.service.ts` → `orders/orders.service.ts` — the order chain, in order.
5. `apps/api/src/common/status.service.ts` — the status gateway and the workflow guard. Read the comments; they carry the reasoning.
6. `apps/api/src/modules/workflow/routing.ts` and `pages.ts` — queue routing and its deliberate fail-open behaviour.
7. `apps/api/src/common/auth.guard.ts` — how persona, workspace, role, and environment are resolved on every request.