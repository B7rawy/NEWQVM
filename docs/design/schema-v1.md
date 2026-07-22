# 🏗️ تصميم السكيما الجديدة — v1 (للمراجعة قبل الميجريشن)

**الحالة:** 📋 قيد المراجعة — 2026-07-22
**المرجع:** [old-system-schema.md](../reference/old-system-schema.md) · ADR-0003 · ADR-0008 · CONVENTIONS §DB
**القاعدة:** نحافظ على سلسلة الطلب ومفردات البيزنس كاملة، ونصلح كل عيوب القديم المسجّلة.

---

## 0. مبادئ التصميم

| المبدأ | التطبيق |
|---|---|
| **Tenancy أولاً** | `tenant_id uuid NOT NULL` على كل جدول transactional + RLS + composite indexes `(tenant_id, …)` |
| **العميل على الرأس لا البند** | `rfqs.workshop_branch_id` — إصلاح أكبر عيب هيكلي في القديم |
| **أنواع حقيقية** | Postgres **ENUMs** بدل `lists`/`list_data` العام (مع جداول config لما القيم بتتغير بإدارة المنصّة) |
| **مال وتواريخ صحيحة** | كل المبالغ `numeric(12,2)`، كل الطوابع `timestamptz` UTC، **ممنوع** نصوص |
| **مفاتيح** | كيانات الهوية (tenants/users/vendors) = `uuid`؛ الجداول التشغيلية عالية الحجم = `bigint identity` |
| **ترقيم آمن** | sequence حقيقي لكل (tenant × نطاق) — عمود counter بقفل صف واحد، لا `MAX()+1` |
| **مرفقات موحّدة** | جدول `attachments` واحد polymorphic بدل 4 آليات في القديم |
| **تاريخ حالة موحّد** | جدول `status_history` واحد لكل الكيانات بدل جداول logs متناثرة |
| **توكنات مُهاشة** | أي توكن وصول عام يُخزَّن hash فقط + صلاحية زمنية |

---

## 1. الـ ENUMs (بدل جدولَي lists/list_data)

مستخرجة من الـ 172 قيمة في القديم، **منضّفة من التلوث** (توحيد Canceled/Cancelled، إزالة القيم المدسوسة):

```
rfq_item_status:      new · extracting_pn · ready_for_quotation · tendering · sent_to_vendors
                      · priced · unavailable · confirmed · processing · out_for_delivery
                      · dn_sign_pending · delivered · pending_invoice · invoiced
                      · cancellation_requested · cancelled
                      · return_requested · returned · rn_sign_pending
                      · pending_credit_note · credit_note_issued · settled · claim_sent
vendor_quote_status:  quote_requested · quoted · previous_price_confirmed · order_confirmed
                      · preparing · ready_for_pickup · delivered · invoice_uploaded
                      · settled · cancelled · unavailable · return_requested · returned
                      · return_invoice_uploaded
brand_class:          genuine · oem · aftermarket · used        ← التسمية الموحّدة (كانت متضاربة بين المستندات)
order_type:           regular · bulk
delivery_type:        (من قيم القديم list 6)
return_responsibility: internal · vendor · client · delivery_agent
attachment_kind:      part_photo · vendor_invoice · vendor_return_invoice · quotation_pdf
                      · delivery_note · return_note · issue_photo · other
user_kind (platform): platform_admin · tenant_staff · workshop_user · vendor_user
```

**قوائم تظل جداول config** (لأنها بيانات تشغيلية تتغيّر): `regions`, `car_brands`, `part_categories`,
`cancellation_reasons`, `return_reasons`, `payment_accounts`, `cost_ranges` — لكن **جدول مستقل لكل نوع**
(بأعمدة مناسبة له) لا جدول عام واحد. أغلبها يحمل `tenant_id` (كل workspace يظبط قوائمه).

---

## 2. طبقة المنصّة والـ Tenancy

```
tenants          uuid pk · name · slug (subdomain, unique) · logo_url · settings jsonb
                 · plan · is_sandbox bool · is_active · created_at/updated_at
users            uuid pk · email (unique) · password_hash · full_name · phone
                 · is_platform_admin bool · created_at …        ← هوية عالمية واحدة للشخص
tenant_members   tenant_id + user_id (pk) · role (tenant_role enum: owner · admin · account_manager
                 · purchasing · part_extractor · finance · viewer) · is_active
workshops        bigint pk · tenant_id · name · zoho_id? · is_bulk · settings          ← "الورشة العميلة"
workshop_branches bigint pk · tenant_id · workshop_id · name · region_id · city · order_category
workshop_members tenant_id · workshop_branch_id · user_id · role (workshop_role enum:
                 workshop_admin · service_advisor · branch_manager)
```

