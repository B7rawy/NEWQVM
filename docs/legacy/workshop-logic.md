# The workshop, as the legacy system actually implements it

Read from the running product on 2026-08-06 — the live Supabase project (`iqdmyvrrtcmvwupqinqq`),
its RPC and Edge Function sources, and the client repo (`AhmedSHG97/qvm-new-production`, master
`52e3bb5`, same day). Every rule below was read out of executable code or live data, not out of
anyone's memory of it. Where the legacy behaviour is a defect, it is marked **do not copy**.

Vocabulary mapping, first, because the two systems use different words for the same actors:

| Legacy word | Meaning | New-system word |
|---|---|---|
| client / customer | the workshop company / its branch | workshop / workshop_branch |
| quotation | the RFQ | rfq |
| quotation_item | the RFQ line | rfq_item |
| confirmed_order / confirmed_item | the order made from confirmed lines | order / order_item |
| cost (quotation_vendor_items) | a vendor's quote on a line | rfq_vendor_items |
| internal user (`user_type 185`) | Qparts back office | internal / platform staff |
| vendor user (`user_type 205`) | supplier | vendor |

## 1. Who the workshop user is, and what they can see

`qvm_new_apps.user_data` carries four numbers per user: `user_company`, `user_branch`,
`user_role`, `user_type`. The visibility rule, verbatim from `rfq_dashboard_paged`:

- `user_type = 185` → internal: sees everything.
- `user_role = 170` → **company-level workshop admin**: sees every quotation that touches ANY
  branch of their company (`client_branches.list_data_id = user_company`).
- any other role → **branch user**: sees only quotations containing at least one item of THEIR
  branch (`quotation_items.customer_id = user_branch`), and inside a quotation the item list is
  filtered to their branch again.

Two structural facts that follow:

- **The branch lives on the ITEM, not the request.** `quotations` has no branch column; the
  dashboard derives "the RFQ's branch" from its first item. A multi-branch RFQ is representable
  and the per-item scoping exists precisely to slice it per viewer.
- The company→branch tree is `list_data` (company) → `client_branches` (branch, keyed
  `customer_id`). 87 live branches across 4,418 companies (most legacy-synced, few active).

### The workshop's menu (from `Sidebar.tsx`, current production)

Overview · Management Overview · New RFQ → Regular RFQ (`/rfq-form`; Bulk exists but commented
out) · RFQs Dashboard (`/rfqs`, the V3 implementation) · Orders Dashboard (`/orders`) ·
Delivered Orders (`/delivered`) · Parts Pricing Report · Notes Archive (`/archive`).
Closed Orders and Targets exist but are commented out of the menu. Admin items (Users &
Permissions, Vendors, Profit Percentages…) are **internal-only** in the current app — the boards
that add them to the workshop are future design, not current behaviour.

## 2. The status catalog — one list drives everything

`lists.list_id = 3` ("item_status"). Statuses live on the **item**, never on the request; the
request's displayed status is derived. The full live catalog:

| id | status | phase |
|---|---|---|
| 15 | New RFQ | request |
| 235 | Ready For Quotation | request (internal prep) |
| 236 | Extract PN | request (internal prep) |
| 237 | Sent To Vendor | tendering |
| 16 | Tendering | tendering |
| 17 | Priced | tendering |
| 20 | Unavailable | tendering dead-end |
| 18 | Canceled | any-time dead-end |
| 19 | Confirmed | order |
| 21 | Processing | order |
| 22 | Out for Delivery | order |
| 23 | Delivered | order |
| 213 | DN Sign Pending | delivery paperwork |
| 25 | Pending Invoice | billing |
| 26 | Invoice Issued | billing |
| 27 | Claim Sent | billing |
| 24 | Cancellation Request | post-confirm exception |
| 28 | Return Request | returns |
| 29 | Return | returns |
| 214 | RN Sign Pending | returns paperwork |
| 215 | Pending Credit Note | returns billing |
| 30 | Credit Note Issued | returns billing |
| 31 | Settled | terminal |

