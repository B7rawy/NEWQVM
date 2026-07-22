# تصميم السكيما الجديدة — QVM Platform

**الحالة:** مسودّة للمراجعة — 2026-07-22 · **يُراجَع قبل كتابة أي ميجريشن.**
**المرجع:** [old-system-schema.md](../reference/old-system-schema.md) · **القرارات:** ADR-0003, ADR-0007, ADR-0008 · **القواعد:** [CONVENTIONS](../CONVENTIONS.md)

> هذا تصميم من الصفر، **ليس نسخة** من القديم. حافظنا على منطق البيزنس (سلسلة الطلب، المحاور، المفردات)
> وأصلحنا كل مشكلة بنيوية موثّقة في §6 من المرجع.

---

## 0. القواعد العامة للتصميم (تنطبق على كل الجداول)

| البند | القرار | يحلّ |
|---|---|---|
| المفاتيح الأساسية | `uuid` (v7 — قابل للفرز زمنياً وغير قابل للتخمين) | تخمين المعرّفات، وأمان التوكنات |
| العزل | `tenant_id uuid NOT NULL` على كل جدول معاملات + **RLS** | §6.1 غياب الـ tenant |
| المبالغ | `numeric(14,2)` دائماً | §6.6 خلط float/text للمبالغ |
| التواريخ | `timestamptz` بـ UTC (`now()`) | §6.6 + §6.10 توقيت مختلط |
| التدقيق | `created_at, updated_at, created_by, updated_by` عبر trigger موحّد | تكرار منطق التدقيق |
| الحالات | جداول reference مستقلة (ar/en) أو enums — **لا جدول عام واحد** | §6.3 نظام الأنواع العام |
| المرفقات | جدول `attachments` polymorphic **واحد** | §6.4 أربع آليات مرفقات |
| التوكنات | مُهاشة (`token_hash`) + انتهاء صلاحية | §6.9 توكن نصّي مكشوف |
| الترقيم | `sequence` لكل (tenant, نطاق) | §6.8 `MAX()+1` |
| الفهرسة | index لكل FK + composite `(tenant_id, …)` | 123 FK بلا index |

**RLS على كل جدول tenant-scoped:**
```sql
USING (tenant_id = current_setting('app.tenant_id')::uuid OR app_is_internal_staff())
```
`app.tenant_id` يُضبط عبر `SET LOCAL` في بداية كل request من الـ subdomain/JWT.
موظفو المنصّة الداخليون يتخطّون الفلتر عبر `app_is_internal_staff()`.

---

## 1. الهوية والمنظمات / Identity & Org

```
tenants (workspace — المشغّل مثل Qparts)
├── workshops (الورش العميلة داخل الـ workspace)
│     └── workshop_branches (الفروع)
├── users ⟷ tenant_memberships (عضوية + دور داخل الـ workspace)
└── (الموردون عالميون — §2)
```

### `tenants` — الـ workspace
`id, name, slug (unique — subdomain), logo_url, settings jsonb, plan_id, is_sandbox bool, is_active bool, created_at, updated_at`
> **`is_sandbox`** يقود عزل الآثار الجانبية (ADR-0004).

### `users` — عالمي (بلا tenant_id)
`id, email (unique), password_hash (argon2), full_name, phone, is_active, created_at, updated_at`
> عالمي عمداً: نفس المستخدم قد ينتمي لأكثر من workspace، ومستخدم المورّد قد يخدم أكثر من tenant (§ADR-0008).

### `tenant_memberships` — عضوية المستخدم في workspace
`id, tenant_id, user_id, role (enum), workshop_branch_id (nullable — لمستخدمي الورش), is_active, created_at`
> **RLS scoped.** الدور يحدّد الصلاحية داخل الـ workspace.

### `workshops` + `workshop_branches`
- `workshops`: `id, tenant_id, name, tax_number, is_active, created_at, updated_at`
- `workshop_branches`: `id, tenant_id, workshop_id, name, region_id, city, order_category (enum), is_bulk bool, created_at, updated_at`
> يحلّ §6.2: الطلب سيرتبط بـ `workshop_branch_id` على مستوى **الرأس** لا البند.
> يوحّد §6.4: `is_bulk` عمود صريح بدل تكراره مع `order_category`.

---

## 2. الموردون (عالميون) / Vendors — ADR-0008

```
vendors (عالمي — بلا tenant_id)
├── vendor_branches
├── vendor_users (⟷ users)
└── tenant_vendors ← جدول الربط (يحمل tenant_id + RLS)
```