- **`users` عالمي والعضويات هي اللي بتحدد الوصول** — نفس الشخص ممكن يكون في أكتر من tenant
  (نفس فلسفة الموردين المشتركين).
- أدوار القديم الـ 9 كلها ممثَّلة: 170→workshop_admin · 171→service_advisor · 172→tenant owner/admin
  · 173→account_manager · 195→branch_manager · 230/231→vendor roles · 232→purchasing · 233→part_extractor.

## 3. الموردون (ADR-0008 — عالمي + ربط)

```
vendors            uuid pk · legal_name · cr_number? · vat_number? · phone · email     ← بلا tenant_id
vendor_branches    bigint pk · vendor_id · name · region_id · city · location · payment_method …
tenant_vendors     bigint pk · tenant_id · vendor_id · status · vendor_type (agency/market/…)
                   · payment_terms · rating · notes · linked_at        ← هنا الـ RLS والإعدادات
vendor_members     vendor_id + user_id · role (vendor_admin · vendor_branch_user)
                   · vendor_branch_ids bigint[]
```

كل استعلام موردين من داخل workspace يمرّ عبر `tenant_vendors` (إلزامي — CONVENTIONS).

## 4. سلسلة الطلب (القلب — محفوظة من القديم ومُصلَّحة)

```
rfqs               bigint pk · tenant_id · rfq_number (unique per tenant) · workshop_id
                   · workshop_branch_id      ← ✅ العميل على الرأس (إصلاح عيب القديم)
                   · plate_number · vin · car_brand_id · model · order_type · delivery_type
                   · service_advisor_id · account_manager_id · shipping_price/type · created_by …
rfq_items          bigint pk · tenant_id · rfq_id · part_number · part_description · quantity
                   · brand_class · part_category_id · status (rfq_item_status) · unit_price
                   · discount_percent · agency_price · winning_quote_id → vendor_quote_items
                   · extraction fields (extracted_by/at) · cancellation_reason_id …
rfq_vendors        bigint pk · tenant_id · rfq_id · tenant_vendor_id · vendor_branch_id?
                   · status · sla_hours numeric · access_token_hash · token_expires_at   ← ✅ hash فقط
vendor_quote_items bigint pk · tenant_id · rfq_vendor_id · rfq_item_id · offered_price
                   · available_qty · available_brand_class · alternative_part_number
                   · discount · sla_hours · status (vendor_quote_status) · is_best_cost
                   (unique: rfq_vendor_id + rfq_item_id)
orders             bigint pk · tenant_id · rfq_id (unique) · confirmed_at · confirmed_by      ← "confirmed_orders"
order_items        bigint pk · tenant_id · order_id · rfq_item_id (UNIQUE — 1:1 كالقديم)
                   · final_part_number · approved_qty · status · return_type? …
                   ← ✅ يبقى **محور التنفيذ** (كل المستندات التالية تشير إليه)
purchase_orders    bigint pk · tenant_id · order_id · tenant_vendor_id · payment_account_id
                   · status · zoho_bill_url? …
purchase_order_items bigint pk · tenant_id · purchase_order_id · order_item_id
                   · winning_quote_id → vendor_quote_items · qty · unit_cost · status
pickups / pickup_items        (استلام من فرع المورد — كالقديم)
deliveries         bigint pk · tenant_id · order_id · scheduled_at · delivered_at
                   · signature_attachment_id? · status
delivery_items     delivery_id · order_item_id · qty          ← ✅ يدعم التسليم المجزّأ (عيب القديم)
invoices / invoice_items          (فاتورة العميل + كمياتها، due_date/paid_at)
returns / return_items            (مرتجع العميل + الكميات + سبب)
credit_notes / credit_note_items  (إشعار خصم العميل)
vendor_credit_notes / _items      (مرتجع الشراء للمورد)
return_issues      bigint pk · tenant_id · order_item_id · responsibility (enum) · issue_type
                   · delivery_agent_id? · resolution … (+ attachments عبر الجدول الموحّد)
```

**مستندات التسليم/المرتجع (DN/RN):** لم تعد جداول مسطّحة — المستند = `deliveries`/`returns`
+ بنوده، والـ PDF الموقَّع = صف في `attachments`. حالة التوقيع عمود على المستند.

## 5. التسعير والهوامش (نموذج القديم محفوظ)

```
cost_ranges        tenant_id · from/