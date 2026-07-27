# QVM Database

PostgreSQL 16, accessed through Drizzle ORM. Schema lives in `apps/api/drizzle/schema/` (28 `.ts` files), migrations in `apps/api/drizzle/migrations/` (50 files, `0000`–`0049`).

Two things make this database unusual, and both are worth understanding before you write a query:

1. **Tenant isolation is enforced by Postgres row-level security, not by `WHERE` clauses.** Most service code contains no `tenant_id` filter at all. It works because the app connects as a non-superuser role and every request runs inside a transaction that sets session variables the policies read.
2. **Live and Sandbox are the same tables.** A `sandbox` row and a `live` row sit next to each other in `orders`; a RESTRICTIVE RLS policy keeps them apart.

Everything below was verified against the files cited and against the local dev database (`docker exec qvm_postgres psql -U qvm -d qvm_platform`, read-only) on 2026-07-26.

---

## 1. Shape, in numbers

| Metric | Value | How to reproduce |
|---|---|---|
| Base tables in `public` | **93** | `pg_class where relkind='r'` |
| `pgTable(...)` declarations in `drizzle/schema/*.ts` | **93** | no table-count drift |
| Tables carrying `tenant_id` | 66 | |
| Tables carrying `environment` | 43 | |
| Tables with RLS enabled | 93 (all) | |
| Tables with `FORCE ROW LEVEL SECURITY` | 68 | |
| Postgres enum types | 39 | matches 39 `pgEnum(...)` calls in `enums.ts` |
| Indexes / foreign keys | 377 / 229 | |
| Migrations recorded in `drizzle.__drizzle_migrations` | 50 | |

Policies by name:

| Policy | Tables | Kind |
|---|---|---|
| `tenant_isolation` | 65 | permissive, `FOR ALL` |
| `environment_isolation` | 42 | **RESTRICTIVE**, `FOR ALL` |
| `global_write` | 27 | permissive, internal-only writes |
| `global_read` | 22 | permissive, `USING (true)` |
| `directory_read` | 3 | `vendors`, `workshops`, `service_providers` |
| `pa_read` / `pa_insert` | 1 each | `platform_audit` |
| `user_self_or_internal_read` | 1 | `users` |
| `platform_member_internal_read` | 1 | `platform_members` |

Three of these counts do not line up with the table counts. All three have explanations that hold:

- **66 tables have `tenant_id`, 65 have `tenant_isolation`.** The odd one out is `platform_audit`, which got bespoke policies in `0034_audit_hardening.sql` instead.
- **43 tables have `environment`, 42 have the restrictive policy.** `order_number_counters` is deliberately exempt (§6).
- **68 tables FORCE RLS, but only 66 have `tenant_id`.** The extras are `workshops` and `workshop_branches`. `0001_security_functions.sql` forced RLS on them while they still had a `tenant_id`; `0027_shared_workshops.sql` dropped that column and moved them to `apply_global_rls`, which does not FORCE. The flag was never cleared. Harmless — the owner role is a superuser and bypasses RLS regardless — but it is residue, not intent.

**How full is it.** On the local dev database, **41 of 93 tables hold any rows at all**. `item_statuses` has 26, `counterparty_submissions` 16, `vendor_statuses` 14, `users` 6, `vendors` 6, `rfqs` 1, `orders` 1. `invoices`, `purchase_orders`, `deliveries`, `notification_log`, and all four `workflow_*` tables are empty. Shipping, billing, purchasing, approvals, financing and the workflow engine are schema-and-code with no data behind them. Treat any behavioural claim about those modules as unverified until you exercise it yourself.

---

## 2. Shared column conventions — `drizzle/schema/_shared.ts`

41 lines of column builders that every table composes. The point is to make inconsistency impossible rather than merely discouraged — the header lists the old-system defects each one closes.

| Builder | Definition | Why |
|---|---|---|
| `pk()` | `uuid("id").primaryKey().default(sql\`gen_random_uuid()\`)` | Old PKs were bigint identity, and therefore enumerable |
| `timestamps` | `created_at`, `updated_at` — `timestamptz NOT NULL DEFAULT now()` | Old system mixed `timestamp`/`timestamptz` and defaulted to `Asia/Riyadh`; everything here is UTC |
| `authorship` | `created_by`, `updated_by` — nullable `uuid` | Written by a trigger from the session, never from the request body |
| `audit` | `timestamps` + `authorship` | The standard block on transactional tables |
| `money(name)` | `numeric(14,2)` | Old system stored money as mixed `float8` / `float4` / `text` |
| `pct(name)` | `numeric(5,2)` | e.g. `12.50` |
| `isActive()` | `boolean NOT NULL DEFAULT true` | |

**Append-only tables use `timestamps`, not `audit`.** An `updated_by` on an immutable log row is meaningless, so `cost_logs`, `pricing_logs` and `notification_log` carry `created_by` and no `updated_by`. `attachments`, `status_logs`, `profit_margin_audit` and `order_number_counters` carry `created_at`/`updated_at` but **no authorship columns at all** — they use domain-specific ones instead (`uploaded_by`, `changed_by`). `platform_audit` is stricter still: `created_at` only, plus `actor_user_id` / `impersonator_id`.

### The audit trigger

`0001_security_functions.sql` installs two trigger functions and attaches them by inspecting `information_schema`:

```sql
-- set_row_audit(), BEFORE INSERT OR UPDATE, on every table with an updated_by column
INSERT: new.created_by := coalesce(new.created_by, app_user_id());
        new.updated_by := coalesce(new.updated_by, new.created_by);
UPDATE: new.created_at := old.created_at;   -- restored, not trusted
        new.created_by := old.created_by;   -- restored, not trusted
        new.updated_at := now();
        new.updated_by := app_user_id();
```

```sql
-- set_created_by(), BEFORE INSERT, on tables with created_by but NO updated_by
new.created_by := coalesce(new.created_by, app_user_id());
```

Live: `trg_set_row_audit` on **74** tables, `trg_set_created_by` on exactly **3** (`cost_logs`, `pricing_logs`, `notification_log`), no audit trigger on the remaining 16 — the 11 reference-vocabulary tables plus `attachments`, `status_logs`, `profit_margin_audit`, `platform_audit` and `order_number_counters`.

Two things follow from this that matter in practice:

- **Authorship comes from the session GUC, never the payload.** This is the structural fix for the old system's spoofable audit identity: a client can put anything in `created_by` and the trigger overwrites it. On UPDATE the trigger *restores* `created_at`/`created_by` from `OLD`, so they cannot be rewritten either.
- **A tenant-scoped table must have the full `audit` block.** `apply_tenant_rls()` attaches `trg_set_row_audit` unconditionally, and `set_row_audit()` assigns `new.created_by`. A table using bare `timestamps` that goes through `apply_tenant_rls` dies on first insert with `record new has no field created_by`. `workflow_record_state` documents exactly this in a comment (`drizzle/schema/workflow.ts`) and uses `audit` for that reason alone.

### Enums versus reference tables

The rule is stated at the top of `drizzle/schema/enums.ts` and is the single most useful thing to internalise about this schema:

> PostgreSQL enums = fixed, small, code-controlled sets the user does NOT extend. Business vocabulary that admins may extend (statuses, brands, regions, reasons) lives in reference TABLES instead.

So `order_type` is a 2-value enum that code branches on, while `item_statuses` is a table with 26 rows an admin can extend without a migration. This replaces the old system's generic `lists` / `list_data`, where a `car_brand` id and an `item_status` id shared one id space and could be stored in each other's columns.

39 enums exist. The ones you will meet immediately:

| Enum | Values | Note |
|---|---|---|
| `environment_type` | `live`, `sandbox` | The row-level boundary (§6) |
| `status_domain` | `item`, `vendor` | Which status vocabulary a polymorphic row speaks |
| `entity_type` | 11 values, `rfq` … `credit_note` | Used as an actual enum column on exactly four tables: `attachments`, `notes`, `status_logs`, `workflow_record_state` |
| `membership_role` | 10 values (platform / company / vendor side) | Per-tenant role, on `tenant_memberships` |
| `platform_role` | 7 values | **A different enum.** A `platform_members` row means the user sees *all* workspaces. Adds `finance_manager` and `pricing_supervisor`, which `membership_role` lacks |
| `counterparty_type` | `individual`, `company` | Named to avoid colliding with the pre-existing `entity_type` |
| `workflow_flow_status` | `draft`, `active`, `retired` | The comment argues for an enum over `text` explicitly: three guards key on `'active'`, and a stray `'Active'` would silently escape every one |
| `return_reason_side` | `client`, `internal` | Lets one `return_reasons` table hold both old vocabularies, discriminated |

Note that `membership_role` and `platform_role` **share five value strings** (`super_admin`, `staff`, `account_manager`, `purchasing`, `part_extractor`). This is why the API has a separate `@PlatformOnly()` decorator rather than `@Roles("super_admin")` — see `apps/api/src/common/roles.decorator.ts`, whose comment says exactly this.

Watch for the inconsistency: `approval_policies.entity_type`, `approval_requests.entity_type`, `audit_log.entity_type` and `platform_audit.entity_type` are **free `text`**, not the enum. Nothing stops a typo in those four columns.

---

## 3. Table catalogue

93 tables, grouped by the schema file that declares them. Audit columns (`created_at`, `updated_at`, `created_by`, `updated_by`) are omitted from the key-column lists; assume they are present unless §2 says otherwise. `T` = carries `tenant_id`; `E` = carries `environment`.