### `vendors` — عالمي
`id, legal_name, commercial_registration_number, tax_number, primary_email, primary_phone, vendor_type (enum), is_active, created_at, updated_at`
> **بلا tenant_id.** الهوية القانونية للمورّد واحدة عبر كل الـ workspaces.
> يحلّ §6.4: `vendor_type` مصدر واحد (enum) بدل `vendor_type` نصّي + `vendor_type_id`.
> يصحّح الإملاء: `commercial_registration_number`.

### `vendor_branches`
`id, vendor_id, name, region_id, city, address, location geography(Point), payment_method, is_active, created_at, updated_at`
> يوحّد §6.4: موقع واحد (`geography`) بدل `lat/lng/address` + `location` النصّي.

### `tenant_vendors` — الربط (RLS scoped)
`id, tenant_id, vendor_id, status (enum), payment_terms, classification, agreement jsonb, linked_at, linked_by`
> **هنا `tenant_id` والـ RLS.** كل workspace يرى/يدير مورّديه عبر هذا الجدول فقط.
> مستقبلاً: نفس المورّد في workspaceين = صفّان هنا، بلا تغيير سكيما.
> index: `unique (tenant_id, vendor_id)`.

### `vendor_users`
`id, vendor_id, user_id, is_vendor_admin bool, created_at`

---

## 3. سلسلة الطلب / Order Chain (القلب)

> الأسماء الجديدة أوضح؛ المحاور محفوظة: **`order_item` هو محور التنفيذ** (كان `confirmed_item`)،
> و**`winning_vendor_quote_item_id` هو التسعيرة الفائزة** (كان `cost_id`).

### 3.1 مرحلة الـ RFQ / التسعير
```
rfqs                    (كان quotations)
├── rfq_items           (كان quotation_items)
├── rfq_vendors         (كان quotation_vendors)
│     └── rfq_vendor_items   (كان quotation_vendor_items)
```

**`rfqs`** — رأس طلب التسعير
`id, tenant_id, order_number, workshop_branch_id (NOT NULL), plate_number, vin, car_brand_id, model, order_type (enum), delivery_type (enum), service_advisor_id, account_manager_id, status_id, created_at, updated_at, created_by, updated_by`
> **`workshop_branch_id NOT NULL`** — يحلّ §6.2 (العميل على الرأس لا البند).

**`rfq_items`** — بنود الـ RFQ
`id, tenant_id, rfq_id, part_number, part_description, quantity, brand_class_id, part_category_id, part_photo_key, vin, status_id, selling_price numeric(14,2), discount_pct numeric(5,2), agency_price numeric(14,2), winning_vendor_quote_item_id (nullable), extraction_status (enum), extracted_by, extracted_at, created_at, updated_at`

**`rfq_vendors`** — إرسال الـ RFQ لمورّد
`id, tenant_id, rfq_id, vendor_id, vendor_branch_id, status_id, token_hash, token_expires_at, sent_at, created_at, updated_at`
> **`token_hash`** بدل `access_token` النصّي (§6.9).

**`rfq_vendor_items`** — تسعيرة المورّد للبند
`id, tenant_id, rfq_vendor_id, rfq_item_id, offered_cost numeric(14,2), discount_pct numeric(5,2), sla_hours numeric, available_qty, available_brand_class_id, alternative_part_number, status_id, notes, created_at, updated_at`
> **`sla_hours` numeric فقط** (نُسقِط `sla` النصّي — §6.4). unique `(rfq_vendor_id, rfq_item_id)`.

### 3.2 مرحلة التأكيد والتنفيذ
```
orders                  (كان confirmed_orders)
├── order_items         (كان confirmed_items — المحور، unique على rfq_item_id)
├── purchase_orders → purchase_items → pickups/pickup_items
├── deliveries → delivery_items          (تسليم مجزّأ مدعوم!)
├── invoices → invoice_items
├── returns → return_items
├── credit_notes → credit_note_items
└── return_issues (جدول واحد مدمج)
```

**`orders`** — الطلب المؤكَّد
`id, tenant_id, rfq_id, order_number, client_po, status_id, created_at, updated_at, created_by`

**`order_items`** — البند المؤكَّد (المحور)
`id, tenant_id, order_id, rfq_item_id (UNIQUE), final_part_number, approved_qty, winning_vendor_quote_item_id, status_id, created_at, updated_at`
> `confirmed_item_id` القديم = `order_items.id` الجديد. كل مستند تنفيذي يشير إليه.

**`purchase_orders`** — أمر شراء لكل مورّد
`id, tenant_id, order_id, vendor_id, payment_account_id, status_id, vendor_invoice_number, created_at, updated_at`
> فواتير/مرتجعات المورّد → عبر `attachments` + `credit_notes` (نُسقِط أعمدة `vendor_invoice_url/vendor_return_url` — §6.4).