The live data exercises the whole chain: confirmed_items rows currently sit in Confirmed, DN Sign
Pending, Delivered, Pending Invoice, Invoice Issued, Claim Sent, Return Request, RN Sign Pending,
Pending Credit Note, Credit Note Issued and Settled — so none of this list is theoretical.

**Derived request status** (frontend `deriveRfqStatusFromItems`, priority order): any Confirmed →
Confirmed; else any Priced → Priced; else any Tendering → Tendering; else any Sent To Vendor;
else any Ready For Quotation; else any Extract PN; else ALL Unavailable → Unavailable; else ALL
Canceled → Canceled; else canceled+unavailable mix → Unavailable; else New RFQ. (The RPC itself
returns the first item's status as `rfq_status`; the FE derivation is what the user actually
sees. Note the mismatch — pick ONE in the port; the derivation is the intended behaviour.)

## 3. Creating an RFQ — `create_quotation_with_items` (Edge Function, v52)

The submit path runs SIX server steps, and two of them can refuse creation outright:

1. **Region resolution** — `get_region_for_branch(customer_id)`. No region → refuse.
2. **Order number** — `generate_rfq_order_number(client_id, region_id)`: a prefix per
   client+region from `order_number_sequences` (14 configured), then max trailing number + 1.
   **No sequence row configured → creation fails.** Order numbers are per-client-per-region
   series, not global.
3. **Account manager auto-assignment** — `get_account_manager(customer_id)` EF (slots +
   allocations model). **No account manager resolvable → creation fails.** The AM is stamped on
   the quotation at birth.
4. `create_quotation` — advisor (the creating user), AM, order number, order/delivery type,
   plate number.
5. **Per item, an estimated price** — `get_estimated_price(client, part_number, brand_class)`:
   - same client bought same part+class in the last **60 days** → that price, verbatim;
   - else last vendor cost for part+class anywhere, aged: +1% if 90–180 days old, +3% if
     181–360, +7% if older;
   - else NULL → the UI flags it for manual review.
6. Items inserted, all `item_status = 15`; optional note via `create_quotation_note`.

Form-level rules: each part needs part_number OR description, qty ≥ 1, brand class required
(Genuine/OEM/Aftermarket/Used/Any). Header: plate, order type (Service Order | Stock), delivery
type (Speed | Same-Day | Standard 1+ days), optional VIN/brand/model/year, optional insurance
company. Photos upload via `upload_part_photos` and land as a JSON array in `part_photo`.
Production year is set by a direct table update AFTER creation (the RPC ignores it) — a wart, not
a feature. Unrecognized part names are logged for the synonyms dictionary. Internal staff can
create on behalf of a client ("internal mode").

## 4. The RFQs Dashboard (V3) — what the workshop does day-to-day

Read model `rfq_dashboard_paged`: search (order no / plate / part / VIN), filters (status,
delivery type, order type, advisor, date range), pagination; per item the workshop sees
`price_before_vat` (their price), `discount_percent`, `agency_price`, `estimated_price`, the
final part number/class chosen for it, non-internal note counts, and the **SLA of the winning
vendor quote** — `quotation_items.cost_id` points at the chosen `quotation_vendor_items` row and
the SLA rides along. Vendor identity and vendor cost are NOT exposed to the workshop.

Actions:

- **Add item to an existing RFQ** (`add_rfq_item_inline`) — enters at status 15 like any other.
- **Cancel items** (`cancel_items` EF → `cancel_rfq_items` RPC) with an optional reason from
  list 20 (Wrong part number, Price Too High, …). The FE offers cancel only in statuses
  15/235/236/237/17.
  **Do not copy:** the RPC itself has NO status guard and NO ownership check — any authenticated
  user can cancel any item id in any status, including Delivered. Only the UI restrains it. Our
  StatusService guard chain must stay the enforcement point.
- **Cart → Confirm** (`confirm_cart_items`): the workshop carts Priced items (only Priced —
  `canAddToCart`), adjusts an `approved_qty` per line (may differ from requested qty), and
  confirms. Server-side per batch: validates each item belongs to its claimed quotation, creates
  **one confirmed_order per distinct quotation in the batch**, copies lines into
  `confirmed_items` with `final_part_number = COALESCE(alternative_part_number, part_number)`
  and `final_brand_class`, flips the quotation_items to 19, logs to `status_logs`.
  Consequences to respect in the port: **partial confirmation is normal** (unconfirmed lines
  stay Priced), and **two confirm batches over one quotation create two orders** — order ≠
  quotation, it's "what was confirmed together".
  **Do not copy:** like cancel, no ownership check beyond `auth.uid() IS NOT NULL`.