### 3.1 Tenancy — `tenancy.ts`

| Table | | What it is | Key columns |
|---|---|---|---|
| `plans` | | Subscription plans, super-admin managed | `code`, `name`, `features` jsonb, `is_active` |
| `tenants` | | **A workspace** — one operator (e.g. Qparts) with its own subdomain, members, RFQs, orders | `name`, `slug`, `logo_url`, `settings` jsonb, `plan_id`, `is_active` |

### 3.2 Identity — `identity.ts`

| Table | | What it is | Key columns |
|---|---|---|---|
| `users` | | Global account. Self-hosted auth (argon2 hash + JWT). No `tenant_id` — one person can belong to several workspaces | `email`, `password_hash`, `full_name`, `phone`, `is_active` |
| `platform_members` | | A row here = Qparts internal staff = sees **every** workspace | `user_id`, `role` (`platform_role`), `is_active` |
| `tenant_memberships` | T | A user's role inside one workspace | `tenant_id`, `user_id`, `role` (`membership_role`), `workshop_branch_id`, `is_active` |

### 3.3 Reference vocabulary — `reference.ts` (11 tables, all global)

Each concept gets its own table so a `car_brand` id can never land in a status column. Every row carries a stable machine `code`, bilingual `label_en` / `label_ar`, `sort_order`, `is_active`, and a nullable `legacy_id` — the old `list_data_id`, kept only to map old rows during migration and unused at runtime.