**`purchase_items`**
`id, tenant_id, purchase_order_id, order_item_id, vendor_quote_item_id, qty, status_id, created_at, updated_at`

**`deliveries`** + **`delivery_items`** — تسليم مجزّأ
- `deliveries`: `id, tenant_id, order_id, delivery_number, client_po, signature_id, signed_by, delivered_at, status_id, created_at`
- `delivery_items`: `id, tenant_id, delivery_id, order_item_id, qty, invoice_id (nullable), created_at`
> يحلّ §6.7: مستند حقيقي بأسطر، **يدعم تسليم البند على دفعات** (بدل `delivery_notes` المسطّح ذي الصف الواحد).
> "إذن التسليم" للطباعة = تجميع/عرض (view/query) لا جدول مسطّح.

**`invoices`** + **`invoice_items`**
- `invoices`: `id, tenant_id, order_id, invoice_number, issued_at, due_date, paid_at, total_before_vat numeric(14,2), vat_amount numeric(14,2), total_incl_vat numeric(14,2), external_ref (Zoho), status_id, created_at`
- `invoice_items`: `id, tenant_id, invoice_id, order_item_id, qty, unit_price numeric(14,2), created_at`
> كل المبالغ والتواريخ أنواع صحيحة (§6.6).

**`returns`** + **`return_items`**
- `returns`: `id, tenant_id, order_id, return_number, signature_id, signed_by, returned_at, status_id, created_at`
- `return_items`: `id, tenant_id, return_id, order_item_id, qty, return_reason_id, responsibility (enum: internal/vendor/client/delivery_agent), credit_note_id (nullable), created_at`
> يحلّ §7-الخلاصة-5: المسؤولية عمود enum مستقل.

**`credit_notes`** + **`credit_note_items`** — إشعارات الخصم للعميل
`credit_notes`: `id, tenant_id, order_id, credit_note_number, issued_at, total numeric(14,2), external_ref, status_id, created_at`
`credit_note_items`: `id, tenant_id, credit_note_id, order_item_id, qty, return_reason_id, created_at`

**`return_issues`** — ملف مشكلة الإرجاع (جدول **واحد** مدمج)
`id, tenant_id, order_item_id, responsibility (enum), issue_type_id, delivery_agent_id, main_vendor_id, part_number_source, notes, status_id, created_at, updated_at`
> يحلّ §6.4: يدمج `return_issues` + `returned_issues` القديمين في واحد.

---

## 4. التسعير والهوامش / Pricing & Margins

- **`cost_logs`** (سجل أسعار الشراء): `id, tenant_id, rfq_item_id, vendor_id, cost numeric(14,2), pricing_source (enum), created_by, created_at`
- **`pricing_logs`** (سجل أسعار البيع): `id, tenant_id, rfq_item_id, price numeric(14,2), pricing_source (enum), created_by, created_at`
  > append-only — **بلا `updated_by`** (§6.5). `pricing_source` enum واحد (§6.4: كان list 8 + CHECK + عمود نصّي).
- **`profit_categories`**: `id, part_category_id, brand_class_id, name` (عالمي أو tenant؟ → **tenant-scoped** لأن كل workspace قد يختلف).
- **`profit_margins`**: `id, tenant_id, profit_category_id, cost_range_id, margin_pct numeric(5,2)`
- **`profit_margins_branch`**: تجاوز على مستوى الفرع — `id, tenant_id, workshop_branch_id, profit_category_id, cost_range_id, margin_pct`
- **`profit_margin_audit`**: سجل تدقيق **واحد** (يدمج `profit_margins_audit` + `profit_percentage_update_logs` — §6.4).
- **`stock_files`** (كتالوجات أسعار الوكالة): `id, tenant_id, file_date, part_number, brand_class_id, car_brand_id, cost_before_discount numeric(14,2), discount_pct numeric(5,2), vendor_id, created_at`

---

## 5. المفردات المرجعية / Reference Data (بديل `list_data`)

بدل الجدول العام الواحد، **جداول/enums مستقلة لكل مفهوم**. المفردات محفوظة كاملة من §5 بالمرجع.

**PostgreSQL enums** (مجموعات ثابتة صغيرة، لا يوسّعها المستخدم):
`order_type` · `delivery_type` · `return_responsibility` · `pricing_source` · `membership_role` · `vendor_type` · `order_category` · `extraction_status`