Totals math (domain `pricing.ts`): line = price × (1 − discount%) × qty; VAT 15% on the
subtotal; + shipping fees ⇒ total. Currency SAR.

## 5. After confirmation — the order chain the workshop watches

`confirmed_items.item_status` carries the rest of the journey (the quotation item stays at 19):
Confirmed → Processing → Out for Delivery → Delivered, then paperwork and money:

- **Delivery notes** (`delivery_notes`, 14 live): items go DN Sign Pending → signed
  (`submit_delivery_note` EF, `email_delivery_note`), then Pending Invoice → Invoice Issued →
  Claim Sent → Settled.
- **Returns**: workshop raises Return Request with `client_return_reason` and
  `requested_return_qty` on the confirmed item; Return → RN Sign Pending (`return_notes`,
  `submit_return_note` EF) → Pending Credit Note → Credit Note Issued → Settled.
- **Cancellation Request (24)** is the post-confirmation escape hatch, distinct from plain
  Canceled (18) which is pre-confirmation.
- `confirmed_orders.client_po` lets the workshop attach their own PO number.

The workshop-facing pages over this chain: Orders Dashboard (`get_confirmed_orders_dashboard` +
`get_overall_order_summary`), Delivered Orders (delivery-note detail + issuance), Notes Archive
(`fetch_notes` — the notes system is polymorphic: `note_type` + `type_id`, with an `is_internal`
flag the workshop never sees past).

## 6. What this means for the port — gap list against easycarty

Already aligned (the rebuild anticipated most of the spine): item-level statuses with the same
id vocabulary; rfq → send → vendor quote → pick winner → confirm → deliveries → invoice chain;
status_logs; cancellation reasons list; insurance hook at creation; brand classes; the
extraction queue concept; per-item branch (`rfqs.workshop_branch_id` is per-request in ours —
see gap 7).

Genuinely missing in the new system, in the order the legacy flow hits them:

1. **Order-number sequences** per client+region with configured prefixes (our order_number is a
   simpler scheme). Port the sequence table + the max+1-with-lock generator, or decide openly to
   diverge.
2. **Account-manager auto-assignment at creation** (slots/allocations exist as Soon pages for
   us; legacy makes AM a hard creation dependency). Decide: hard-fail like legacy, or assign
   lazily.
3. **Estimated price** engine (60-day client memory, aged vendor-cost fallback, NULL = manual
   review). We have the columns (`estimated_price`) and no engine.
4. **Cart + approved_qty + partial confirmation + order-per-batch.** Our `/rfqs/:id/confirm`
   confirms a whole RFQ into one order. This is the biggest behavioural gap in the workshop
   experience.
5. **The post-delivery paperwork/money chain**: DN/RN signing states (213/214), Pending Credit
   Note (215), Claim Sent (27), Settled (31), client_po, requested_return_qty /
   client_return_reason. Our item_statuses already carry several of these ids; the flows and
   pages don't exist yet.
6. **Polymorphic notes** with internal/external visibility + notes archive (our `notes` table
   exists, empty, no UI).
7. **Company-level vs branch-level workshop visibility** (role 170 vs branch user). Our
   workshop portal currently scopes by workshop; the branch/company two-tier read model —
   including multi-branch RFQs — needs an explicit decision.
8. **Unrecognized-part-name capture** feeding a synonyms dictionary (the xlsx in the legacy repo
   root is that dictionary's seed).

Legacy defects to leave behind, on the record: no server-side status guard or ownership check on
cancel/confirm (UI-only enforcement); year written by a second direct UPDATE after create; the
RPC-vs-FE disagreement on derived RFQ status; `SELECT … FOR UPDATE` on a LIKE-scan as a sequence
lock (works, but a real sequence table row lock is what our port should use).