| Table | What it is |
|---|---|
| `item_statuses` | The item lifecycle vocabulary. 26 rows, preserved verbatim from the old system (old list 3) |
| `vendor_statuses` | Supplier-side lifecycle (old list 15). 14 rows |
| `car_brands` | Vehicle manufacturers |
| `brand_classes` | Part-brand tier — Genuine / OEM / Aftermarket / Used |
| `part_categories` | Part taxonomy |
| `regions` | Saudi regions |
| `cities` | `region_id` + the standard reference columns — the one reference table with a parent |
| `cancellation_reasons` | Why an order was cancelled |
| `return_reasons` | Plus `side` (`client` \| `internal`) — one table holding both old vocabularies |
| `payment_accounts` | Payment **methods** lookup, despite the name (`0045`'s header says so explicitly) |
| `cost_ranges` | Cost bands (`lower_bound`, `upper_bound`) used by the margin tables |

### 3.4 Counterparty directories (11 tables)

Three parallel families. Each has a **global** entity table (no `tenant_id`), a person↔company mapping, optionally branches, and a tenant-scoped link table.

| Table | | What it is | Key columns |
|---|---|---|---|
| `vendors` (`vendors.ts`) | | Global supplier identity | `legal_name`, `commercial_registration_number`, `tax_number`, `primary_email`, `primary_phone`, `vendor_type`, `counterparty_type`, `activation_status`, `payment_terms_days` |
| `vendor_branches` | | Vendor locations | `vendor_id`, `name`, `region_id`, `city_id`, `address`, `location`, `payment_method` |
| `vendor_users` | | Which user belongs to which vendor | `vendor_id`, `user_id`, `is_vendor_admin` |
| `tenant_vendors` | T | Workspace ↔ vendor link | `tenant_id`, `vendor_id`, `status`, `payment_terms`, `classification`, `agreement`, `linked_by` |
| `workshops` (`org.ts`) | | Global client (repair shop) identity | `name`, `tax_number`, `counterparty_type`, `activation_status`, `primary_phone`, `primary_email`, `commercial_registration_number` |
| `workshop_branches` | | Branches — the customer on every RFQ | `workshop_id`, `name`, `region_id`, `city_id`, `order_category`, `is_bulk` |
| `workshop_users` | | User ↔ workshop | `workshop_id`, `user_id`, `is_workshop_admin` |
| `tenant_workshops` | T | Workspace ↔ workshop link | `tenant_id`, `workshop_id`, `status`, `settings`, `linked_by` |
| `service_providers` (`service_providers.ts`) | | Third family: shipping / inspection / claims partners | `legal_name`, `counterparty_type`, `activation_status`, `scope` (`internal`\|`external`), `service_type`, `tax_number` |
| `service_provider_users` | | User ↔ provider | `service_provider_id`, `user_id`, `is_provider_admin` |
| `tenant_service_providers` | T | Workspace ↔ provider link | `tenant_id`, `service_provider_id`, `status`, `classification`, `agreement`, `linked_by` |

### 3.5 Onboarding pipeline — `counterparty.ts`

A workspace never writes a directory row directly (they are `global_write`, internal-only). It **submits** a proposal into a tenant-scoped review queue; a match engine attaches candidates; an admin approves, merges or rejects.

| Table | | What it is | Key columns |
|---|---|---|---|
| `import_batches` | T | One Excel upload job → many submission rows | `kind`, `filename`, `status`, `total_rows`, `valid_rows`, `error_rows`, `uploaded_by` |
| `counterparty_submissions` | T | The review queue row | `kind`, `counterparty_type`, `legal_name`, `tax_number`, `commercial_registration_number`, `mobile`, `email`, `classification`, `payload`, `source`, `import_batch_id`, `status`, `match_candidates` jsonb, `resolved_entity_id`, `review_notes`, `reviewed_by`, `reviewed_at`, `submitted_by` |

### 3.6 Parts master data — `parts.ts` (global)

| Table | What it is | Key columns |
|---|---|---|
| `parts_master` | Canonical part record. `source` is mandatory provenance | `name_ar`, `name_en`, `part_category_id`, `source` (`part_source`), `is_active` |
| `part_synonyms` | Alternative names | `part_id`, `synonym` |
| `part_category_mapping` | Raw text variant → category, for import normalisation | `raw_variant`, `part_category_id` |

### 3.7 The order chain (22 tables) — the spine

```
rfqs ──< rfq_items                           a workshop branch asks for parts
  └──< rfq_vendors ──< rfq_vendor_items      the same RFQ goes to N vendors; each quotes per line
                             │
orders ──< order_items ──────┘               the winning quote per line is confirmed
  │            │  (winning_vendor_quote_item_id)
  │            ├──< delivery_items    <── deliveries       what shipped (partial supported)
  │            ├──< invoice_items     <── invoices         what the client was billed
  │            ├──< credit_note_items <── credit_notes     what was credited back
  │            ├──< return_items      <── returns          what came back
  │            └──< return_issues                          who was at fault
  └──< purchase_orders ──< purchase_items                  what was bought from each vendor
              ├──< pickups ──< pickup_items
              └──< vendor_credit_notes ──< vendor_credit_note_items
```

**`rfq.ts`**

| Table | | What it is | Key columns |
|---|---|---|---|
| `rfqs` | T E | RFQ header. `order_number` is issued from the atomic counter and **reused verbatim by the order** (`orders.service.ts:77` — `orderNumber: rfq.order_number`) | `order_number`, `workshop_branch_id` (**NOT NULL** — the customer is at the header), `plate_number`, `vin`, `car_brand_id`, `model`, `order_type`, `delivery_type`, `shipping_type`, `service_advisor_id`, `account_manager_id`, `status_id`, `shipping_price`, `payer_type`, `insurance_company_id`, `customer_name_snapshot` |
| `rfq_items` | T E | One requested part | `rfq_id`, `part_number`, `part_description`, `alternative_part_number`, `quantity`, `car_year`, `brand_class_id`, `part_category_id`, `part_photo_key`, `vin`, `status_id`, `selling_price`, `discount_pct`, `agency_price`, `winning_vendor_quote_item_id`, `extraction_status`, `extracted_by`, `extracted_at` |
| `rfq_vendors` | T E | One vendor's invitation to quote | `rfq_id`, `vendor_id`, `vendor_branch_id`, `status_id` (vendor vocabulary), `token_hash`, `token_expires_at`, `sent_at` |
| `rfq_vendor_items` | T E | One vendor's quote for one line | `rfq_vendor_id`, `rfq_item_id`, `offered_cost`, `discount_pct`, `sla_hours`, `available_qty`, `available_brand_class_id`, `alternative_part_number`, `status_id`, `notes` |

The emailed vendor-access token is stored **hashed only** (`rfq_vendors.token_hash`, unique index `rfq_vendors_token_hash_uq`) with an expiry. The comment records that the old system stored it in plaintext.

**`orders.ts`**

| Table | | What it is | Key columns |
|---|---|---|---|
| `orders` | T E | Confirmed order. Unique on `(rfq_id)` and on `(tenant_id, order_number)` | `rfq_id`, `order_number`, `client_po`, `status_id` |
| `order_items` | T E | **THE SPINE.** Delivery, invoice, credit note, return and issue all hang off `order_item_id`. Unique on `(rfq_item_id)` — strictly one order line per RFQ line | `order_id`, `rfq_item_id`, `final_part_number`, `approved_qty`, `winning_vendor_quote_item_id`, `status_id` |

**`purchasing.ts`**

| Table | | What it is | Key columns |
|---|---|---|---|
| `purchase_orders` | T E | One PO per (order, vendor) — unique on `(order_id, vendor_id)`, added in `0034` as an idempotency backstop | `order_id`, `vendor_id`, `payment_account_id`, `status_id`, `vendor_invoice_number`, `invoice_amount`, `uploaded_by`, `vendor_name_snapshot` |
| `purchase_items` | T E | PO lines. Cost stays on the quote row, not copied | `purchase_order_id`, `order_item_id`, `vendor_quote_item_id`, `qty`, `status_id` |
| `pickups` | T E | Collection from a vendor | `purchase_order_id`, `delivery_agent_id`, `status_id` |
| `pickup_items` | T E | | `pickup_id`, `purchase_item_id`, `qty` |
| `vendor_credit_notes` | T E | Credit **from** a vendor | `purchase_order_id`, `credit_note_number`, `total`, `status_id` |
| `vendor_credit_note_items` | T E | | `vendor_credit_note_id`, `purchase_item_id`, `return_qty`, `return_reason_id`, `responsibility` |

**`fulfillment.ts`**

| Table | | What it is | Key columns |
|---|---|---|---|
| `deliveries` | T E | A delivery event. Split delivery is supported: one order line can span several `delivery_items` | `order_id`, `delivery_number`, `client_po`, `delivery_company`, `shipping_price`, `shipping_cost`, `signature_id`, `signed_by`, `status_id`, `delivered_at` |
| `delivery_items` | T E | `qty` sent vs `received_qty` — the discrepancy drives the return flow | `delivery_id`, `order_item_id`, `qty`, `received_qty`, `invoice_id` |
| `returns` | T E | | `order_id`, `return_number`, `signature_id`, `signed_by`, `status_id`, `returned_at` |
| `return_items` | T E | | `return_id`, `order_item_id`, `qty`, `return_reason_id`, `responsibility`, `credit_note_id` |
| `return_issues` | T E | Fault attribution for a returned line | `order_item_id`, `responsibility`, `issue_type`, `delivery_agent_id`, `main_vendor_id`, `part_number_source`, `notes`, `status_id` |
| `signatures` | T E | Stored signature image referenced by delivery/return notes | `image_key`, `signed_by` |

**`billing.ts`**

| Table | | What it is | Key columns |
|---|---|---|---|
| `invoices` | T E | Client invoice. Unique on `(order_id)` — one per order, added in `0034` | `order_id`, `invoice_number`, `issued_at`, `due_date`, `paid_at`, `total_before_vat`, `vat_amount`, `total_incl_vat`, `external_ref`, `status_id` |
| `invoice_items` | T E | | `invoice_id`, `order_item_id`, `qty`, `unit_price` |
| `credit_notes` | T E | Credit **to** the client | `order_id`, `credit_note_number`, `issued_at`, `total`, `external_ref`, `status_id` |
| `credit_note_items` | T E | | `credit_note_id`, `order_item_id`, `qty`, `return_reason_id` |

### 3.8 Pricing, margins, insurance (10 tables)

| Table | | What it is | Key columns |
|---|---|---|---|
| `cost_logs` (`pricing.ts`) | T E | Append-only cost history per RFQ line per vendor | `rfq_item_id`, `vendor_id`, `cost`, `pricing_source` |
| `pricing_logs` | T E | Append-only selling-price history | `rfq_item_id`, `price`, `pricing_source` |
| `profit_categories` | T | (part category × brand class) grouping for margins | `name`, `part_category_id`, `brand_class_id` |
| `profit_margins` | T | Margin % per (category × cost band) | `profit_category_id`, `cost_range_id`, `margin_pct` |
| `profit_margins_branch` | T | Per-branch override of the above | `workshop_branch_id`, `profit_category_id`, `cost_range_id`, `margin_pct` |
| `profit_margin_audit` | T | Who changed a margin | `profit_margin_id`, `old_value`, `new_value`, `changed_by` |
| `stock_files` | T E | Imported vendor stock/price file rows | `file_date`, `part_number`, `brand_class_id`, `car_brand_id`, `cost_before_discount`, `discount_pct`, `vendor_id`, `meta` |
| `agency_price_reference` (`pricing_engine.ts`) | T | Saved agency price per part number | `part_number`, `price`, `source`, `price_updated_at` |
| `pricing_basis_settings` | T | Per (payer scenario × optional insurer): how the selling price is derived | `payer_scenario`, `insurance_company_id`, `price_basis`, `adjustment_type`, `adjustment_pct` |
| `insurance_companies` (`insurance.ts`) | T | **Tenant-owned**, unlike vendors/workshops | `name`, `suggested_discount_pct`, `file_format`, `contact_info`, `is_active` |

### 3.9 Vendor operations (7 tables)

| Table | | What it is | Key columns |
|---|---|---|---|
| `vendor_selection_rules` (`vendor_assignment.ts`) | T | branch (null = all) + category (null = all) + city (null = any) → vendors, `suggest` or `auto` | `workshop_branch_id`, `part_category_id`, `city_id`, `automation_mode`, `is_active` |
| `vendor_selection_rule_vendors` | T | The rule's vendor set | `rule_id`, `vendor_id` |
| `vendor_stock_items` (`vendor_selfservice.ts`) | T E | Vendor catalogue as used in a workspace. The schema comment marks real `quantity` as internal-only, externally shown as Available/Not-Available — that is a stated intent, not something enforced by a constraint | `vendor_id`, `raw_part_number`, `cleaned_part_number`, `name_en`, `name_ar`, `part_type`, `quantity`, `wholesale_price`, `retail_price`, `price_before_discount`, `upload_source` |
| `vendor_pricing_policies` | T | Discount or markup by scope; most-specific wins (`client_branch > region > global`) | `vendor_id`, `scope_type`, `region_id`, `workshop_branch_id`, `adjustment_type`, `adjustment_pct` |
| `vendor_payments` (`vendor_finance.ts`) | T E | Payment to a vendor | `vendor_id`, `amount`, `paid_at`, `reference`, `upload_source` |
| `vendor_payment_allocations` | T E | Many-to-many payment ↔ PO, so partial payments work | `payment_id`, `purchase_order_id`, `allocated_amount` |
| `vendor_financing_requests` | T E | Invoice financing | `vendor_id`, `requested_amount`, `interest_rate_pct`, `interest_amount`, `status`, `sla_due_date`, `approved_by` |

### 3.10 Shipping and logistics — `shipping.ts`

| Table | | What it is | Key columns |
|---|---|---|---|
| `shipping_carriers` | | Global carrier catalogue | `carrier_name`, `carrier_model`, `is_active` |
| `entity_carrier_settings` | T | A vendor's or branch's carrier configuration | `owner_type`, `owner_id`, `carrier_id`, `default_pickup_location`, `is_active` |
| `drivers` | T | Private or marketplace drivers | `owner_type`, `user_id`, `vehicle_details`, `verification_status`, `completed_orders_count`, `is_active` |
| `shipments` | T E | | `order_id`, `entity_carrier_setting_id`, `driver_id`, `tracking_number`, `status`, `cost` |
| `driver_delivery_requests` | T E | Broadcast/accept marketplace. Partial unique index `ddr_one_accepted_per_order_uq`: at most one `accepted` per order | `order_id`, `driver_id`, `status`, `responded_at` |

### 3.11 Approvals — `approvals.ts`

Generic multi-level engine. `entity_type` here is free `text`, not the enum — nothing constrains what you attach a policy to. Levels name a specific **user**, not a role.

| Table | | Key columns |
|---|---|---|
| `approval_policies` | T | `name`, `entity_type` (text), `level_mode` (`sequential`\|`parallel`), `is_active` |
| `approval_levels` | T | `policy_id`, `level_order`, `approver_user_id`, `is_required` |
| `approval_requests` | T E | `policy_id`, `entity_type` (text), `entity_id`, `requested_by`, `current_level`, `overall_status`. Partial unique index: at most one `pending` per (tenant, entity_type, entity_id) |
| `approval_actions` | T E | `request_id`, `actor_user_id`, `action`, `reassigned_to_user_id`, `comment` |

### 3.12 Workflow engine — `workflow.ts`

| Table | | What it is | Key columns |
|---|---|---|---|
| `workflow_flows` | T E | A versioned state machine owned by the workspace | `flow_key`, `version`, `name_en/ar`, `status` (`draft`\|`active`\|`retired`), `is_default`, `status_domain`, `selection_condition` jsonb, `canvas` jsonb |
| `workflow_steps` | T E | A node = one status | `flow_id`, `status_domain`, `item_status_id`, `vendor_status_id`, `sort_order`, `is_entry`, `is_terminal`, `sla_hours`, `canvas_x`, `canvas_y`, `pages` jsonb, `owner_roles` jsonb |
| `workflow_transitions` | T E | An arrow | `flow_id`, `from_step_id`, `to_step_id`, `label_en/ar`, `requires_approval`, `allowed_roles` jsonb, `condition` jsonb, `priority`, `handoff` |
| `workflow_record_state` | T E | Which flow a record is bound to, and who holds it now | `entity_type`, `entity_id`, `status_domain`, `flow_id`, `assignee_user_id`, `assignee_role`, `step_entered_at`, `due_at` |

Details in §10. Note that five of the columns listed above exist only in the database and in raw SQL — see gap 1 in §11.

### 3.13 Cross-cutting and infra (9 tables)

| Table | | What it is | Key columns |
|---|---|---|---|
| `attachments` (`crosscutting.ts`) | T E | **One** attachments table, replacing four old ones (`files`, `quotation_attachments`, `purchase_invoice_attachments`, `returned_issue_attachments`) | `entity_type`, `entity_id`, `file_key`, `file_name`, `mime_type`, `size_bytes`, `uploaded_by` |
| `status_logs` | T E | One polymorphic append-only status history instead of per-table columns | `entity_type`, `entity_id`, `status_domain`, `from_status_id`, `to_status_id`, `changed_by` |
| `notes` | T E | One polymorphic notes table | `entity_type`, `entity_id`, `body`, `is_internal` |
| `notification_log` | T E | Every outbound message attempt | `channel`, `recipient`, `template`, `payload`, `status` |
| `order_number_counters` | T E | Per-(tenant, prefix, environment) counter, incremented atomically | `region_id`, `prefix`, `next_value` |
| `audit_log` (`infra.ts`) | T E | Generic who-changed-what within a workspace | `entity_type` (text), `entity_id`, `actor_user_id`, `action`, `old_value`, `new_value` |
| `business_calendar_settings` | T | Working days and hours, for SLA/deadline computation | `working_days`, `day_start_minute`, `day_end_minute`, `timezone` |
| `business_holidays` | T | | `holiday_date`, `name` |
| `platform_audit` (`platform_audit.ts`) | T (nullable) | Cross-**workspace** admin actions: impersonation, membership/vendor status changes, workspace edits. Append-only for the app role | `tenant_id` (nullable — impersonation is not tied to one), `actor_user_id`, `impersonator_id`, `action`, `entity_type` (text), `entity_id`, `metadata` |

---

## 4. Tenant isolation

### The model

A **tenant** is a whole workspace, reachable at its own subdomain (`tenants.slug`), owning its members, RFQs and orders.

Counterparties are **global**, not per-tenant. `vendors`, `workshops` and `service_providers` have no `tenant_id`; a workspace reaches them through a link table that does:

| Global entity | Person mapping | Tenant-scoped link |
|---|---|---|
| `vendors` | `vendor_users` | `tenant_vendors` |
| `workshops` | `workshop_users` | `tenant_workshops` |
| `service_providers` | `service_provider_users` | `tenant_service_providers` |

`users` is global too, so one person can hold memberships in several workspaces.

**Why.** The same real supplier serves several operators. Tenant-scoping the vendor row would mean N duplicate rows for one legal entity, with no way to say "this is the same company" — and no way to build the match engine that the onboarding queue depends on. Transaction rows (`rfq_vendors`, `purchase_orders`, …) always carry their own `tenant_id`, so history stays isolated per workspace even when the counterparty is shared. `0027_shared_workshops.sql` performed this conversion for workshops after the fact: it dropped `tenant_id` from `workshops` and `workshop_branches` with `CASCADE` (which took their `tenant_isolation` policies with it — the migration says so on line 46), created `tenant_workshops`, and re-applied the correct policies.

### The mechanism

`apps/api/src/db/db.service.ts` connects using `process.env.APP_DATABASE_URL` — which **must** point at the non-superuser `qvm_app` role, created by `0002_app_role.sql`. `withContext()` opens a transaction and sets five transaction-local GUCs:

```ts
await tx.execute(sql`select
  set_config('app.tenant_id',       <tenantId ?? ''>,       true),
  set_config('app.user_id',         <userId ?? ''>,         true),
  set_config('app.is_internal',     <'true'|'false'>,       true),
  set_config('app.environment',     <'live'|'sandbox'>,     true),
  set_config('app.impersonator_id', <impersonatorId ?? ''>, true)`);
```

The third argument `true` means *transaction-local*: the settings die with the transaction and cannot leak across a pooled connection.

Four `STABLE` reader functions expose these to policies (`0001_security_functions.sql`, `0041_environment_rls.sql`). All four are `SET search_path = ''` so a hostile `search_path` cannot shadow them:

```sql
current_tenant_id()    -- nullif(current_setting('app.tenant_id',   true), '')::uuid
app_user_id()          -- nullif(current_setting('app.user_id',     true), '')::uuid
app_is_internal()      -- coalesce(current_setting('app.is_internal',true), 'false') = 'true'
current_environment()  -- coalesce(nullif(current_setting('app.environment',true),''),'live')::environment_type
```

**This is the single highest-consequence configuration fact in the system.** A superuser, and a table's own owner, bypass RLS. If `APP_DATABASE_URL` ever points at the owner role, every policy silently stops applying and nothing fails loudly — every request returns every workspace's data. `db.service.ts` says so in a comment; `0002_app_role.sql` says so in a comment; `docs/CONVENTIONS.md` (Arabic) rule DB-2 says so.

### `apply_tenant_rls(p_table text)`

Current live definition (from `pg_get_functiondef`; last replaced by `0041_environment_rls.sql`). Five steps, all idempotent — which is why migrations call it freely:

1. `ENABLE` **and** `FORCE ROW LEVEL SECURITY`.
2. Create `tenant_isolation` if absent — permissive, `FOR ALL`:
   ```sql
   USING      (tenant_id = current_tenant_id() OR app_is_internal())
   WITH CHECK (tenant_id = current_tenant_id() OR app_is_internal())
   ```
3. **If the table has an `environment` column, call `apply_environment_rls` on it.** (Added in `0041`; see §6.)
4. Drop and recreate `trg_set_row_audit`.
5. `GRANT SELECT, INSERT, UPDATE, DELETE ... TO qvm_app`.

`FORCE` matters because a table's owner is exempt from its own policies by default. Without it, running migrations or a script as the owner would silently see everything — which is fine for migrations but a trap for anything else.

### The `app_is_internal()` escape

`tenant_isolation` deliberately contains `OR app_is_internal()`. Platform staff work across workspaces, and so do the vendor / workshop / service-provider portals: a vendor logged into its own portal sees its rows across *every* linked workspace, which by definition is not a single-tenant query. The API opens those transactions with `isInternal: true` and derives ownership in the service layer instead.

Keep this in mind. It is a real hole in tenant isolation, opened on purpose, and it is exactly why the environment policy could not be permissive (§6).

### `apply_global_rls(p_table text)`

For tables with no `tenant_id`. Enables RLS but **does not FORCE it**, then creates `global_read` (`FOR SELECT USING (true)`) and `global_write` (`FOR ALL USING/WITH CHECK (app_is_internal())`). Same trigger, same grant. Intent: shared vocabulary readable by everyone, writable only by platform staff. The live function body contains no reference to `environment` — only `apply_tenant_rls` gained that branch.

### Where the blanket read had to be narrowed

`global_read USING (true)` is right for `car_brands`. It was wrong for tables holding personal data, and two migrations fixed specific cases.

**`0032_individual_read_privacy.sql`** replaced `global_read` on `vendors` and `workshops` with `directory_read`:

```sql
counterparty_type = 'company'
OR app_is_internal()
OR EXISTS (SELECT 1 FROM tenant_vendors tv
           WHERE tv.vendor_id = vendors.id AND tv.tenant_id = current_tenant_id())
```

An individual counterparty's directory row carries a personal mobile number. Company rows stay globally readable so cross-workspace master data and the internal match engine keep working. `0038_service_providers.sql` extended the same policy to `service_providers`.

**`0045_user_read_privacy.sql`** replaced `global_read` on `users` and `platform_members`. The migration header records the reproduction: on 2026-07-25, as `qvm_app` with `app.is_internal = false` — an ordinary workspace or vendor-portal session — 6 of 6 user rows were readable with emails, plus the full platform staff list. Now:

```sql
users:            app_is_internal() OR id = app_user_id()
platform_members: app_is_internal() OR user_id = app_user_id()
```

The self-read clause is load-bearing: `/me` needs your own user row, and `AuthGuard` reads your own `platform_members` row to decide whether you *are* internal.

Both migrations carry the same warning: **do not re-run `apply_global_rls()` on these tables** — it would recreate the permissive `global_read` and reopen the hole.

**Still on blanket `global_read` — 22 tables, verified live:**

```
brand_classes  cancellation_reasons  car_brands  cities  cost_ranges  item_statuses
part_categories  part_category_mapping  part_synonyms  parts_master  payment_accounts
plans  regions  return_reasons  service_provider_users  shipping_carriers  tenants
vendor_branches  vendor_statuses  vendor_users  workshop_branches  workshop_users
```

Two things on that list are worth flagging:

- `vendor_users`, `workshop_users`, `service_provider_users` leak the person↔company mapping. `0045` names them explicitly as **deliberately deferred**: they are read from 17 files including the shared counterparty helper, so narrowing them needs its own verification pass.
- `tenants` means any authenticated session can read every workspace's name, slug, `settings` jsonb and plan. Grepping the repo for `global_read` outside the migration tree returns nothing — this is **not flagged anywhere**. Treat it as open.

### `platform_audit` — the append-only exception

`0034_audit_hardening.sql` gave it bespoke policies rather than the standard pair:

```sql
pa_read   FOR SELECT USING      (app_is_internal())
pa_insert FOR INSERT WITH CHECK (app_is_internal() OR tenant_id = current_tenant_id())
```

Those two are the *only* policies on the table — there is **no UPDATE and no DELETE policy at all**, which makes the ledger append-only for the app role even in an internal session.

The header records why this table needed a special migration: `0029` created it, but the RLS loop in `0001` had already run and only covered tables existing at that moment. `qvm_app` had unrestricted cross-tenant read, write and delete on the impersonation audit ledger from `0029` until `0034` closed it. That incident is the direct cause of the verify script in §7.

---

## 5. Live / Sandbox — the `environment` column

ADR: `docs/decisions/0012-environment-as-row-boundary.md` (Arabic). It **supersedes ADR-0004**, which had made a sandbox a separate workspace.

**The model.** Every *operational* row carries its own `environment` (`live` | `sandbox`). Master and configuration data — vendors, workshops, users, branches, price lists, reference vocabulary, approval policies, calendars — is deliberately **shared** across both. A sandbox is a parallel set of *transactions* against the same catalogue, not a second company.

### Which tables carry it — 43

```
approval_actions  approval_requests  attachments  audit_log  cost_logs
credit_note_items  credit_notes  deliveries  delivery_items  driver_delivery_requests
invoice_items  invoices  notes  notification_log  order_items  order_number_counters
orders  pickup_items  pickups  pricing_logs  purchase_items  purchase_orders
return_issues  return_items  returns  rfq_items  rfq_vendor_items  rfq_vendors  rfqs
shipments  signatures  status_logs  stock_files  vendor_credit_note_items
vendor_credit_notes  vendor_financing_requests  vendor_payment_allocations
vendor_payments  vendor_stock_items  workflow_flows  workflow_record_state
workflow_steps  workflow_transitions
```

`0046` enumerates what is **deliberately excluded** and why: `approval_policies` / `approval_levels`, pricing + margin + calendar settings, `insurance_companies`, `drivers`, `entity_carrier_settings`, the `tenant_*` link tables, `counterparty_submissions`, `import_batches`, `platform_audit`. Configuration and governance, not transactions.

---

## 6. Why environment isolation had to be RESTRICTIVE

This is the sharpest design decision in the schema, and it is worth understanding fully because it is easy to get wrong when adding a table.

`apply_environment_rls` (`0041_environment_rls.sql`) creates exactly one policy:

```sql
create policy environment_isolation on <table> as restrictive
  using      (environment = public.current_environment())
  with check (environment = public.current_environment())
```

### The reasoning

Postgres combines row-level security policies in two groups:

- **Permissive policies are OR-ed together.** If any one of them passes, the row is visible.
- **Restrictive policies are AND-ed** with the result of the permissive set. Every one of them must pass.

`tenant_isolation` is permissive and reads:

```sql
using (tenant_id = current_tenant_id() OR app_is_internal())
```

Now suppose the environment predicate had been added as a second **permissive** policy. The effective read filter becomes:

```sql
(tenant_id = current_tenant_id() OR app_is_internal())   -- tenant_isolation
OR
(environment = current_environment())                    -- hypothetical permissive env policy
```

A session with `app_is_internal() = true` satisfies the first disjunct and the environment predicate is never consulted. And `app_is_internal()` is not an edge case here — it is precisely how the vendor, workshop and service-provider portals run (§4). The boundary would have evaporated in exactly the place it matters most: the cross-workspace portal where an outside company sees data.

With RESTRICTIVE, the filter is:

```sql
(tenant_id = current_tenant_id() OR app_is_internal())   -- permissive group
AND
(environment = current_environment())                    -- restrictive group
```

The environment predicate holds unconditionally, no matter what escape hatch the permissive group grants. The migration header states this directly, and the same paragraph appears in `apps/api/scripts/verify-rls.ts` and in ADR-0012 point 3.

### Two supporting choices

**`current_environment()` defaults an unset GUC to `'live'`.** The comment in `0041`: *a forgotten header can never widen access, only land you where you were.* Failing open to Live is safe because Live is where you already are; failing open to Sandbox would be a silent data-loss bug.

**Missing rows return 404, not 403.** `apps/api/src/common/env-guards.ts` — `assertEnvironment(ctx, row, what)` throws an identical `NotFoundException` for both "row does not exist" and "row exists in the other environment". A 403 would confirm the row exists and let a sandbox session enumerate live document ids. ADR-0012 point 5 puts it as: the two environments are parallel universes; what is in the other one is *absent*, not *forbidden*.

### `apply_tenant_rls` auto-applies it

Step 3 of `apply_tenant_rls` (§4) checks `information_schema.columns` for an `environment` column and calls `apply_environment_rls` if it finds one. This is the forward-looking half of `0041`: a future table cannot join the operational set and silently miss the boundary, because the one function everyone already calls will notice.

### The one exemption

`order_number_counters` carries `environment` but has **no** `environment_isolation` policy. This is deliberate, documented in `0041` and hard-coded as `ENV_POLICY_EXEMPT` in `verify-rls.ts`. It holds no business data, its unique key `(tenant_id, prefix, environment)` already separates the two environments, and `next_order_number()` must read the counter row it is about to bump. A restrictive policy there would buy nothing and risk breaking document numbering.

### Document numbering

`0040` added `environment` to `order_number_counters`, rebuilt its unique key, and **replaced** (rather than overloaded — a 3-arg call would have become ambiguous) the numbering function:

```sql
next_order_number(p_tenant uuid, p_prefix text, p_region uuid DEFAULT NULL, p_environment text DEFAULT 'live')
```

It does `INSERT … ON CONFLICT (tenant_id, prefix, environment) DO UPDATE SET next_value = next_value + 1 … RETURNING`, so there is no `MAX()+1` and no `FOR UPDATE` table lock. A sandbox document gets an `SBX-` infix in the returned string, so a test number cannot be mistaken for a real one — and because `environment` is in the unique key, a sandbox test cannot burn a live number. `rfq.service.ts` is the only caller.

---

## 7. `verify-rls.ts` — the guard that keeps this honest

`apps/api/scripts/verify-rls.ts` (75 lines). Run as `pnpm --filter @qvm/api db:verify`. `deploy.sh` runs it on the server **after migrations and before traffic is let in** (step 4/8).

It exits 1 if any `public` base table:

1. has RLS disabled, or
2. has RLS enabled but **zero** policies (which silently blocks `qvm_app` entirely — a table nobody can read is as broken as one everybody can), or
3. carries `tenant_id` without `FORCE ROW LEVEL SECURITY`, or without a policy whose `qual`/`with_check` mentions `current_tenant_id`, or
4. carries `environment` without a **RESTRICTIVE** policy mentioning `current_environment` (exempt: `order_number_counters`).

Small discrepancy worth knowing: the file's own header says it fails a table that "has RLS disabled **or not FORCEd**". The code only requires FORCE on tables that carry `tenant_id` — which is why the 25 global tables pass despite not being FORCEd. The list above matches the code.

Its header names the incident that motivated it — the `platform_audit` gap described in §4 — and states the reason plainly: new tables are born fully open to `qvm_app` through the `ALTER DEFAULT PRIVILEGES` grant in `0002_app_role.sql`, and the policy loop in `0001` only covered tables that existed at that moment. Every migration that creates a table must apply RLS itself; this script is what catches the one that forgets.

---

## 8. Migration workflow

### Rules

`docs/CONVENTIONS.md` (Arabic) rule DB-7: migrations go through drizzle-kit only, are **one-way** (never edit an applied migration), and are applied local → staging → prod.

```bash
corepack pnpm db:up                          # docker compose -f infra/docker-compose.yml up -d
corepack pnpm db:migrate                     # drizzle-kit migrate — uses DATABASE_URL (owner role)
corepack pnpm --filter @qvm/api db:generate  # diff schema/*.ts against the last snapshot
corepack pnpm --filter @qvm/api db:verify    # the RLS invariant guard
corepack pnpm db:seed                        # local only; see below
```

`drizzle.config.ts`: dialect `postgresql`, schema `./drizzle/schema/index.ts`, out `./drizzle/migrations`, `strict: true`. Credentials come from `DATABASE_URL` — the **owner** role, used for migrations and seeding only. The runtime uses `APP_DATABASE_URL` (`qvm_app`). Keeping these separate is what makes RLS real (§4).

Port numbers disagree across three files, so set `POSTGRES_PORT` explicitly and never rely on a fallback: `infra/docker-compose.yml` defaults the host port to `5433`, `.env.example` sets `POSTGRES_PORT=5434`, `db.service.ts` and `verify-rls.ts` fall back to `5434`, and `drizzle.config.ts` falls back to `5432`. The running container publishes `5434`.

The seed (`drizzle/seed/index.ts`) **truncates every table**. It refuses to run unless the DSN hostname is unmistakably local (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`, `host.docker.internal`), because the repo is rsynced to the server and one `pnpm db:seed` in the wrong directory would replace production with fixtures.

### The DDL + RLS pairing

Look at the migration list and a pattern jumps out: `0013_vendor_assignment.sql` / `0014_vendor_assignment_rls.sql`, `0017_approvals.sql` / `0018_approvals_rls.sql`, `0019` / `0020`, `0021` / `0022`, `0023` / `0024`. `drizzle-kit generate` emits the DDL; a hand-written follow-up migration then calls `apply_tenant_rls('...')` or `apply_global_rls('...')` per table. `0010_rls_helpers.sql` exists precisely so that follow-up is one line per table rather than a policy block.

Later migrations (`0031` onward) tend to be hand-written end to end, with the RLS calls inline.

### The `meta/_journal.json` trap

**Drizzle discovers migrations only through `drizzle/migrations/meta/_journal.json`.** A `.sql` file sitting in the directory with no matching `entries[].tag` is never opened — and `drizzle-kit migrate` still exits **0**. A forgotten journal entry therefore ships as a green deploy against a schema that was never altered, and the API 500s on the columns it now queries.

`deploy.sh` refuses to deploy rather than find that out from production (lines 45–58):

```python
tags = {e["tag"] for e in json.load(open(f"{d}/meta/_journal.json"))["entries"]}
orphans = sorted(f[:-4] for f in os.listdir(d) if f.endswith(".sql") and f[:-4] not in tags)
if orphans:
    sys.exit("ABORT: migration(s) missing from meta/_journal.json, drizzle would skip them: " + ", ".join(orphans))
```

Currently: 50 `.sql` files, 50 journal entries, 0 orphans. `apps/api/scripts/guard-check.sh` asserts the same invariant.

### The snapshot trap

`meta/` also holds `NNNN_snapshot.json` files — drizzle's model of the schema at each point, used as the base for the next `generate` diff. Snapshots exist only for `0000`–`0029`, `0035`, `0044` and `0047`. The gaps are the hand-written migrations, which drizzle never saw.

When the snapshot chain falls too far behind, the next `generate` emits a migration that **cannot run**: bare `CREATE TYPE` and bare `ADD COLUMN` statements with no `IF NOT EXISTS`, against objects that already exist. Two migrations exist purely to fix this:

- **`0035_snapshot_sync.sql`** and **`0044_snapshot_sync.sql`** are intentional no-ops (`SELECT 1;`). Their deliverable is the refreshed `meta/*.json` snapshot, not DDL.

`0044`'s header shows the discipline: before emptying the migration, the author verified that every statement drizzle wanted to emit was already applied — 48 additions plus exactly three removals, each checked individually — so there are zero unexplained `DROP`s.

**Practical consequence:** if you hand-write a migration, either write a snapshot-sync no-op afterwards or expect the next `generate` to produce garbage. See §11 for a live instance of this exact hazard.

### One-way, and what that means

There is no `down` migration anywhere in this repo. Recovery is by restore, not rollback. `deploy.sh` takes `pg_dumpall --roles-only` **and** `pg_dump` before touching anything (step 1/8). Both dumps are required: a data-only restore recreates rows but not cluster roles, every `GRANT ... TO qvm_app` then fails with "role does not exist", and drizzle sees `0002_app_role.sql` already recorded so it will not recreate it. The script's own header records the 2026-07-25 incident that produced these rules.

---

## 9. Every migration from 0040

| # | File | What it did | Why |
|---|---|---|---|
| **0040** | `environment_isolation.sql` | Added `environment` to 28 tables — 27 operational ones **backfilled from their parent chain** (`rfq_items` from `rfqs`, `order_items` from `orders`, `invoice_items` from `invoices`, …) plus `order_number_counters`, whose unique key was rebuilt to `(tenant_id, prefix, environment)`; replaced `next_order_number` with a 4-arg version | Before this only `rfqs` and `orders` had the column (from `0028`). The header: 18 of 20 operational tables were untagged, reads filtered inconsistently, and **writes never checked at all** — a sandbox session could mutate live records. The backfill is the important part: existing rows keep their true environment instead of all defaulting to `live` |
| **0041** | `environment_rls.sql` | Created `current_environment()` and `apply_environment_rls()`; rewrote `apply_tenant_rls()` to auto-apply the environment policy when the column exists; looped over every table carrying `environment` except `order_number_counters` | Moves the boundary from application code into the database: a query that forgets the predicate now returns nothing instead of the other environment's data. The `apply_tenant_rls` change is the forward-looking half — a future table cannot join the operational set and silently miss the boundary. Contains the permissive-vs-restrictive argument in full (§6) |
| **0042** | `retire_sandbox_workspace.sql` | Dropped `tenants.is_sandbox`; deleted the demo `sandbox` workspace **only if provably empty** (guarded on zero RFQs, orders, memberships, vendor links, workshop links) | There were two unrelated things called "sandbox". `tenants.is_sandbox` marked a whole *workspace* as fake, but its rows were still written with `environment = 'live'` — which is exactly how a "sandbox" RFQ ended up in a real vendor's live portal. The per-request toggle strictly subsumes it. The header's argument: keeping both leaves *"a weaker second mechanism that looks like isolation and is not — the worst kind of safety feature"* |
| **0043** | `remove_sandbox_tenant.sql` | Finished `0042`: its guard had blocked on one `tenant_vendors` row and one `tenant_workshops` row | Those two were seed artifacts, not work (0 RFQs, 0 orders, 0 members — verified on local and production before writing). They are directory *links*, not counterparties; the vendor and workshop remain in the global directory. The operational guard (RFQs / orders / members) is kept and strict, so a deployment that did real work there keeps its workspace |
| **0044** | `snapshot_sync.sql` | **Intentional no-op** — `SELECT 1;`. The deliverable is the refreshed `meta/*.json` snapshot | The snapshot chain had stalled at `0035` while `0036`–`0043` were hand-written. Left stale, the next `drizzle-kit generate` would emit a bare `CREATE TYPE provider_scope` and 28 bare `ADD COLUMN environment` with no `IF NOT EXISTS` — hard errors against objects that already exist. The header enumerates the three removals it verified so there are zero unexplained `DROP`s |
| **0045** | `user_read_privacy.sql` | Replaced `global_read` on `users` and `platform_members` with self-or-internal policies | Blanket read exposed every user's email/phone/name and the full platform staff list to any authenticated session. Reproduced 2026-07-25. The header records the call-site-by-call-site verification that every legitimate reader runs internal, and explicitly defers `vendor_users` / `workshop_users` / `service_provider_users` (§4) |
| **0046** | `environment_operational_logs.sql` | Added `environment` + the restrictive policy to 9 more tables: `status_logs`, `cost_logs`, `pricing_logs`, `attachments`, `signatures`, `notes`, `return_issues`, `stock_files`, `vendor_stock_items` | `0040` enumerated its list by walking tables that had data or that leak tests could reach. These nine are written by nothing yet, so no test could observe them leaking — but they are genuinely operational (a sandbox record's history must not appear in the live history). Doing it while all nine are empty is free; doing it after the status gateway starts writing `status_logs` would be a backfill |
| **0047** | `workflow_engine.sql` | Created the four `workflow_*` tables, composite FKs, 3 table CHECK constraints, partial unique indexes, and the two freeze triggers. Header: *"Reviewed adversarially before application (51 objections raised, 37 upheld)"* | Everything below the generated DDL exists because `drizzle-kit generate` cannot know about it: `apply_tenant_rls` (without it the tables are born readable and writable by `qvm_app` across every workspace and both environments, and `verify-rls.ts` fails the deploy *after* they are committed), the first real table CHECKs in the repo, and the freeze triggers that turn "activating a flow freezes it" from prose into enforcement |
| **0048** | `workflow_governance.sql` | Added `workflow_steps.pages` and `.owner_roles` (both `jsonb NOT NULL DEFAULT '[]'`) with `jsonb_typeof(...) = 'array'` CHECKs; added `owner_roles` to the freeze tuple | Establishes the classification rule for every future column on these tables: **semantics are frozen, view and timing are tunable.** `owner_roles` governs who may act → frozen. `pages` governs which screen a record surfaces on → tunable, because a mis-routed status hides live work and must be fixable without republishing a version. Both default to `[]`, and empty means "no opinion" — a workspace that never opens this screen sees no behaviour change |
| **0049** | `workflow_custody.sql` | Added `workflow_record_state.assignee_user_id` / `assignee_role` / `step_entered_at` / `due_at`, and `workflow_transitions.handoff text NOT NULL DEFAULT 'pool'` with a CHECK of `('pool','keep','actor')`; three partial indexes for my-work / unclaimed-pool / overdue; added `handoff` to the freeze tuple | Phase 1 said who *may* act at a step. It said nothing about who is holding a record *now*, so a personal queue was impossible. Custody is per-record runtime state, hence it lives on `workflow_record_state` rather than the flow definition. `due_at` is precomputed from the destination step's `sla_hours` and stored, so "overdue" is one indexed comparison rather than a join per row |

| **0050** | `page_roles.sql` | Rewrote `workflow_steps.pages` from `["rfqs"]` to `[{page, mode}]`, `mode ∈ (action, watch, optional)`, with a shape CHECK built on `jsonb_path_query_array` | A page needed to say not just *whether* a status appears but *what the people there do with it* — act, watch, or step in. The CHECK could not be written the obvious way: a CHECK constraint may not contain a subquery (`transformSubLink`), so the per-element validation is a jsonpath filter whose result length must equal the array's. The migration also had to rewrite `routing.ts` **in the same change**: `pages @> to_jsonb('rfqs')` is true for a flat array and FALSE for an array of objects, so shipping the shape change alone would have emptied every routed queue silently |
| **0051** | `transition_gates.sql` | Added `workflow_transitions.gates` (jsonb array), and `status_logs.override_reason` + `.overridden_gates` | Roles answer *who*; gates answer *whether the work is actually ready* — all lines priced, enough quotes, margin above a floor. Two enforcement levels: `block` refuses, `warn_override` lets a named role proceed and records what they overrode and why, because an override nobody can see afterwards is the same as no rule |
| **0052** | `approval_gates.sql` | Added `approval_requests.transition_key` and `.consumed_at`; partial unique index on open requests per (record, transition) | Connects the workflow to the approvals engine that already existed beside it. `transition_key` (`fromCode>toCode`) is what makes a grant specific — an approval to move `priced → confirmed` must not authorise `confirmed → cancelled`. `consumed_at` makes it single-use, and the partial unique index means two people asking join one review instead of opening two that can be decided differently |
| **0053** | `approval_requester_name.sql` | Added `approval_requests.requested_by_name` — a snapshot, not a join | `0045` closed blanket read on `users`, so a workspace approver cannot read a platform requester's row; the inbox would have shown "asked by (unknown)". Snapshotting the name at request time also survives the person leaving |
| **0054** | `workflow_exceptions.sql` | New table: cancellation and return as flows ATTACHED to a record — `restore_status_id`, requester/resolver, open/executed/rejected | Splicing "cancellation requested" into the record's own status destroys the fact you need in order to put it back if the request is refused. So the record keeps its real status, frozen, while a small flow hangs off it. Deliberately **not** stored on `workflow_record_state`, whose `UNIQUE (tenant_id, environment, entity_type, entity_id)` the custody upsert depends on |
| **0055** | `auto_advance.sql` | Added `workflow_transitions.auto_advance` / `.auto_once`, `status_logs.auto_advanced`, and the `workflow_auto_fired` table | Auto-advance and loop prevention ship together on purpose: automation without a guard walks an order to the end of the flow, or round in a circle, in one transaction nobody asked for — and this engine has a specific vector, since the final approval performs the move. Three levers: opt-in per transition, at-most-once per record, and a depth cap in code. Automatic moves record `changed_by = NULL`, because blaming whoever submitted the quote that satisfied the gate would be a false audit record |
| **0056** | `workflow_actions.sql` | Added `workflow_transitions.actions` with a shape CHECK, the `workflow_action_runs` table (+ a partial index on failures), and grew the freeze tuple a fifth time | A rules engine that can only permit and refuse cannot have a consequence. `notify` and `webhook` are deliberately absent from the catalog — `NotificationsService` dispatches nothing, and an outbound webhook inside the business transaction leaves the receiver believing something happened after a rollback. The run log exists because an action whose failure is invisible is worse than no action: the flow looks configured and quietly is not |
| **0057** | `workflow_holds.sql` | `workflow_exceptions.kind` gains `hold`; `.status` gains `released` | `lock_record` (0056) froze records by opening an exception with the only kind the CHECK allowed — `cancellation`. But the approvals inbox renders every open exception with a **"Cancel it"** button wired to `resolve → approve → cancelled`, so an engine hold appeared as a request nobody made, one click from ending a live order. `released` rather than `rejected` for the same class of reason: there was no request to refuse |

| **0058** | `action_daily_cap.sql` | Widened `workflow_action_runs.outcome` to admit `capped`; index supporting the per-day count | A ceiling is containment, not metering. It exists so a flow that has started running away — a loop somebody drew, a condition matching every record — hits a wall inside one day instead of writing until a person notices. `capped` is a fourth outcome rather than `skipped` with a note, because the two are different facts: skipped means the action did not apply to this record, capped means it applied, would have changed it, and was refused for volume. The ceilings measure who pays — `set_field` 10,000 (one UPDATE nobody outside the database sees), `lock_record` 500, because every success of that one puts an item in front of a human and 10,000 unexplained holds is the engine mounting a denial of service against the workspace's own staff |
| **0059** | `run_log_attribution.sql` | `workflow_actor_label()` (SECURITY DEFINER); `workflow_action_runs.auto_advanced`; `status_logs_recent_idx` | Three ways the new run-log screen misattributed work, all found by reading it adversarially and all confirmed against real data. `left join users` is empty for a workspace reader — 0045 made that table self-or-internal — so every colleague's move came back nameless and rendered as the label reserved for a vendor arriving through an unauthenticated quote link: the log asserted a vendor did work a named employee had done. The function answers only for people the caller may legitimately see (workspace members by name, platform staff as the role `Qparts staff`, anyone else nothing), because an unrestricted SECURITY DEFINER lookup over `users` is a name-disclosure oracle. `auto_advanced` is recorded rather than inferred from a null actor, so an action the engine ran can say so instead of reporting "no signed-in user" one line under the move that correctly says "the workflow". The index is the one the service's own comment already claimed: `status_logs` had nothing ordered on `created_at`, so the move branch seq-scanned the tenant's entire append-only history on every page load |
| **0060** | `workflow_action_library.sql` | New `workflow_actions` table — named, reusable action configurations, with the composite `(id, tenant_id, environment)` unique 0047 established | The reviewer asked for actions to be reusable named entities "associated to rules — not embedded copies", and the same ticket calls our draft→active freeze the thing we do better than the tool it benchmarks. Both hold only one way: **the library authors, the flow remembers.** Adding an entry to a transition COPIES it and stamps a receipt (`{ref:{id,name}}`) into `workflow_transitions.actions`; the copy is what runs and the engine never follows the receipt — `status.service.ts` and `actions.ts` are byte-unchanged by the feature. Editing an entry therefore cannot alter a flow already running, which is asserted end to end rather than argued: activate a flow, edit the entry, drive a real order, watch it run what it froze |

| **0061** | `in_app_notifications.sql` | Notifications addressed to one person, with the read state and an indexed unread count | The one channel that can be honest today. `NotificationsService` records an attempt and dispatches nothing for email and WhatsApp because no provider is connected — but in-app needs no provider, it is a row this application writes and reads. Three things were blocked on it and would have been theatre without it: the `notify` action, the daily failure digest, and the Communications badge, which until now read a hardcoded `DEMO_UNREAD` constant |
| **0062** | `record_removals.sql` | `workflow_record_removals` — an audit row naming a record that no longer exists | Item 7's deleted-event, and the ticket is explicit that it triggers no rules. Deliberately has NO foreign key: it names a row that has gone. It keeps the polymorphic `(entity_type, entity_id)` pair the rest of the engine uses, so a reader can still join it to the history the deleted record left behind, and it carries the reference a person actually knew rather than a uuid that now resolves to nothing anywhere |
| **0063** | `workflow_failure_digest.sql` | `workflow_failure_digests` — one row per workspace per digest day | The repo's first scheduled job, and the reason it needs no scheduling library. Everything a framework would give (retries, backoff, distributed locking) is answered by the unique key instead: a second run for the same workspace-day is refused by the database, so at-least-once delivery and exactly-once reporting become the same thing. The ticker asks every 15 minutes whether a workspace's OWN day has rolled over, which is how one fixed interval serves several timezones and why a restart at 00:07 still sends the 00:00 digest |

For context, the earlier migrations fall into three groups: `0000`–`0010` build the foundation (full schema, security functions, app role, RLS helpers); `0011`–`0024` add modules in DDL+RLS pairs; `0025`–`0039` are hardening and QNEW-71 counterparty identity.

---

## 10. Workflow engine storage — the parts that will bite you

Eleven workflow-and-delivery tables now. The original four (`workflow_flows`, `workflow_steps`, `workflow_transitions`,
`workflow_record_state`) plus `workflow_exceptions` (0054), `workflow_auto_fired` (0055),
`workflow_action_runs` (0056) and `workflow_actions` (0060, the named library). `drizzle/schema/workflow.ts` is 281 lines (~14 KB), most of it
reasoning — note that the columns added by 0048 onwards are raw-SQL only and do not all appear in
it (see §11).

The header explains why the storage design came before the feature: the shape is read by three consumers. The canvas renders and edits it (hence `canvas_x` / `canvas_y` on each step); the guard enforces it (a status move must match a `workflow_transitions` row); the AI assistant emits it (the model returns this object, a human reviews it on the canvas and saves — the model never writes SQL). One object throughout is what makes "build it myself / let the AI do it / do half each" one feature instead of three.

**Scoping:** flows belong to the **workspace** (`tenant_id`), never to an individual workshop. Tenant RLS then isolates them for free.

**Versioning:** a flow is freely editable while `status = 'draft'`. Activating freezes it. Records bind to the exact flow row they entered, so activating v2 cannot strand an order at a step v2 deleted.

### Composite foreign keys — the repo's first

Children pin to `workflow_flows` on a composite key rather than on `flow_id` alone. The reason is worth stating precisely: **referential-integrity triggers bypass RLS**. A single-column FK would let a step belong to a flow in a different tenant, environment or domain, and the tenant policy would constrain nothing on that path. The composite key pins the whole scope at the constraint level.

| Child | FK columns | Backing unique on `workflow_flows` |
|---|---|---|
| `workflow_steps` | `(flow_id, tenant_id, environment, status_domain)` | `workflow_flows_id_scope_domain_uq` |
| `workflow_record_state` | `(flow_id, tenant_id, environment, status_domain)` | `workflow_flows_id_scope_domain_uq` |
| `workflow_transitions` | `(flow_id, tenant_id, environment)` — no `status_domain` | `workflow_flows_id_scope_uq` |

`workflow_transitions` also pins each endpoint with `(from_step_id, flow_id)` / `(to_step_id, flow_id)` against `workflow_steps_id_flow_uq`, so an arrow cannot cross flows.

The workflow tables hold the repo's **only** `ON DELETE CASCADE` foreign keys — five of them, on `workflow_steps` and `workflow_transitions`. (The in-code comment at `workflow.ts:233` attributes them to `workflow_transitions` alone; `workflow_steps_flow_scope_fk` also cascades.) `workflow_transitions_from_step_idx` / `_to_step_idx` exist because without a covering index each step delete would be a sequential scan.

`workflow_record_state`'s FK to the flow has **no `ON DELETE`** (only `ON UPDATE CASCADE`), so an in-flight record blocks deletion of the flow version it is executing.

### Table CHECK constraints — also a first

Every other `check (` in the migration tree is an RLS `WITH CHECK` clause. These are real table constraints:

| Table | Constraint | Definition |
|---|---|---|
| `workflow_steps` | `workflow_steps_status_one_of` | `num_nonnulls(item_status_id, vendor_status_id) = 1 AND (status_domain = 'item') = (item_status_id IS NOT NULL)` |
| `workflow_steps` | `..._pages_is_array`, `..._owner_roles_is_array` | `jsonb_typeof(col) = 'array'` |
| `workflow_flows` | `workflow_flows_selection_complete` | `status <> 'active' OR is_default OR selection_condition IS NOT NULL` |
| `workflow_transitions` | `workflow_transitions_no_self_loop` | `from_step_id <> to_step_id` |
| `workflow_transitions` | `workflow_transitions_handoff_mode` | `handoff IN ('pool','keep','actor')` |

### Details that look arbitrary but are not

- **`selection_condition` has three meaningful states.** `NULL` = never auto-selected (routing not yet decided; the default). `{}` = matches every record. `{…}` = matches records satisfying it. Without the `NULL` state a half-finished flow is born matching everything and quietly captures every new record ahead of the intended one. `workflow_flows_selection_complete` stops such a flow going active.
- **Partial unique indexes carry the versioning logic.** `workflow_flows_active_uq ON (tenant_id, environment, flow_key) WHERE status = 'active'` — activation is two writes (retire v1, activate v2) and a crash between them would otherwise leave routing nondeterministic. `workflow_flows_default_uq ON (tenant_id, environment, status_domain) WHERE is_default AND status = 'active'` — the `status = 'active'` clause is load-bearing: without it a draft v2 collides with the live v1 and versioning becomes impossible. `workflow_steps_entry_uq ON (flow_id) WHERE is_entry` — zero entries wedges every new record, two makes the start nondeterministic.
- **`canvas_x` / `canvas_y` are `double precision`, not `numeric`.** Drizzle returns `numeric` as a *string*, so the first drag would concatenate rather than add, the node would teleport, and that value would be saved.
- **`workflow_record_state.status_domain` has no default,** deliberately. (`workflow_flows.status_domain` *does* default to `'item'`.) Defaulting the record-state column would silently mis-bind `rfq_vendor` — the one vendor-domain entity — to a flow speaking the wrong vocabulary, after which nothing resolves.
- **All four tables use `audit`, not `timestamps`,** for the reason in §2: `apply_tenant_rls` attaches `trg_set_row_audit` unconditionally.

### The freeze triggers

`workflow_flow_freeze()` (BEFORE UPDATE OR DELETE on `workflow_flows`): only a draft may be deleted; status moves forward only (`draft → active|retired`, `active → retired`); once past draft, `flow_key`, `version`, `environment`, `status_domain` and `selection_condition` are immutable.

`workflow_child_freeze()` (BEFORE INSERT OR UPDATE OR DELETE on `workflow_steps` and `workflow_transitions`): if the parent flow is not a draft, INSERT and DELETE are rejected outright, and UPDATE is rejected if it touches the semantic tuple. Current tuples after `0049`:

| Table | Frozen columns |
|---|---|
| `workflow_steps` | `item_status_id`, `vendor_status_id`, `status_domain`, `is_entry`, `is_terminal`, `owner_roles` |
| `workflow_transitions` | `from_step_id`, `to_step_id`, `condition`, `requires_approval`, `allowed_roles`, `priority`, `handoff` |

Everything outside those tuples — canvas coordinates, `sort_order`, `sla_hours`, labels, `pages` — stays editable on an active flow.

The trigger returns early when the parent flow row is missing (`v_status IS NULL`), because a CASCADE delete of a draft flow removes children after the parent.

**This is the schema's sharpest maintenance hazard, and both `0048` and `0049` say so in their headers.** The function is a hard-coded tuple of column names. A new semantic column that nobody adds to the tuple is silently editable on an active flow, which lets someone rewrite the rules under orders already executing them — the exact failure the versioning design exists to prevent. **Any column added to `workflow_steps` or `workflow_transitions` must be classified frozen-or-tunable at the moment it is added.**

---

## 11. Known gaps and drift

Verified, not speculated.

**1. `workflow.ts` is missing all five columns that `0049` added.** The Drizzle schema does not declare `workflow_record_state.assignee_user_id`, `.assignee_role`, `.step_entered_at`, `.due_at`, or `workflow_transitions.handoff`. All five exist in the live database — the application reads and writes them **only through raw SQL**, in `apps/api/src/common/status.service.ts` and `apps/api/src/modules/workflow/workflow.service.ts`. (`0048`'s `pages` and `owner_roles` *were* added to the .ts; only `0049`'s five were not.)

**Consequence: the next `drizzle-kit generate` diffs the .ts against `meta/0047_snapshot.json` and produces a migration that is wrong in both directions** — `DROP COLUMN` for the five, plus `ADD COLUMN pages` / `owner_roles` (which are in the .ts but not in the 0047 snapshot, and already exist in the DB). Fix the schema file and refresh the snapshot before anyone runs `db:generate`.

**2. The uuid v7 claim in `_shared.ts` is aspirational.** Lines 11-13 say the app layer overrides the DB default with sortable uuid v7 via a Drizzle `$defaultFn` in the db client. Grepping `apps/api/src` and `apps/api/drizzle` for `uuidv7`, `$defaultFn` or `v7()` returns only those comment lines. `db.service.ts` constructs `drizzle(this.client, { schema })` with no default-function overrides. **Every primary key in this database is `gen_random_uuid()` — v4, not sortable.** Either implement it or correct the comment.

**3. ADR-0011 is cited but does not exist.** `org.ts:11` references it for the global-workshop decision. `docs/decisions/` contains `0001`–`0010` and `0012` — there is no `0011`. The nearest real source is `0008-tenant-model-and-shared-vendors.md`.

**4. `app.impersonator_id` is set on every transaction and read by nothing.** `db.service.ts` sets the GUC; no policy, function or trigger in `drizzle/migrations/` references it (the only `impersonator_id` hits are the `platform_audit` column and its FK). The comment is honest: *"reserved for DB-side audit triggers (no reader yet; the app writes impersonator_id explicitly)"*.

**5. Person↔company mappings remain world-readable to any authenticated session.** `vendor_users`, `workshop_users`, `service_provider_users` still have blanket `global_read`. `0045` names this as deliberately deferred. `tenants` is in the same position (name, slug, settings jsonb, plan for every workspace) and is **not flagged anywhere**.

**6. `workshops` and `workshop_branches` carry `FORCE ROW LEVEL SECURITY` with no `tenant_id`.** Residue from `0027`. Not harmful; not intentional either.

**7. `NotificationsService` writes `notification_log` rows and dispatches nothing.** `apps/api/src/modules/notifications/notifications.service.ts` computes a status, inserts the row, and where the provider call would be has `void secret;` and a `this.logger.log(...)`. No SMTP, WhatsApp or webhook client exists in the repo. The table has 0 rows locally. Note also that its `providerLive` check requires `NODE_ENV === 'production'`, so even a wired provider stays suppressed outside prod.

**8. There is no sandbox reset.** ADR-0012's own "known-but-not-done" section says so, and nothing in `apps/api/src/modules` implements it. Deleting a workspace's `environment = 'sandbox'` rows is now trivial and safe, but no endpoint or script does it.

**9. Most of the schema has never run.** 52 of 93 tables are empty on the local dev database; there is one RFQ and one order. Shipping, billing, purchasing, approvals, financing and the whole workflow engine are schema-and-code with no data behind them.

---

## 12. File index

| Concern | Files |
|---|---|
| Column conventions | `apps/api/drizzle/schema/_shared.ts` |
| Enums vs reference tables | `apps/api/drizzle/schema/enums.ts`, `reference.ts` |
| Schema barrel (26 `export *` lines over the 28 files in the directory) | `apps/api/drizzle/schema/index.ts` |
| RLS functions, audit trigger, numbering | `apps/api/drizzle/migrations/0001_security_functions.sql` |
| The `qvm_app` role | `apps/api/drizzle/migrations/0002_app_role.sql` |
| RLS helper functions | `apps/api/drizzle/migrations/0010_rls_helpers.sql` |
| Read-privacy narrowing | `0032_individual_read_privacy.sql`, `0045_user_read_privacy.sql` |
| Audit ledger lockdown + idempotency backstops | `0034_audit_hardening.sql` |
| Live/Sandbox | `0040_environment_isolation.sql`, `0041_environment_rls.sql`, `0046_environment_operational_logs.sql`, `docs/decisions/0012-environment-as-row-boundary.md` |
| Workflow storage | `0047`–`0049`, `apps/api/drizzle/schema/workflow.ts` |
| Session GUCs | `apps/api/src/db/db.service.ts` |
| Cross-environment 404 | `apps/api/src/common/env-guards.ts` |
| RLS invariant guard | `apps/api/scripts/verify-rls.ts` |
| Migration/journal preflight | `deploy.sh` (lines 45–58), `apps/api/scripts/guard-check.sh` |
| Local stack | `infra/docker-compose.yml` |
| Seed | `apps/api/drizzle/seed/index.ts`, `reference-data.ts` |