**جداول reference عالمية** (ذات سلوك/قابلة للتوسّع، ar/en):
| الجدول | كان (list) | ملاحظة |
|---|---|---|
| `item_statuses` | 3 (item_status) | + كود ثابت للـ state machine؛ **دمج `Canceled`/`Cancelled`** (§6.4) |
| `vendor_statuses` | 15 (vendor_status) | ترجمة ar/en موحّدة |
| `car_brands` | 4 (main_brand) | **إزالة تكرار BYD** + إخراج غير-الماركات (§6.4) |
| `brand_classes` | (brand_class) | Genuine/OEM/Aftermarket/Used — توحيد التسمية |
| `part_categories` | (part_category) | |
| `regions` | 2 (region) | + جدول `cities` مرتبط (بدل `city` النصّي المكرر) |
| `cancellation_reasons` | (cancel reasons) | **تنظيف list 23 الملوّثة** (§6.3) |
| `return_reasons` | 23 (client-side) | إزالة قيم الحالة المدسوسة |
| `payment_accounts` | (payment_account) | |
| `bonus_tiers` | (incentive tiers) | نموذج الحوافز |

> كل جدول reference: `id, code (ثابت), label_ar, label_en, sort_order, is_active`.
> جدول الحالات يحمل `code` ثابت يُبنى عليه الـ state machine في طبقة التطبيق (لا في list نصّي).

---

## 6. المشترك / Cross-cutting

### `attachments` — polymorphic **واحد** (يحلّ §6.4)
`id, tenant_id, entity_type (enum: rfq/rfq_item/rfq_vendor/order/order_item/purchase_order/delivery/return/return_issue/invoice/credit_note), entity_id uuid, file_key (MinIO), file_name, mime_type, size_bytes, uploaded_by, created_at`
> بديل موحّد لـ `files` + `quotation_attachments` + `purchase_invoice_attachments` + `returned_issue_attachments`.

### `status_logs` — append-only (يحلّ §6.5)
`id, tenant_id, entity_type (enum), entity_id uuid, from_status_id, to_status_id, changed_by, created_at`
> **بلا `updated_by`** (append-only). محور واحد بدل تكرار `status_changed_by`/`created_by`.

### `notes`
`id, tenant_id, entity_type (enum), entity_id uuid, body, is_internal bool, created_by, created_at, updated_at`

### `signatures`
`id, tenant_id, image_key, signed_by, created_at` (يشير إليه deliveries/returns).

### الترقيم — `tenant_order_sequences` (يحلّ §6.8)
لكل `(tenant_id, region_id/scope)` **sequence حقيقي** يُنشأ عند إنشاء الـ tenant/النطاق.
توليد الرقم = `nextval` ذرّي (لا `MAX()+1`، لا `FOR UPDATE`، لا خنق تحت الضغط).

### الحسابات (Account Managers) — نطاق تشغيلي
`account_managers` (= users بدور)، `account_manager_branches`, `account_manager_slots`,
`account_manager_allocations`, `account_manager_attendance`, `weekly_days_off` (**جدول واحد** يحلّ §6.4).
كلها `tenant_id` + RLS.

---

## 7. جدول ربط القديم → الجديد (للترحيل — المرحلة 6)

| القديم | الجديد | تحويل |
|---|---|---|
| `quotations` | `rfqs` | + `tenant_id`, + `workshop_branch_id` (من البند) |
| `quotation_items` | `rfq_items` | `customer_id` يصعد للرأس |
| `quotation_vendors` | `rfq_vendors` | `access_token` → `token_hash` |
| `quotation_vendor_items` | `rfq_vendor_items` | `sla` نصّي يُسقَط، `sla_hours` يبقى |
| `confirmed_orders` | `orders` | |
| `confirmed_items` | `order_items` | المحور |
| `list_data` (كل قائمة) | جدول reference/enum مطابق | تنظيف التلوّث والتكرار |
| `delivery_notes`/`return_notes` (مسطّح) | `deliveries`/`returns` + بنود | من text → أنواع صحيحة |
| 4 جداول مرفقات | `attachments` | توحيد |

---

## 8. أسئلة مفتوحة للمراجعة (قرارك)

1. **نوع المفتاح الأساسي**: اخترت `uuid v7` (آمن + قابل للفرز). البديل `bigint identity` (أخفّ تخزيناً/أسرع join). موافق على uuid؟
2. **`profit_categories`**: عالمي أم tenant-scoped؟ (اخترت tenant — كل workspace قد يختلف.)
3. **الحالات**: جداول reference بـ `code` ثابت (مرن + قابل للترجمة) مقابل enums صرفة (أبسط لكن تغييرها ميجريشن). اخترت **جداول reference للحالات** و**enums للمجموعات الثابتة الصغيرة**. موافق؟
4. **`regions`/`cities`**: جدول مرجعي أم enum؟ (اخترت جدول — قابل للتوسّع بمدن جديدة.)
