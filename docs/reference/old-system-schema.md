# مرجع سكيما النظام القديم — QVM / Qparts
# Old System Schema Reference — `qvm_new_apps`

> **⚠️ قراءة فقط / READ-ONLY**
> هذا المستند **استُخرج بالقراءة فقط** من قاعدة بيانات الإنتاج للنظام القديم
> (Supabase project `vvkulhfjtznozgxiqluj`، schema `qvm_new_apps`) بتاريخ **2026-07-22**.
> لم يُعدَّل أي شيء في تلك القاعدة — كل الاستعلامات كانت `SELECT` فقط.
>
> **الغرض:** مرجع تصميمي حتى لا نفقد أي منطق بيزنس (سلسلة الطلب، الحالات، مفردات القوائم).
> **السكيما الجديدة ليست نسخة من هذه** — انظر:
> [ADR-0003](../decisions/0003-multi-tenancy-model.md)، [ADR-0007](../decisions/0007-data-seed-then-anonymized-migration.md)،
> [ADR-0008](../decisions/0008-tenant-model-and-shared-vendors.md)، و[المرحلة 1](../phases/phase-1-data-model.md).
>
> **This is a reference, not a target.** Do not port table names, `lists`-based typing, or the
> tenant-less design into the new schema. Port the **vocabulary and the lifecycle**, not the DDL.

**الأرقام العامة / At a glance**

| البند | القيمة |
|---|---|
| Schema | `qvm_new_apps` |
| عدد الجداول (base tables) | 68 |
| عدد علاقات الـ FK | 143 |
| جداول العرض (views / matviews) | 0 داخل هذا الـ schema |
| القوائم المرجعية (`lists`) | 25 قائمة، 172 قيمة |
| نموذج الـ tenancy | **لا يوجد** — لا عمود `tenant_id`/`company_id` في أي جدول |

---

## 1. سلسلة الطلب / The Order Chain

### 1.1 المسار الرئيسي (Header level)

```
quotations                 ← رأس الـ RFQ / طلب التسعير (order_number, plate_number, delivery_type, order_type)
   │
   ├─► quotation_vendors        ← إرسال الـ RFQ لمورّد/فرع مورّد (+ access_token للبوابة)
   │       └─► quotation_vendor_items   ← تسعيرة المورّد للبند (cost, sla, best_cost)
   │
   ├─► quotation_items          ← بنود الـ RFQ (part_number, qty, brand_class, سعر البيع)
   │
   └─► confirmed_orders         ← تأكيد العميل (1 quotation → 1 confirmed_order)
           │
           ├─► confirmed_items          ← البند المؤكَّد (final_part_number, approved_qty)
           │       (unique على quotation_item_id → علاقة 1:1 مع بند الـ RFQ)
           │
           ├─► purchase_orders          ← أمر شراء لكل مورّد داخل الطلب المؤكَّد
           │       └─► purchase_items          ← بند الشراء (cost_id → التسعيرة المختارة)
           │               └─► pickups / pickup_items   ← استلام من فرع المورّد
           │       └─► vendor_creditnotes → vendor_creditnote_items   ← مرتجع للمورّد
           │       └─► purchase_invoice_attachments      ← فواتير المورّد
           │
           ├─► deliveries               ← شحنة تسليم للعميل (+ توقيع)
           │       └─► delivery_items          ← الكميات المسلَّمة (+ ربط بالفاتورة)
           │
           ├─► invoices                 ← فاتورة العميل (Zoho)
           │       └─► invoice_items           ← الكميات المفوترة
           │
           ├─► returns                  ← مرتجع من العميل (+ توقيع)
           │       └─► return_items            ← الكميات المرتجعة (+ ربط بإشعار الخصم)
           │
           ├─► creditnotes              ← إشعار خصم للعميل
           │       └─► creditnote_items        ← الكميات + سبب الإرجاع
           │
           └─► returned_issues          ← ملف "مشكلة إرجاع" (المسؤولية، النوع، المندوب)
                   └─► returned_issue_attachments
```

### 1.2 مفاتيح السلسلة (chain keys) — الأهم للتصميم الجديد

| الحلقة | مفتاح الربط | ملاحظة |
|---|---|---|
| RFQ → بند RFQ | `quotation_items.quotation_id` | |
| بند RFQ → تسعيرة مورّد | `quotation_vendor_items.quotation_item_id` + `.quotation_vendor_id` | unique معاً |
| التسعيرة المختارة | `quotation_items.cost_id → quotation_vendor_items.cost_id` | **`cost_id` هو "السعر الفائز"** |
| RFQ → طلب مؤكَّد | `confirmed_orders.quotation_id` | |
| بند RFQ → بند مؤكَّد | `confirmed_items.quotation_item_id` (**UNIQUE**) | 1:1 صارم |
| بند مؤكَّد → بند شراء | `purchase_items.confirmed_item_id` + `purchase_items.cost_id` | يعيد ربط التسعيرة الفائزة |
| بند مؤكَّد → تسليم/فاتورة/مرتجع/إشعار خصم | `confirmed_item_id` في كل جدول بنود | **`confirmed_item_id` هو محور الحياة كلها** |
| Delivery Note / Return Note | PK = `confirmed_item_id` | صف واحد فقط لكل بند — مستند مسطّح |

### 1.3 دورة حياة الحالة (item_status، list_id = 3)

الترتيب المنطقي المستنتَج من الأسماء (النظام القديم لا يفرض أي state machine في القاعدة):

```
New RFQ (15) → Extract PN (236) → Ready For Quotation (235) → Tendering (16) / Sent To Vendor (237)
   → Priced (17) → Confirmed (19) → Processing (21) → Out for Delivery (22)
   → DN Sign Pending (213) → Delivered (23) → Pending Invoice (25) → Invoice Issued (26)
   → Settled (31)

مسارات جانبية:
   Unavailable (20) | Cancellation Request (24) → Canceled (18) / Cancelled (268)
   Return Request (28) → Return (29) → RN Sign Pending (214)
        → Pending Credit Note (215) → Credit Note Issued (30) → Settled (31)
   Claim Sent (27) | Added by Vendor (267)
```

> ⚠️ لاحظ: **`Canceled` (18) و`Cancelled` (268) قيمتان منفصلتان لنفس المعنى** — تكرار في المفردات.

### 1.4 حالة المورّد (vendor_status، list_id = 15 — بالعربية)

```
طلب تسعير (157) → تم التسعير (158) / تأكيد سعر سابق (207) → طلب مؤكد (159)
   → قيد التجهيز (162) → جاهز للاستلام (163) → تم التسليم (164) → تم رفع الفاتورة (165)
   → تم التسوية (169)
جانبي: الغاء (160) | غير متوفر (161) | طلب ارجاع (166) → تم الارجاع (167) → تم رفع فاتورة المرتجع (168)
```

---

## 2. مرجع الجداول والأعمدة / Full Table & Column Reference

**الرموز:** `NN` = NOT NULL، `def=` = القيمة الافتراضية.
الأنواع كما هي في `pg_type` (`int4`=integer، `int8`=bigint، `int2`=smallint، `float8`=double precision،
`timestamptz`=timestamp with time zone، `_int2`/`_uuid`=مصفوفة).

> **قاعدة عامة في النظام القديم:** كل عمود اسمه يشير إلى قيمة معجمية (status/type/class/reason/brand…)
> هو `int4` يشير إلى `list_data.list_data_id`. لا توجد enums على مستوى القاعدة إطلاقاً.

---

### 2.1 نطاق الـ RFQ / التسعير — RFQ & Quotation

#### `quotations` — رأس طلب التسعير (~27 صف)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `quotation_id` | int4 | NN | **PK** |
| 2 | `order_number` | text | NULL | رقم الطلب المعروض (يُولَّد بـ `MAX()+1` — راجع §6) |
| 3 | `plate_number` | text | NULL | لوحة المركبة |
| 4 | `delivery_type` | int4 | NULL | → `list_data` (list 10) |
| 5 | `created_at` | timestamptz | NULL | `now()` |
| 6 | `updated_at` | timestamptz | NULL | `now()` |
| 7 | `order_type` | int4 | NULL | → `list_data` (list 17: Service Order / Stock) |
| 8 | `shipping_price` | float8 | NULL | سعر الشحن على العميل |
| 9 | `service_advisor` | uuid | NULL | → `user_data.user_id` |
| 10 | `account_manager` | uuid | NULL | → `user_data.user_id` |
| 11 | `shipping_type` | text | NULL | `'item'` — نص حر، ليس list |

#### `quotation_items` — بنود الـ RFQ (~424 صف)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `quotation_item_id` | int4 | NN | **PK** |
| 2 | `quotation_id` | int4 | NULL | → `quotations` |
| 3 | `part_description` | text | NULL | |
| 4 | `part_number` | text | NULL | |
| 5 | `quantity` | int4 | NULL | |
| 6 | `brand_class` | int4 | NULL | → list 5 |
| 7 | `part_photo` | text | NULL | |
| 8 | `item_status` | int4 | NULL | `def=15` (New RFQ) → list 3 |
| 9 | `alternative_part_number` | text | NULL | |
| 10 | `price_before_vat` | float8 | NULL | سعر البيع للوحدة |
| 11 | `total_price_before_vat` | float8 | NULL | **محسوب ومخزَّن** (denormalized) |
| 12 | `cost_id` | int4 | NULL | → `quotation_vendor_items` — **التسعيرة الفائزة** |
| 13 | `created_at` | timestamptz | NULL | `now()` |
| 14 | `updated_at` | timestamptz | NULL | `now()` |
| 15 | `main_brand` | int4 | NULL | → list 4 (car_brand) |
| 16 | `model` | text | NULL | |
| 17 | `customer_id` | int4 | NULL | → `client_branches.customer_id` — **العميل على مستوى البند، لا الرأس** |
| 18 | `vin` | text | NULL | |
| 19 | `discount_percent` | float8 | NULL | `def=0` |
| 20 | `agency_price` | float8 | NULL | `def=0` سعر الوكالة المرجعي |
| 21 | `cancellation_reason` | int4 | NULL | → list 20 |
| 22 | `part_category` | int4 | NULL | → list 6 |
| 23 | `alternative_brand_class` | int4 | NULL | → list 5 |
| 24 | `estimated_price` | float8 | NULL | |
| 25 | `year` | text | NULL | سنة الموديل — **نص وليس رقم** |
| — | *(الترتيب 26 محذوف)* | — | — | عمود مُسقَط سابقاً |
| 27 | `line_item_code` | text | NULL | **UNIQUE** — كود البند الظاهر |
| 28 | `item_pk` | text | NULL | مفتاح خارجي نصّي (Retool legacy) |
| 29 | `created_by` | uuid | NULL | → `auth.users.id` |
| 30 | `extracted_by` | uuid | NULL | من استخرج رقم القطعة |
| 31 | `extracted_at` | timestamptz | NULL | |
| 32 | `updated_by` | uuid | NULL | |
| 33 | `extraction_status` | text | NULL | CHECK: `cannot_extract` \| `unclear` \| NULL |

#### `quotation_vendors` — إرسال الـ RFQ للمورّدين (~165 صف)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `quotation_vendor_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `vendor_id` | int4 | NULL | → `vendors` |
| 4 | `quotation_id` | int4 | NULL | → `quotations` |
| 5 | `updated_at` | timestamptz | NULL | `now()` |
| 6 | `attachment_url` | jsonb | NULL | مرفقات — **مكرَّرة مع `quotation_attachments`** |
| 7 | `email_id` | text | NULL | معرّف رسالة البريد المرسلة |
| 8 | `vendor_status` | int4 | NULL | → list 15 |
| 9 | `vendor_branch_id` | int8 | NULL | → `vendor_branches` |
| 10 | `access_token` | uuid | NN | `gen_random_uuid()` — **UNIQUE**، توكن بوابة المورّد بدون تسجيل دخول |
| 11 | `token_expires_at` | timestamptz | NN | `now() + 7 days` |

#### `quotation_vendor_items` — تسعيرات المورّدين (~1,022 صف)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `cost_id` | int4 | NN | **PK** |
| 2 | `quotation_item_id` | int4 | NULL | → `quotation_items` |
| 3 | `cost` | numeric | NULL | تكلفة الوحدة من المورّد |
| 4 | `vendor_id` | int4 | NULL | → `vendors` |
| 5 | `item_shipping` | float8 | NULL | |
| 6 | `sla` | text | NULL | نصّي (قديم) |
| 7 | `best_cost` | bool | NULL | علامة "أفضل سعر" |
| 8 | `available_quantity` | int4 | NULL | |
| 9 | `created_at` | timestamptz | NULL | `now()` |
| 10 | `updated_at` | timestamptz | NULL | `now()` |
| 11 | `quotation_vendor_id` | int8 | NULL | → `quotation_vendors` |
| 12 | `available_brand_class` | int4 | NULL | → list 5 |
| 13 | `alternative_part_number` | text | NULL | |
| 14 | `discount_percent` | numeric | NULL | |
| 15 | `vendor_item_status` | int4 | NULL | → list 15 |
| 16 | `from_database` | bool | NULL | السعر من ملف المخزون لا من المورّد |
| 17 | `agency_price` | numeric | NULL | |
| 18 | `created_by` | uuid | NULL | |
| 19 | `price_source` | text | NULL | نص — **يوازي list 8 `pricing_source` بلا FK** |
| 20 | `vendor_part_number` | text | NULL | |
| 21 | `sla_hours` | numeric | NULL | البديل الرقمي لـ `sla` — **الاثنان موجودان** |

**UNIQUE:** `(quotation_item_id, quotation_vendor_id)`

#### `quotation_attachments`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `attachment_id` | int8 | NN | **PK** |
| 2 | `quotation_id` | int4 | NN | |
| 3 | `vendor_id` | int4 | NULL | |
| 4 | `quotation_vendor_id` | int8 | NULL | |
| 5 | `file_url` | text | NN | |
| 6 | `file_path` | text | NULL | |
| 7 | `file_name` | text | NULL | |
| 8 | `file_type` | text | NULL | |
| 9 | `mime_type` | text | NULL | |
| 10 | `file_size` | int8 | NULL | |
| 11 | `ai_extracted` | bool | NN | `false` |
| 12 | `created_at` | timestamptz | NN | `now()` |
| 13 | `created_by` | uuid | NULL | `auth.uid()` |

> ⚠️ لا يوجد FK من `quotation_attachments` إلى `quotations` أو `vendors` — روابط منطقية فقط.

#### `quotation_account_managers` — سجل إعادة تعيين مدير الحساب
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `assigned_from` | uuid | NULL | → `user_data` |
| 4 | `assigned_to` | uuid | NULL | → `user_data` |
| 5 | `quotation_id` | int4 | NULL | → `quotations` |

---

### 2.2 نطاق الطلبات المؤكَّدة — Confirmed Orders

#### `confirmed_orders`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `confirmed_order_id` | int4 | NN | **PK** |
| 2 | `quotation_id` | int4 | NULL | → `quotations` |
| 3 | `created_at` | timestamptz | NULL | `now()` |
| 4 | `updated_at` | timestamptz | NULL | `now()` |
| 5 | `client_po` | text | NULL | أمر الشراء من العميل |

#### `confirmed_items` (~16 صف)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `confirmed_item_id` | int4 | NN | **PK** — محور كل جداول التنفيذ |
| 2 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 3 | `final_part_number` | text | NULL | **رقم القطعة النهائي — مفتاح المطابقة في التقارير** |
| 4 | `approved_qty` | int4 | NULL | |
| 5 | `item_status` | int4 | NULL | → list 3 |
| 6 | `return_type` | int4 | NULL | → list 12 |
| 7 | `created_at` | timestamptz | NULL | `now()` |
| 8 | `updated_at` | timestamptz | NULL | `now()` |
| 9 | `quotation_item_id` | int4 | NULL | → `quotation_items` — **UNIQUE** |
| 10 | `client_return_reason` | int4 | NULL | → list 23 |
| 11 | `final_brand_class` | int4 | NULL | → list 5 |
| 12 | `cancellation_reason` | int4 | NULL | → list 20 |
| 13 | `requested_return_qty` | int4 | NULL | |
| 14 | `created_by` | uuid | NULL | → `auth.users` |
| 15 | `updated_by` | uuid | NULL | |

---

### 2.3 نطاق الشراء — Purchasing

#### `purchase_orders`
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `purchase_order_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 4 | `vendor_id` | int4 | NULL | → `vendors` |
| 5 | `vendor_status` | int4 | NULL | → list 15 |
| 6 | `vendor_invoice_url` | text | NULL | **مكرَّر مع `purchase_invoice_attachments`** |
| 7 | `vendor_invoice_number` | text | NULL | نفس الملاحظة |
| 8 | `vendor_return_url` | text | NULL | **مكرَّر مع `vendor_creditnotes`** |
| 9 | `zoho_bill_url` | text | NULL | تكامل Zoho |
| 10 | `uploaded_by` | uuid | NULL | → `user_data` |
| 11 | `payment_account` | int8 | NULL | → list 7 (بلا FK — لاحظ int8 بينما `list_data_id` int4) |
| 12 | `uploaded_at` | timestamptz | NULL | |
| 13 | `uploaded_source` | text | NULL | `'internal'` — CHECK: internal \| vendor |
| 14 | `vendor_branch_id` | int8 | NULL | → `vendor_branches` |
| 15 | `created_by` | uuid | NULL | |
| 16 | `updated_by` | uuid | NULL | |

#### `purchase_items`
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `purchase_item_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 4 | `purchase_order_id` | int8 | NULL | → `purchase_orders` |
| 5 | `cost_id` | int4 | NULL | → `quotation_vendor_items` |
| 6 | `approved_qty` | int4 | NULL | |
| 7 | `final_purchase_price` | float8 | NULL | التكلفة الفعلية |
| 8 | `received_qty` | int4 | NULL | |
| 9 | `vendor_item_status` | int4 | NULL | → list 15 |
| 10 | `payment_account` | int4 | NULL | → list 7 |
| 11 | `updated_at` | timestamptz | NULL | `now()` |
| 12 | `vendor_shipping_cost` | float8 | NN | `0` |
| 13 | `created_by` | uuid | NULL | |
| 14 | `updated_by` | uuid | NULL | |

#### `purchase_invoice_attachments`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `attachment_id` | int8 | NN | **PK**، sequence |
| 2 | `confirmed_order_id` | int4 | NN | **بلا FK** |
| 3 | `purchase_order_id` | int8 | NULL | → `purchase_orders` (ON DELETE SET NULL) |
| 4 | `file_url` | text | NN | |
| 5 | `file_path` | text | NULL | |
| 6 | `mime_type` | text | NULL | |
| 7 | `file_size` | int4 | NULL | |
| 8 | `invoice_number` | text | NULL | |
| 9 | `uploaded_by` | uuid | NULL | |
| 10 | `uploaded_at` | timestamptz | NULL | `now()` |
| 11 | `uploaded_source` | text | NULL | `'internal'` — CHECK: internal \| vendor |

#### `pickups` / `pickup_items` — الاستلام من فرع المورّد
| جدول | # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|---|
| `pickups` | 1 | `pickup_id` | int8 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `pickup_date` | timestamptz | NULL | `now()` |
| | 4 | `purchase_order_id` | int8 | NULL | → `purchase_orders` |
| | 5 | `pickup_status` | int4 | NULL | → `list_data` |
| | 6 | `delivery_agent` | uuid | NULL | → `user_data` |
| `pickup_items` | 1 | `pickup_item_id` | int8 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `pickup_id` | int8 | NULL | → `pickups` |
| | 4 | `purchase_item_id` | int8 | NULL | → `purchase_items` |
| | 5 | `pickup_qty` | int4 | NULL | |
| | 6 | `created_by` | uuid | NULL | |

#### `vendor_creditnotes` / `vendor_creditnote_items` — مرتجع للمورّد
| جدول | # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|---|
| `vendor_creditnotes` | 1 | `vendor_creditnote_id` | int8 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `purchase_order_id` | int8 | NULL | → `purchase_orders` |
| | 4 | `vendor_creditnote_number` | text | NULL | |
| | 5 | `vendor_creditnote_url` | text | NULL | |
| | 6 | `uploaded_by` | uuid | NULL | |
| | 7 | `uploaded_at` | timestamptz | NULL | `now()` |
| | 8 | `uploaded_source` | text | NULL | CHECK: internal \| vendor |
| `vendor_creditnote_items` | 1 | `id` | int8 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `vendor_creditnote_id` | int8 | NULL | → `vendor_creditnotes` |
| | 4 | `purchase_item_id` | int8 | NULL | → `purchase_items` |
| | 5 | `return_qty` | int4 | NULL | |
| | 6 | `return_reason` | int4 | NULL | → `list_data` |
| | 7 | `created_by` | uuid | NULL | |

---

### 2.4 نطاق التسليم — Delivery

#### `deliveries`
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `delivery_id` | int4 | NN | **PK** |
| 2 | `delivery_date` | timestamptz | NULL | `now()` |
| 3 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 4 | `created_at` | timestamptz | NULL | `now()` |
| 5 | `updated_at` | timestamptz | NULL | `now()` |
| 6 | `shipping_price` | float8 | NULL | ما يُحصَّل من العميل |
| 7 | `shipping_cost` | float8 | NULL | ما يُدفع فعلياً |
| 8 | `signature` | text | NULL | صورة التوقيع |
| 9 | `signature_uuid` | uuid | NULL | → `user_data` (الموقِّع) |
| 10 | `client_po` | text | NULL | **مكرَّر مع `confirmed_orders.client_po`** |

#### `delivery_items`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `delivery_item_id` | int4 | NN | **PK** |
| 2 | `delivery_id` | int4 | NULL | → `deliveries` |
| 3 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 4 | `delivered_qty` | int4 | NULL | |
| 5 | `created_at` | timestamptz | NULL | `now()` |
| 6 | `updated_at` | timestamptz | NULL | `now()` |
| 7 | `received_qty` | int4 | NULL | ما استلمه العميل فعلاً |
| 8 | `invoice_id` | int8 | NULL | → `invoices` — **ربط الفاتورة على مستوى بند التسليم أيضاً** |
| 9 | `created_by` | uuid | NULL | |

**UNIQUE:** `(delivery_id, confirmed_item_id)`

#### `delivery_notes` — مستند إشعار التسليم (مسطَّح/denormalized)
> **PK = `confirmed_item_id`** — صف واحد لكل بند مؤكَّد. كل الحقول تقريباً `text` حتى الأرقام والتواريخ.

| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `order_number` | text | NULL | منسوخ |
| 2 | `invoice_number` | text | NULL | منسوخ |
| 3 | `client_name` | text | NULL | منسوخ |
| 4 | `branch` | text | NULL | منسوخ |
| 5 | `confirmation_date` | text | NULL | **تاريخ كنص** |
| 6 | `delivery_date` | text | NULL | **تاريخ كنص** |
| 7 | `final_part_number` | text | NULL | |
| 8 | `part_description` | text | NULL | |
| 9 | `main_brand` | text | NULL | |
| 10 | `brand_class` | text | NULL | |
| 11 | `approved_quantity` | int8 | NULL | |
| 12 | `price_before_vat` | float8 | NULL | |
| 13 | `total_price_before_vat` | text | NULL | **رقم كنص** |
| 14 | `vat` | text | NULL | **رقم كنص** |
| 15 | `total_price_including_vat` | text | NULL | **رقم كنص** |
| 16 | `notes` | text | NULL | |
| 17 | `confirmed_item_id` | int4 | NN | **PK** → `confirmed_items` |
| 18 | `signature` | text | NULL | |
| 19 | `signed_by` | text | NULL | |
| 20 | `model` | text | NULL | |
| 21 | `plate_number` | text | NULL | |
| 22 | `created_at` | timestamptz | NULL | `now()` |
| 23 | `status` | text | NULL | **نص حر — لا يشير إلى list** |
| 24 | `updated_at` | timestamptz | NULL | `now()` |
| 25 | `vin` | text | NULL | |
| 26 | `discount_percent` | numeric | NULL | `0` |
| 27 | `shipping_price` | numeric | NULL | `0` |

---

### 2.5 نطاق المرتجعات — Returns

#### `returns`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `return_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NULL | `now()` |
| 3 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 4 | `return_date` | timestamptz | NULL | `now()` |
| 5 | `shipping_price` | float4 | NULL | **float4 هنا بينما float8 في `deliveries`** |
| 6 | `shipping_cost` | float4 | NULL | نفس الملاحظة |
| 7 | `signature` | text | NULL | |
| 8 | `signature_uuid` | uuid | NULL | → `user_data` |
| 9 | `updated_at` | timestamptz | NULL | `now()` |
| 10 | `referenced_client_po` | text | NULL | |

#### `return_items`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `return_item_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NULL | `now()` |
| 3 | `return_id` | int8 | NULL | → `returns` |
| 4 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 5 | `creditnote_id` | int8 | NULL | → `creditnotes` |
| 6 | `return_qty` | int4 | NULL | |
| 7 | `updated_at` | timestamptz | NULL | `now()` |
| 8 | `created_by` | uuid | NULL | |

#### `return_notes` — مستند إشعار الإرجاع
> **PK = `confirmed_item_id`**. هيكل مطابق تماماً لـ `delivery_notes` مع تبديل
> `invoice_number → creditnote_number`، `delivery_date → return_date`، `approved_quantity → return_quantity`.
> نفس مشاكل الأنواع (تواريخ وأرقام كنصوص).

| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `order_number` | text | NULL | |
| 2 | `creditnote_number` | text | NULL | |
| 3 | `client_name` | text | NULL | |
| 4 | `branch` | text | NULL | |
| 5 | `confirmation_date` | text | NULL | تاريخ كنص |
| 6 | `return_date` | text | NULL | تاريخ كنص |
| 7 | `final_part_number` | text | NULL | |
| 8 | `part_description` | text | NULL | |
| 9 | `main_brand` | text | NULL | |
| 10 | `brand_class` | text | NULL | |
| 11 | `return_quantity` | int8 | NULL | |
| 12 | `price_before_vat` | float8 | NULL | |
| 13 | `total_price_before_vat` | text | NULL | رقم كنص |
| 14 | `vat` | text | NULL | رقم كنص |
| 15 | `total_price_including_vat` | text | NULL | رقم كنص |
| 16 | `notes` | text | NULL | |
| 17 | `confirmed_item_id` | int4 | NN | **PK** → `confirmed_items` |
| 18 | `signature` | text | NULL | |
| 19 | `signed_by` | text | NULL | |
| 20 | `model` | text | NULL | |
| 21 | `plate_number` | text | NULL | |
| 22 | `created_at` | timestamptz | NULL | `now()` |
| 23 | `status` | text | NULL | نص حر |
| 24 | `updated_at` | timestamptz | NULL | `now()` |
| 25 | `vin` | text | NULL | |
| 26 | `discount_percent` | numeric | NULL | `0` |
| 27 | `shipping_price` | numeric | NULL | `0` |

#### `returned_issues` — ملف مشكلة الإرجاع (الإصدار الحديث)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `returned_issue_id` | int8 | NN | **PK**، sequence |
| 2 | `confirmed_item_id` | int4 | NN | → `confirmed_items` (CASCADE) |
| 3 | `confirmed_order_id` | int4 | NN | → `confirmed_orders` (CASCADE) — **تكرار: يُشتق من البند** |
| 4 | `status` | int4 | NULL | → `list_data` |
| 5 | `return_type` | int4 | NULL | → list 12 |
| 6 | `main_supplier` | int4 | NULL | → **`list_data`** ⚠️ (بينما `return_issues.main_vendor` → `vendors`) |
| 7 | `delivery_representative` | uuid | NULL | → `user_data` |
| 8 | `extraction_source` | int4 | NULL | → list 24 (part_number_source) |
| 9 | `return_reason` | int4 | NULL | → `list_data` (13 أو 23) |
| 10 | `pre_shipping_photo_done` | bool | NULL | `false` |
| 11 | `post_photo_review_done` | bool | NULL | `false` |
| 12 | `notes` | text | NULL | |
| 13 | `created_by` | uuid | NULL | |
| 14 | `created_at` | timestamptz | NULL | `now()` |
| 15 | `updated_by` | uuid | NULL | |
| 16 | `updated_at` | timestamptz | NULL | `now()` |
| 17 | `delivery_company` | int4 | NULL | → list 11 |

#### `return_issues` — النسخة القديمة من نفس المفهوم ⚠️ (مهجورة على الأرجح)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `return_item_id` | int4 | NN | **PK** — الاسم مضلّل (ليس بند مرتجع) |
| 2 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 3 | `main_vendor` | int4 | NULL | → `vendors` |
| 4 | `return_reasons` | int4 | NULL | → `list_data` |
| 5 | `part_number_source` | int4 | NULL | → list 24 |
| 6 | `photo_taken` | bool | NULL | |
| 7 | `checked` | bool | NULL | |
| 8 | `photos` | text | NULL | نص واحد بدل جدول مرفقات |
| 9 | `created_at` | timestamptz | NULL | `now()` |
| 10 | `updated_at` | timestamptz | NULL | `now()` |
| 11 | `delivery_agent` | uuid | NULL | → `user_data` |
| 12 | `delivery_company` | int4 | NULL | → list 11 |

#### `returned_issue_attachments`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `attachment_id` | int8 | NN | **PK**، sequence |
| 2 | `returned_issue_id` | int8 | NN | → `returned_issues` (CASCADE) |
| 3 | `file_url` | text | NN | |
| 4 | `file_path` | text | NULL | |
| 5 | `mime_type` | text | NULL | |
| 6 | `file_size` | int4 | NULL | |
| 7 | `uploaded_by` | uuid | NULL | |
| 8 | `uploaded_at` | timestamptz | NULL | `now()` |

---

### 2.6 نطاق الفوترة — Invoicing

#### `invoices`
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `invoice_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 4 | `invoice_number` | text | NULL | |
| 5 | `invoice_url` | text | NULL | |
| 6 | `zoho_status` | text | NULL | نص حر من Zoho |
| 7 | `notes` | text | NULL | |
| 8 | `due_date` | date | NULL | |
| 9 | `paid_at` | timestamptz | NULL | |

#### `invoice_items`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `invoice_id` | int8 | NULL | → `invoices` |
| 4 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 5 | `invoiced_qty` | int4 | NULL | |
| 6 | `created_by` | uuid | NULL | |

#### `creditnotes`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `creditnote_id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `confirmed_order_id` | int4 | NULL | → `confirmed_orders` |
| 4 | `creditnote_number` | text | NULL | |
| 5 | `creditnote_url` | text | NULL | |

#### `creditnote_items`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `creditnote_id` | int8 | NULL | → `creditnotes` |
| 4 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 5 | `return_qty` | int4 | NULL | |
| 6 | `return_reason` | int4 | NULL | → `list_data` |
| 7 | `created_by` | uuid | NULL | |

---

### 2.7 نطاق الموردين — Vendors

#### `vendors` (~56 صف)
> ⚠️ ترتيب الأعمدة فيه فجوات كبيرة (5–9، 12–15، 19–20، 24) = أعمدة مُسقَطة تاريخياً.

| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `vendor_id` | int4 | NN | **PK** |
| 2 | `vendor_name` | text | NULL | **UNIQUE** |
| 3 | `zoho_name` | text | NULL | |
| 4 | `vendor_type` | text | NULL | **نص قديم — استُبدل بـ `vendor_type_id`** |
| 10 | `tax_number` | text | NULL | |
| 11 | `commercial_registeration_number` | text | NULL | *(خطأ إملائي في الاسم كما هو)* |
| 16 | `created_at` | timestamptz | NULL | `now()` |
| 17 | `updated_at` | timestamptz | NULL | `now()` |
| 18 | `zoho_id` | text | NULL | |
| 21 | `user_id` | uuid | NULL | → `user_data` — مستخدم واحد فقط للمورّد |
| 22 | `email` | text | NULL | |
| 23 | `phone_numbers` | jsonb | NULL | |
| 25 | `vendor_type_id` | int4 | NULL | → list 26 |
| 26 | `receives_quotations` | bool | NN | `true` |
| 27 | `preferred_branch_id` | int8 | NULL | → `vendor_branches` (SET NULL) |

#### `vendor_branches` (~56 صف)
> ⚠️ فجوات في الترتيب (18–24) = أعمدة مُسقَطة.

| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `vendor_branch_id` | int8 | NN | **PK** |
| 2 | `vendor_id` | int4 | NN | → `vendors` |
| 3 | `branch_name` | text | NN | |
| 4 | `city` | text | NN | نص حر — **لا يشير إلى list 2 `region`** |
| 5 | `location_lat` | float8 | NULL | |
| 6 | `location_lng` | float8 | NULL | |
| 7 | `address` | text | NULL | |
| 8 | `brands` | jsonb | NN | `'[]'` — مصفوفة معرّفات ماركات (بلا سلامة مرجعية) |
| 9 | `categories` | jsonb | NN | `'[]'` |
| 10 | `is_active` | bool | NN | `true` |
| 11 | `created_at` | timestamptz | NN | `now()` |
| 12 | `updated_at` | timestamptz | NN | `now()` |
| 13 | `phone` | text | NULL | |
| 14 | `region` | jsonb | NULL | **jsonb بينما يوجد `region` كـ list** |
| 15 | `operating_hours` | jsonb | NULL | |
| 16 | `items_type` | jsonb | NULL | |
| 17 | `payment_method` | text | NULL | نص — يوازي list 9 بلا FK |
| 25 | `location` | text | NULL | **مكرَّر مع lat/lng/address** |
| 26 | `discount_percent` | float8 | NULL | |
| 27 | `notify_by_email` | bool | NN | `true` |
| 28 | `notify_by_whatsapp` | bool | NN | `false` |
| 29 | `banks` | jsonb | NN | `'[]'` |

#### `vendor_branch_users`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `user_id` | uuid | NN | → `user_data` (CASCADE) |
| 3 | `vendor_branch_id` | int8 | NN | → `vendor_branches` (CASCADE) |
| 4 | `created_at` | timestamptz | NN | `now()` |

**UNIQUE:** `(user_id, vendor_branch_id)`

#### `stock_files` — ملفات مخزون المورّدين (مصدر تسعير `from_database`)
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `vendor_id` | int4 | NULL | → `vendors` |
| 4 | `file_date` | date | NULL | |
| 5 | `part_number` | text | NULL | |
| 6 | `part_description` | text | NULL | |
| 7 | `quantity` | int4 | NULL | |
| 8 | `cost_before_discount` | float8 | NULL | |
| 9 | `discount_percent` | float8 | NULL | |
| 10 | `main_brand` | int4 | NULL | → list 4 |
| 11 | `brand_class` | int4 | NULL | → list 5 |
| 12 | `made_in` | text | NULL | |
| 13 | `updated_at` | timestamptz | NULL | `now()` |

---

### 2.8 المستخدمون والتنظيم — Users & Org

#### `user_data` (~43 صف)
> ⚠️ **PK = `email`** وليس `user_id`. `user_id` مجرد UNIQUE.

| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `user_name` | text | NULL | |
| 2 | `retool_user_name` | text | NULL | **إرث Retool** |
| 3 | `user_company` | int4 | NULL | → `list_data` (list 1 `client_name`) — **"الشركة" مجرد صف في dropdown** |
| 4 | `user_branch` | int4 | NULL | → `client_branches.customer_id` |
| 5 | `email` | text | NN | **PK** |
| 6 | `user_role` | int4 | NULL | → list 16 |
| 7 | `zoho_id` | text | NULL | |
| 8 | `created_at` | timestamptz | NULL | `now()` |
| 9 | `updated_at` | timestamptz | NULL | `now()` |
| 10 | `user_id` | uuid | NN | **UNIQUE** — يقابل `auth.users.id` |
| 11 | `user_type` | int4 | NULL | → list 18 |
| 12 | `user_vendor` | int4 | NULL | → `vendors` |
| 13 | `notification_method` | text | NN | `'email'` — CHECK: email \| whatsapp |

#### `client_branches` — فروع العملاء (الورش)
| # | العمود | النوع | Null | Default / ملاحظة |
|---|---|---|---|---|
| 1 | `customer_id` | int4 | NN | **PK** |
| 2 | `list_data_id` | int4 | NULL | → `list_data` (list 1) — **العميل/الشركة الأم** |
| 3 | `branch_name` | text | NULL | |
| 4 | `created_at` | timestamptz | NULL | `now()` |
| 5 | `updated_at` | timestamptz | NULL | `now()` |
| 6 | `region_id` | int4 | NULL | → list 2 |
| 7 | `order_category` | int4 | NULL | → list 21 |
| 8 | `zoho_id` | text | NULL | |
| 9 | `is_bulk_client` | bool | NULL | `false` — **يكرر معنى `order_category = Bulk`** |
| 10 | `city` | text | NULL | نص حر — يوازي `region_id` |

#### `email_otps`
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `email` | text | NN | **PK** |
| 2 | `code_hash` | text | NN | |
| 3 | `expires_at` | timestamptz | NN | |
| 4 | `attempts` | int4 | NN | `0` |
| 5 | `last_sent_at` | timestamptz | NN | `now()` |
| 6 | `verified` | bool | NN | `false` |
| 7 | `created_at` | timestamptz | NN | `now()` |

#### جداول تخصيص مديري الحسابات — Account Manager Allocation

`account_manager_slots` — أيام/سلوتات كل مدير حساب
| # | العمود | النوع | Null | Default |
|---|---|---|---|---|
| 1 | `id` | int4 | NN | **PK** |
| 2 | `account_manager` | uuid | NN | → `user_data` |
| 3–8 | `saturday` … `thursday` | bool | NULL | `true` (6 أعمدة، يوم لكل عمود) |
| 9 | `slot_number` | int2 | NN | CHECK ∈ {1,2,3} |
| 10 | `is_available` | bool | NULL | `true` |
| 11 | `created_at` | timestamptz | NULL | `now()` |
| 12 | `updated_at` | timestamptz | NULL | `now()` |

`account_manager_branches` — من يخدم أي فرع (رئيسي + بدلاء)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int4 | NN | **PK** |
| 2 | `customer_id` | int8 | NN | → `client_branches` (**int8 مقابل int4 في الهدف**) |
| 3 | `slot_number` | int2 | NN | CHECK ∈ {1,2,3} |
| 4 | `main_account_manager` | uuid | NULL | → `user_data` |
| 5 | `first_substitute` | uuid | NULL | → `user_data` |
| 6 | `second_substitute` | uuid | NULL | → `user_data` |
| 7 | `fallback_account_manager` | uuid | NULL | → `user_data` |
| 8 | `created_at` | timestamptz | NULL | `now()` |
| 9 | `updated_at` | timestamptz | NULL | `now()` |

`account_manager_allocations` — النتيجة المحسوبة (يوم × فرع × سلوت → مدير)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int4 | NN | **PK** |
| 2 | `customer_id` | int8 | NN | → `client_branches` |
| 3 | `slot_number` | int2 | NN | CHECK ∈ {1,2,3} |
| 4–9 | `saturday` … `thursday` | uuid | NULL | → `user_data` (6 أعمدة) |
| 10 | `calculated_at` | timestamptz | NULL | `now()` |

`account_manager_attendance` — إجازات/أعذار/إضافي
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int4 | NN | **PK** |
| 2 | `account_manager` | uuid | NN | → `user_data` |
| 3 | `record_type` | int4 | NN | → list 22 |
| 4 | `start_date` | date | NN | |
| 5 | `end_date` | date | NN | |
| 6 | `slots` | int2[] | NULL | CHECK ⊆ {1,2,3} |
| 7 | `created_by` | uuid | NN | → `user_data` |
| 8 | `created_at` | timestamptz | NULL | `now()` |

`account_manager_weekly_daysoff` — يوم راحة أسبوعي شهري
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK**، sequence |
| 2 | `account_manager` | uuid | NN | → `user_data` (RESTRICT/CASCADE) |
| 3 | `month` | date | NN | |
| 4 | `day_off` | int2 | NN | CHECK 0..6 |
| 5 | `created_at` | timestamptz | NN | `now()` |

**UNIQUE:** `(account_manager, month)`

`weekly_daysoff` — النسخة القديمة (مصفوفات uuid لكل يوم) ⚠️ مكرَّرة مع الجدول أعلاه
| # | العمود | النوع | Null |
|---|---|---|---|
| 1 | `id` | int4 | NN (**PK**) |
| 2 | `month` | date | NN |
| 3–8 | `saturday` … `thursday` | uuid[] | NN |
| 9 | `created_at` | timestamptz | NULL `now()` |

`branch_targets` / `branch_bonuses` — أهداف وحوافز الفروع
| جدول | # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|---|
| `branch_targets` | 1 | `id` | int4 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `branch_id` | int4 | NULL | → `client_branches` |
| | 4 | `target` | float8 | NULL | |
| | 5 | `tier_id` | int4 | NULL | → list 19 |
| `branch_bonuses` | 1 | `id` | int4 | NN | **PK** |
| | 2 | `created_at` | timestamptz | NN | `now()` |
| | 3 | `percentage_id` | int4 | NULL | → `list_data` |
| | 4 | `branch_manager` | text | NULL | **نص بدل uuid** ⚠️ |
| | 5 | `service_advisor` | text | NULL | **نص بدل uuid** ⚠️ |
| | 6 | `tier_id` | int4 | NULL | **بلا FK** |

---

### 2.9 التسعير والهوامش — Pricing & Margins

#### `cost_categories` — شرائح التكلفة
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `cost_range_id` | int4 | NN | **PK** |
| 2 | `cost_range` | jsonb | NULL | الشريحة كـ JSON (من/إلى) — **ليست أعمدة numeric** |
| 3 | `created_at` | timestamptz | NULL | `now()` |
| 4 | `updated_at` | timestamptz | NULL | `now()` |

#### `profit_categories` — تقاطع (فئة القطعة × صنف الماركة) — 14 صف
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `category_id` | int4 | NN | **PK** |
| 2 | `brand_class` | int4 | NULL | → list 5 |
| 3 | `part_category` | int4 | NULL | → list 6 |
| 4 | `created_at` | timestamptz | NULL | `now()` |
| 5 | `updated_at` | timestamptz | NULL | `now()` |

#### `profit_margins` — النسبة الافتراضية العامة (70 صف = 14 فئة × 5 شرائح)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `margin_id` | int4 | NN | **PK** |
| 2 | `cost_range_id` | int4 | NULL | → `cost_categories` |
| 3 | `percentage` | numeric | NULL | |
| 4 | `created_at` | timestamptz | NULL | `now()` |
| 5 | `updated_at` | timestamptz | NULL | `now()` |
| 6 | `profit_categories_id` | int4 | NULL | → `profit_categories` |

#### `profit_margins_branch` — تجاوز النسبة على مستوى فرع العميل (27 صف)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `branch_id` | int4 | NN | → `client_branches` |
| 3 | `profit_categories_id` | int4 | NN | → `profit_categories` |
| 4 | `cost_range_id` | int4 | NN | → `cost_categories` |
| 5 | `percentage` | numeric | NULL | |
| 6 | `created_at` | timestamptz | NULL | `now()` |
| 7 | `updated_at` | timestamptz | NULL | `now()` |
| 8 | `created_by` | uuid | NULL | |
| 9 | `updated_by` | uuid | NULL | |

> ⚠️ **لا يوجد UNIQUE على `(branch_id, profit_categories_id, cost_range_id)`** — احتمال تعدد صفوف لنفس التقاطع.

#### `profit_margins_audit` (52 صف) و `profit_percentage_update_logs`
| جدول | # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|---|
| `profit_margins_audit` | 1 | `audit_id` | int8 | NN | **PK**، sequence |
| | 2 | `method` | text | NN | CHECK: inline \| bulk |
| | 3 | `user_id` | uuid | NN | |
| | 4 | `branch_id` | int4 | NULL | NULL = النسبة العامة |
| | 5 | `profit_categories_id` | int4 | NN | |
| | 6 | `cost_range_id` | int4 | NN | |
| | 7 | `old_percentage` | numeric | NULL | |
| | 8 | `new_percentage` | numeric | NN | |
| | 9 | `updated_at` | timestamptz | NULL | `now()` |
| `profit_percentage_update_logs` | 1 | `id` | int8 | NN | **PK**، sequence |
| | 2 | `user_id` | uuid | NN | |
| | 3 | `user_name` | text | NULL | **منسوخ (denormalized)** |
| | 4 | `update_method` | text | NN | CHECK: inline \| bulk |
| | 5 | `percentage_values` | jsonb | NN | |
| | 6 | `created_at` | timestamptz | NULL | `timezone('Asia/Riyadh', now())` ⚠️ |
| | 7 | `updated_at` | timestamptz | NULL | `timezone('Asia/Riyadh', now())` ⚠️ |

> ⚠️ **جدولا تدقيق لنفس الحدث** (`profit_margins_audit` + `profit_percentage_update_logs`) — تكرار صريح.
> وأيضاً `created_at` هنا بتوقيت الرياض بينما كل الجداول الأخرى `now()` بـ UTC → **عدم اتساق زمني**.

---

### 2.10 السجلّات والتشغيل — Logs & Ops

#### `status_logs` (~565 صف) — سجل تغيّر الحالة
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `status_log_id` | int4 | NN | **PK** |
| 2 | `quotation_item_id` | int4 | NULL | → `quotation_items` |
| 3 | `confirmed_item_id` | int4 | NULL | → `confirmed_items` |
| 4 | `item_status` | int4 | NULL | → `list_data` (list 3) |
| 5 | `created_at` | timestamptz | NULL | `now()` |
| 6 | `status_changed_by` | uuid | NULL | → `user_data` |
| 7 | `created_by` | uuid | NULL | **مكرَّر مع `status_changed_by`** |
| 8 | `updated_by` | uuid | NULL | **بلا معنى في جدول append-only** |

#### `cost_logs` (~576 صف) — سجل تغيّر تكلفة المورّد
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `cost_id` | int4 | NN | → `quotation_vendor_items.cost_id` (**ليس PK**) |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `cost` | float8 | NULL | |
| 4 | `created_by` | uuid | NULL | → `user_data` |
| 5 | `cost_log_id` | int8 | NN | **PK** |
| 6 | `pricing_source` | text | NULL | CHECK ضد 5 قيم — **نسخة نصية مطابقة لـ list 8** |
| 7 | `updated_by` | uuid | NULL | |

#### `pricing_logs` (~216 صف) — سجل تغيّر سعر البيع
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `quotation_item_id` | int4 | NULL | → `quotation_items` |
| 4 | `price` | float8 | NULL | |
| 5 | `created_by` | uuid | NULL | → `user_data` |
| 6 | `pricing_source` | text | NULL | CHECK ضد نفس الـ 5 قيم |
| 7 | `updated_by` | uuid | NULL | |

#### `notes` — ملاحظات متعدّدة الأشكال (polymorphic)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `note_id` | int4 | NN | **PK** |
| 2 | `note_description` | text | NULL | |
| 3 | `created_at` | timestamptz | NULL | `now()` |
| 4 | `updated_at` | timestamptz | NULL | `now()` |
| 5 | `note_attachment` | text | NULL | |
| 6 | `note_type` | text | NULL | نوع الكيان كنص |
| 7 | `type_id` | int4 | NULL | **مفتاح متعدد الأشكال بلا FK** ⚠️ |
| 8 | `is_internal` | bool | NULL | |
| 9 | `user_id` | uuid | NULL | → `user_data` |
| 10 | `status` | text | NULL | |
| 11 | `is_deleted` | bool | NN | `false` (soft delete) |
| 12 | `deleted_at` | timestamptz | NULL | |
| 13 | `deleted_by` | uuid | NULL | |

#### `files` — مرفقات عامة متعدّدة الأشكال ⚠️ (تكرار ثالث لمفهوم المرفقات)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `module_id` | int8 | NULL | مفتاح polymorphic بلا FK |
| 3 | `created_at` | timestamptz | NN | `now()` |
| 4 | `module_type` | varchar | NULL | |
| 5 | `user_id` | uuid | NULL | |
| 6 | `user_type` | varchar | NULL | |
| 7 | `field_id` | text | NULL | |
| 8 | `file_path` | text | NULL | |

#### `order_number_sequences` (22 صف) — تعريف بادئات أرقام الطلبات
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `sequence_id` | int4 | NN | **PK** |
| 2 | `created_at` | timestamptz | NN | `now()` |
| 3 | `lists_data_id` | int4 | NULL | → `list_data` (العميل) |
| 4 | `region_id` | int4 | NULL | → `list_data` (المنطقة) |
| 5 | `sequence_name` | text | NULL | |
| 6 | `prefix` | text | NULL | البادئة النصية |

> ⚠️ **لا يوجد عمود "آخر رقم مُستخدم"** — الترقيم يُحسب في التطبيق بـ `MAX()+1` (سباق تحت الضغط).
> هذا بالضبط ما تعالجه [المرحلة 1](../phases/phase-1-data-model.md) بـ sequences حقيقية.

#### `rfq_search_index` — فهرس بحث نصّي
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `quotation_item_id` | int8 | NN | **PK** (int8 بينما المصدر int4 ⚠️) |
| 2 | `confirmed_item_id` | int8 | NULL | |
| 3 | `search_vector` | tsvector | NULL | **بلا FK لأي جدول** |

#### `part_number_extraction_logs` (~319 صف)
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `user_id` | uuid | NN | |
| 3 | `quotation_item_id` | int4 | NN | → `quotation_items` |
| 4 | `part_number` | text | NN | |
| 5 | `empty_since` | timestamptz | NULL | متى صار البند بلا رقم قطعة |
| 6 | `empty_until` | timestamptz | NN | `now()` |
| 7 | `created_at` | timestamptz | NN | `now()` |
| 8 | `updated_at` | timestamptz | NN | `now()` |

#### `unrecognized_part_names` — أسماء قطع غير معروفة للمراجعة
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK**، sequence |
| 2 | `entered_text` | text | NN | |
| 3 | `request_id` | text | NULL | |
| 4 | `user_id` | uuid | NULL | |
| 5 | `status` | text | NN | `'pending_review'` — **بلا CHECK** |
| 6 | `review_note` | text | NULL | |
| 7 | `resolved_main_part_code` | text | NULL | |
| 8 | `created_at` | timestamptz | NN | `now()` |
| 9 | `reviewed_at` | timestamptz | NULL | |

#### `webhook_logs`
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `id` | int8 | NN | **PK** |
| 2 | `trigger_type` | text | NN | CHECK: `send_rfq` \| `send_po` |
| 3 | `reference_id` | int4 | NN | polymorphic بلا FK |
| 4 | `request_url` | text | NN | |
| 5 | `request_payload` | jsonb | NN | |
| 6 | `response_status` | int4 | NULL | |
| 7 | `response_body` | text | NULL | |
| 8 | `status` | text | NN | CHECK: `success` \| `failed` |
| 9 | `created_at` | timestamptz | NN | `now()` |

---

### 2.11 نطاق التقارير والصلاحيات — Reports & Permissions

`report_permission_grants`
| # | العمود | النوع | Null | ملاحظة |
|---|---|---|---|---|
| 1 | `grant_id` | int8 | NN | **PK** |
| 2 | `name` | text | NN | |
| 3 | `role` | text | NULL | **نص وليس FK إلى list 16** ⚠️ |
| 4 | `scope` | text | NN | CHECK: `own` \| `team` \| `all` |
| 5 | `created_by` | uuid | NULL | |
| 6 | `updated_by` | uuid | NULL | |
| 7 | `created_at` | timestamptz | NN | `now()` |
| 8 | `updated_at` | timestamptz | NN | `now()` |

`report_permission_grant_users` — PK `(grant_id, user_id)`؛ `grant_id` → `report_permission_grants` (CASCADE).

`report_permission_page_access` — PK `(grant_id, page_key)`
| العمود | النوع | Null | ملاحظة |
|---|---|---|---|
| `grant_id` | int8 | NN | CASCADE |
| `page_key` | text | NN | CHECK: `overview` \| `workshop` \| `purchasing` \| `partfinder` \| `vendors` |
| `can_view` | bool | NN | `false` |
| `can_export` | bool | NN | `false` — CHECK `export_requires_view`: `(NOT can_export) OR can_view` |

`report_permission_section_visibility` — PK `(grant_id, page_key, section_key)`؛ نفس CHECK على `page_key`؛ `is_visible` bool NN `true`.

`report_access_audit_log`
| العمود | النوع | Null | ملاحظة |
|---|---|---|---|
| `audit_id` | int8 | NN | **PK** |
| `user_id` | uuid | NULL | |
| `report_page` | text | NN | **بلا CHECK هنا (بينما `page_key` عليه CHECK)** ⚠️ |
| `action` | text | NN | CHECK: `view` \| `export` |
| `scope_applied` | text | NULL | |
| `created_at` | timestamptz | NN | `now()` |

`report_settings_thresholds` — PK `key` (text)؛ الأعمدة: `label` NN، `value` numeric NN، `value_unit`، `used_in_description`، `min_value`، `max_value`، `updated_by` uuid، `updated_at` NN `now()`.

---

### 2.12 القوائم المرجعية — Lookup Tables

`lists`: `list_id` int4 **PK** · `list_name` text · `created_at` · `updated_at`
`list_data`: `list_data_id` int4 **PK** · `list_id` int4 → `lists` · `list_data` text · `created_at` · `updated_at`

> **هذان الجدولان هما "نظام الأنواع" الفعلي للنظام القديم.** كل شيء — الحالات، الأدوار،
> أسماء العملاء، ماركات السيارات، طرق الدفع — صفوف في `list_data` ومرجعية عبر `int4` FK.

---

## 3. خريطة علاقات الـ FK / FK Relationship Map

**143 علاقة.** المرموز: `→` FK؛ `[CASCADE]` / `[SET NULL]` / `[RESTRICT]` عند اختلافها عن `NO ACTION`.

### 3.1 سلسلة الطلب (النواة)
| المصدر | → | الهدف |
|---|---|---|
| `quotation_items.quotation_id` | → | `quotations.quotation_id` |
| `quotation_items.cost_id` | → | `quotation_vendor_items.cost_id` |
| `quotation_items.customer_id` | → | `client_branches.customer_id` |
| `quotation_items.created_by` | → | `auth.users.id` |
| `quotation_vendors.quotation_id` | → | `quotations.quotation_id` |
| `quotation_vendors.vendor_id` | → | `vendors.vendor_id` |
| `quotation_vendors.vendor_branch_id` | → | `vendor_branches.vendor_branch_id` |
| `quotation_vendor_items.quotation_item_id` | → | `quotation_items.quotation_item_id` |
| `quotation_vendor_items.quotation_vendor_id` | → | `quotation_vendors.quotation_vendor_id` |
| `quotation_vendor_items.vendor_id` | → | `vendors.vendor_id` |
| `quotation_vendor_items.created_by` | → | `auth.users.id` [SET NULL] |
| `quotation_account_managers.quotation_id` | → | `quotations.quotation_id` |
| `quotation_account_managers.assigned_from / assigned_to` | → | `user_data.user_id` |
| `confirmed_orders.quotation_id` | → | `quotations.quotation_id` |
| `confirmed_items.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `confirmed_items.quotation_item_id` | → | `quotation_items.quotation_item_id` (UNIQUE) |
| `confirmed_items.created_by` | → | `auth.users.id` [SET NULL] |

### 3.2 الشراء
| المصدر | → | الهدف |
|---|---|---|
| `purchase_orders.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `purchase_orders.vendor_id` | → | `vendors.vendor_id` |
| `purchase_orders.vendor_branch_id` | → | `vendor_branches.vendor_branch_id` |
| `purchase_orders.uploaded_by` | → | `user_data.user_id` |
| `purchase_items.purchase_order_id` | → | `purchase_orders.purchase_order_id` |
| `purchase_items.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `purchase_items.cost_id` | → | `quotation_vendor_items.cost_id` |
| `purchase_items.created_by` | → | `auth.users.id` [SET NULL] |
| `purchase_invoice_attachments.purchase_order_id` | → | `purchase_orders.purchase_order_id` [SET NULL] |
| `pickups.purchase_order_id` | → | `purchase_orders.purchase_order_id` |
| `pickups.delivery_agent` | → | `user_data.user_id` |
| `pickup_items.pickup_id` | → | `pickups.pickup_id` |
| `pickup_items.purchase_item_id` | → | `purchase_items.purchase_item_id` |
| `pickup_items.created_by` | → | `auth.users.id` [SET NULL] |
| `vendor_creditnotes.purchase_order_id` | → | `purchase_orders.purchase_order_id` |
| `vendor_creditnote_items.vendor_creditnote_id` | → | `vendor_creditnotes.vendor_creditnote_id` |
| `vendor_creditnote_items.purchase_item_id` | → | `purchase_items.purchase_item_id` |
| `vendor_creditnote_items.created_by` | → | `auth.users.id` [SET NULL] |

### 3.3 التسليم / الفوترة / المرتجعات
| المصدر | → | الهدف |
|---|---|---|
| `deliveries.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `deliveries.signature_uuid` | → | `user_data.user_id` |
| `delivery_items.delivery_id` | → | `deliveries.delivery_id` |
| `delivery_items.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `delivery_items.invoice_id` | → | `invoices.invoice_id` |
| `delivery_items.created_by` | → | `auth.users.id` [SET NULL] |
| `delivery_notes.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `invoices.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `invoice_items.invoice_id` | → | `invoices.invoice_id` |
| `invoice_items.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `invoice_items.created_by` | → | `auth.users.id` [SET NULL] |
| `creditnotes.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `creditnote_items.creditnote_id` | → | `creditnotes.creditnote_id` |
| `creditnote_items.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `creditnote_items.created_by` | → | `auth.users.id` [SET NULL] |
| `returns.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` |
| `returns.signature_uuid` | → | `user_data.user_id` |
| `return_items.return_id` | → | `returns.return_id` |
| `return_items.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `return_items.creditnote_id` | → | `creditnotes.creditnote_id` |
| `return_items.created_by` | → | `auth.users.id` [SET NULL] |
| `return_notes.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `return_issues.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `return_issues.main_vendor` | → | `vendors.vendor_id` |
| `return_issues.delivery_agent` | → | `user_data.user_id` |
| `returned_issues.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` [CASCADE] |
| `returned_issues.confirmed_order_id` | → | `confirmed_orders.confirmed_order_id` [CASCADE] |
| `returned_issues.delivery_representative` | → | `user_data.user_id` |
| `returned_issue_attachments.returned_issue_id` | → | `returned_issues.returned_issue_id` [CASCADE] |

### 3.4 الموردون والمستخدمون والتنظيم
| المصدر | → | الهدف |
|---|---|---|
| `vendors.user_id` | → | `user_data.user_id` |
| `vendors.preferred_branch_id` | → | `vendor_branches.vendor_branch_id` [SET NULL] |
| `vendors.vendor_type_id` | → | `list_data.list_data_id` |
| `vendor_branches.vendor_id` | → | `vendors.vendor_id` |
| `vendor_branch_users.user_id` | → | `user_data.user_id` [CASCADE] |
| `vendor_branch_users.vendor_branch_id` | → | `vendor_branches.vendor_branch_id` [CASCADE] |
| `stock_files.vendor_id` | → | `vendors.vendor_id` |
| `user_data.user_branch` | → | `client_branches.customer_id` |
| `user_data.user_company` | → | `list_data.list_data_id` |
| `user_data.user_role` | → | `list_data.list_data_id` |
| `user_data.user_type` | → | `list_data.list_data_id` |
| `user_data.user_vendor` | → | `vendors.vendor_id` |
| `client_branches.list_data_id` / `.region_id` / `.order_category` | → | `list_data.list_data_id` |
| `quotations.service_advisor` / `.account_manager` | → | `user_data.user_id` |
| `notes.user_id` | → | `user_data.user_id` |
| `account_manager_*` (كل أعمدة المديرين والأيام) | → | `user_data.user_id` |
| `account_manager_allocations.customer_id`, `account_manager_branches.customer_id` | → | `client_branches.customer_id` |
| `account_manager_weekly_daysoff.account_manager` | → | `user_data.user_id` [RESTRICT / ON UPDATE CASCADE] |
| `branch_targets.branch_id` | → | `client_branches.customer_id` |

### 3.5 التسعير والسجلّات
| المصدر | → | الهدف |
|---|---|---|
| `profit_categories.brand_class` / `.part_category` | → | `list_data.list_data_id` |
| `profit_margins.cost_range_id` | → | `cost_categories.cost_range_id` |
| `profit_margins.profit_categories_id` | → | `profit_categories.category_id` |
| `profit_margins_branch.branch_id` | → | `client_branches.customer_id` |
| `profit_margins_branch.cost_range_id` | → | `cost_categories.cost_range_id` |
| `profit_margins_branch.profit_categories_id` | → | `profit_categories.category_id` |
| `cost_logs.cost_id` | → | `quotation_vendor_items.cost_id` |
| `cost_logs.created_by` | → | `user_data.user_id` |
| `pricing_logs.quotation_item_id` | → | `quotation_items.quotation_item_id` |
| `pricing_logs.created_by` | → | `user_data.user_id` |
| `status_logs.quotation_item_id` | → | `quotation_items.quotation_item_id` |
| `status_logs.confirmed_item_id` | → | `confirmed_items.confirmed_item_id` |
| `status_logs.status_changed_by` | → | `user_data.user_id` |
| `part_number_extraction_logs.quotation_item_id` | → | `quotation_items.quotation_item_id` |
| `order_number_sequences.lists_data_id` / `.region_id` | → | `list_data.list_data_id` |
| `stock_files.main_brand` / `.brand_class` | → | `list_data.list_data_id` |
| `list_data.list_id` | → | `lists.list_id` |
| `report_permission_*.grant_id` | → | `report_permission_grants.grant_id` [CASCADE] |

### 3.6 كل أعمدة الحالة/النوع → `list_data.list_data_id`
`quotations`(delivery_type, order_type) · `quotation_items`(item_status, brand_class, main_brand, part_category,
alternative_brand_class, cancellation_reason) · `quotation_vendors`(vendor_status) ·
`quotation_vendor_items`(vendor_item_status, available_brand_class) ·
`confirmed_items`(item_status, return_type, client_return_reason, final_brand_class, cancellation_reason) ·
`purchase_orders`(vendor_status) · `purchase_items`(vendor_item_status, payment_account) · `pickups`(pickup_status) ·
`returns`/`returned_issues`(status, return_type, main_supplier, extraction_source, return_reason, delivery_company) ·
`return_issues`(return_reasons, part_number_source, delivery_company) · `creditnote_items`(return_reason) ·
`vendor_creditnote_items`(return_reason) · `status_logs`(item_status) · `stock_files`(main_brand, brand_class) ·
`client_branches`(list_data_id, region_id, order_category) · `user_data`(user_company, user_role, user_type) ·
`vendors`(vendor_type_id) · `profit_categories`(brand_class, part_category) ·
`account_manager_attendance`(record_type) · `branch_bonuses`(percentage_id) · `branch_targets`(tier_id) ·
`order_number_sequences`(lists_data_id, region_id)

---

## 4. قيود CHECK و UNIQUE / Constraints

### 4.1 قيود UNIQUE
| الجدول | القيد |
|---|---|
| `confirmed_items` | `UNIQUE (quotation_item_id)` — **يفرض 1:1 بين بند الـ RFQ والبند المؤكَّد** |
| `quotation_items` | `UNIQUE (line_item_code)` |
| `quotation_vendor_items` | `UNIQUE (quotation_item_id, quotation_vendor_id)` |
| `quotation_vendors` | `UNIQUE (access_token)` |
| `delivery_items` | `UNIQUE (delivery_id, confirmed_item_id)` |
| `vendors` | `UNIQUE (vendor_name)` |
| `user_data` | `UNIQUE (user_id)` (الـ PK هو `email`) |
| `vendor_branch_users` | `UNIQUE (user_id, vendor_branch_id)` |
| `account_manager_weekly_daysoff` | `UNIQUE (account_manager, month)` |

> **غائب بشكل ملحوظ:** لا UNIQUE على `quotations.order_number`، ولا على `invoices.invoice_number`،
> ولا على `creditnotes.creditnote_number`، ولا على `(branch_id, profit_categories_id, cost_range_id)`
> في `profit_margins_branch`.

### 4.2 قيود CHECK
| الجدول | القيد |
|---|---|
| `quotation_items` | `extraction_status IS NULL OR IN ('cannot_extract','unclear')` |
| `cost_logs` / `pricing_logs` | `pricing_source IS NULL OR IN ('Powerbi','SOP','Inventory File','Contact Supplier','On-Site Pricing')` |
| `purchase_orders` / `purchase_invoice_attachments` / `vendor_creditnotes` | `uploaded_source IN ('internal','vendor')` |
| `user_data` | `notification_method IN ('email','whatsapp')` |
| `webhook_logs` | `trigger_type IN ('send_rfq','send_po')` · `status IN ('success','failed')` |
| `profit_margins_audit` | `method IN ('inline','bulk')` |
| `profit_percentage_update_logs` | `update_method IN ('inline','bulk')` |
| `report_permission_grants` | `scope IN ('own','team','all')` |
| `report_permission_page_access` | `page_key IN ('overview','workshop','purchasing','partfinder','vendors')` · `export_requires_view: (NOT can_export) OR can_view` |
| `report_permission_section_visibility` | نفس CHECK على `page_key` |
| `report_access_audit_log` | `action IN ('view','export')` |
| `account_manager_slots` / `_branches` / `_allocations` | `slot_number IN (1,2,3)` |
| `account_manager_attendance` | `slots IS NULL OR slots <@ ARRAY[1,2,3]` |
| `account_manager_weekly_daysoff` | `day_off BETWEEN 0 AND 6` |

---

## 5. مفردات البيزنس الكاملة / Complete Business Vocabulary

> **هذا هو الجزء الأثمن في المستند.** كل قيمة هنا هي مصطلح بيزنس حقيقي مستخدم في النظام.
> `list_data_id` هو المفتاح المستخدم فعلياً في كل الجداول — احتفظ بالمعاني، لا بالأرقام.

### List 1 — `client_name` (العملاء / الشركات) — 13 قيمة
| id | القيمة |
|---|---|
| 1 | شركة حلول صيانة المركبة |
| 176 | Nasmat |
| 177 | Alalamiya |
| 178 | Dream |
| 186 | Limar El-Shams |
| 223 | Turbo Car Care |
| 224 | Dream of Tech |
| 225 | Carshub |
| 226 | PIT STOP |
| 227 | ALKHADR |
| 228 | AlMulhim |
| 229 | External User |
| 230 | Qparts |

> ⚠️ **هذه القائمة هي "الـ tenants" الفعلية في النظام القديم** — مجرد صفوف dropdown.
> في التصميم الجديد تصبح كياناً حقيقياً (`tenants` / `workshops`) — راجع ADR-0008.

### List 2 — `region` (المناطق) — 4 قيم
| id | القيمة |
|---|---|
| 11 | West |
| 12 | East |
| 13 | Riyadh |
| 14 | Central |

### List 3 — `item_status` (حالة البند — أهم قائمة) — 25 قيمة
| id | القيمة | المرحلة |
|---|---|---|
| 15 | New RFQ | RFQ |
| 236 | Extract PN | RFQ |
| 235 | Ready For Quotation | RFQ |
| 16 | Tendering | RFQ |
| 237 | Sent To Vendor | RFQ |
| 267 | Added by Vendor | RFQ |
| 17 | Priced | RFQ |
| 20 | Unavailable | RFQ |
| 19 | Confirmed | Order |
| 21 | Processing | Order |
| 22 | Out for Delivery | Delivery |
| 213 | DN Sign Pending | Delivery |
| 23 | Delivered | Delivery |
| 25 | Pending Invoice | Invoicing |
| 26 | Invoice Issued | Invoicing |
| 27 | Claim Sent | Invoicing |
| 24 | Cancellation Request | Cancel |
| 18 | Canceled | Cancel |
| 268 | Cancelled | Cancel ⚠️ مكرَّرة مع 18 |
| 28 | Return Request | Return |
| 29 | Return | Return |
| 214 | RN Sign Pending | Return |
| 215 | Pending Credit Note | Return |
| 30 | Credit Note Issued | Return |
| 31 | Settled | Final |

### List 4 — `car_brand` (ماركات السيارات) — 96 قيمة
| id | القيمة | id | القيمة | id | القيمة |
|---|---|---|---|---|---|
| 32 | ABARTH | 33 | ACDELCO | 34 | ALFA ROMEO |
| 35 | ASTON MARTIN | 36 | AUDI | 37 | BAIC |
| 38 | BENTLEY | 39 | BESTUNE | 40 | BMW |
| 41 | BUGATTI | 42 | CADILLAC | 43 | CHANGAN |
| 44 | CHERY | 45 | CHEVROLET | 46 | CHRYSLER |
| 47 | CITROEN | 48 | DAIHATSU | 49 | DODGE |
| 50 | Dongfeng | 51 | FERRARI | 52 | FIAT |
| 53 | FORD | 54 | Foton | 55 | GAC |
| 56 | GEELY | 57 | GENESIS | 58 | GMC |
| 59 | GOLF CAR | 60 | HAVAL | 61 | HONDA |
| 62 | HONGQI | 63 | HYUNDAI | 64 | INFINITI |
| 65 | ISUZU | 66 | JAGUAR | 67 | JEEP |
| 68 | JETOUR | 69 | JMC | 70 | KIA |
| 71 | LAMBORGHINI | 72 | LAND CRUISER ⚠️ (موديل لا ماركة) | 73 | LANDROVER |
| 74 | LEXUS | 75 | LINCOLEN *(إملاء)* | 76 | MASERATI |
| 77 | MAXUS | 78 | MCLAREN | 79 | MERCEDES |
| 80 | MG | 81 | MINI COOPER | 82 | MITSUBISHI |
| 83 | Mazda | 84 | Nissan | 85 | PEOGEUT *(إملاء)* |
| 86 | PORSCHE | 87 | RAM | 88 | RANGE ROVER ⚠️ (موديل لا ماركة) |
| 89 | RENAULT | 90 | ROLLS ROYCE | 91 | SAIC Motor |
| 92 | SEAT | 93 | SKODA | 94 | SSANGYONG |
| 95 | SUBARU | 96 | SUZUKI | 97 | Slingshot |
| 98 | TANK, GREAT WALL | 99 | TATA | 100 | TOYOTA |
| 101 | VOLKSWAGEN | 102 | VOLVO | 103 | LUCID |
| 104 | OIL\\ FLUID ⚠️ (ليست ماركة سيارة) | 105 | FAW | 106 | HUMMER |
| 184 | BYD | 247 | Daewoo | 248 | Mercury |
| 249 | Rivian | 250 | Saab | 251 | Saturn |
| 252 | Scion | 253 | smart | 254 | SRT |
| 255 | Tesla | 256 | BYD ⚠️ **مكرَّرة مع 184** | 257 | JAC |
| 258 | Ashok Leyland | 259 | Sinotruk | 260 | Lynk&CO |
| 261 | Truck ⚠️ (فئة لا ماركة) | 262 | MAN | 263 | Scania |
| 264 | Jaecoo | 265 | Exceed | 266 | Changzhou |

### List 5 — `brand_class` (صنف القطعة) — 5 قيم
| id | القيمة |
|---|---|
| 107 | Genuine |
| 108 | OEM |
| 109 | Aftermarket |
| 110 | Used |
| 111 | Any |

### List 6 — `part_category` (فئة القطعة) — 7 قيم
| id | القيمة |
|---|---|
| 112 | Oil |
| 113 | Filter |
| 114 | Others |
| 179 | Body |
| 180 | Mech./Elec. |
| 181 | Tires/Batteries |
| 182 | Accessories |

### List 7 — `purchase_account` (حساب الشراء) — 3 قيم
| id | القيمة |
|---|---|
| 115 | Qparts |
| 116 | Mawred |
| 231 | Tabasheer |

### List 8 — `pricing_source` (مصدر التسعير) — 5 قيم
| id | القيمة |
|---|---|
| 117 | Powerbi |
| 118 | SOP |
| 119 | Inventory File |
| 120 | Contact Supplier |
| 121 | On-Site Pricing |

> ⚠️ نفس القيم مكرَّرة كـ CHECK نصّي في `cost_logs.pricing_source` و`pricing_logs.pricing_source`.

### List 9 — `supplier_payment_method` (طريقة الدفع للمورّد) — 3 قيم
| id | القيمة |
|---|---|
| 122 | Credit |
| 123 | Cash |
| 124 | Transfer |

### List 10 — `delivery_type` (نوع التسليم) — 3 قيم
| id | القيمة |
|---|---|
| 125 | Speed Delivery |
| 126 | Same-Day Delivery |
| 127 | Standard Delivery (1+ Days) |

### List 11 — `delivery_company` (شركة التوصيل) — 5 قيم
| id | القيمة |
|---|---|
| 128 | Mrsool |
| 129 | Mahgoub |
| 130 | Aramex |
| 131 | Ajex |
| 132 | Internal Agent |

### List 12 — `return_type` (نوع الإرجاع) — 3 قيم
| id | القيمة |
|---|---|
| 133 | Exchange |
| 134 | Return to Stock |
| 135 | Return to Supplier |

### List 13 — `return_reasons_internal` (أسباب الإرجاع — تصنيف المسؤولية) — 15 قيمة
| id | القيمة | الجهة المسؤولة |
|---|---|---|
| 136 | Internal – Wrong Part Number | داخلي |
| 137 | Internal – Wrong Pricing | داخلي |
| 138 | Internal – Delay | داخلي |
| 139 | Internal – Shipping Defect | داخلي |
| 140 | Internal – Duplicate Purchase | داخلي |
| 141 | Internal – Wrong Class | داخلي |
| 142 | Vendor – Pricing Issue | المورّد |
| 143 | Vendor – Different Part | المورّد |
| 144 | Vendor – Delay | المورّد |
| 145 | Vendor – Defective Item | المورّد |
| 146 | Vendor – Wrong Class | المورّد |
| 147 | Client – Wrong Order | العميل |
| 148 | Client – Order Cancellation | العميل |
| 149 | Delivery Agent – Shipping Defect | مندوب التوصيل |
| 150 | Delivery Agent – Delay | مندوب التوصيل |

> 💡 **منطق بيزنس مهم:** السبب يحمل **تصنيف المسؤولية** (Internal / Vendor / Client / Delivery Agent)
> مضمَّناً في النص. في التصميم الجديد يجب فصله إلى عمودين: `responsible_party` + `reason`.
> ⚠️ معظم القيم تبدأ بمسافة زائدة في القاعدة.

### List 14 — `final_status` (الحالة النهائية) — 6 قيم ⚠️ يبدو مهجوراً (لا FK يشير إليه)
| id | القيمة |
|---|---|
| 151 | Pending Delivery |
| 152 | Pending Invoice |
| 153 | Rejected |
| 154 | Not Available |
| 155 | Invoice Issued |
| 156 | Settled |

### List 15 — `vendor_status` (حالة المورّد — بالعربية) — 14 قيمة
| id | القيمة | المعنى |
|---|---|---|
| 157 | طلب تسعير | RFQ sent |
| 158 | تم التسعير | Priced |
| 207 | تأكيد سعر سابق | Previous price confirmed |
| 159 | طلب مؤكد | PO confirmed |
| 160 | الغاء | Cancelled |
| 161 | غير متوفر | Unavailable |
| 162 | قيد التجهيز | Processing |
| 163 | جاهز للاستلام | Ready for pickup |
| 164 | تم التسليم | Delivered |
| 165 | تم رفع الفاتورة | Invoice uploaded |
| 166 | طلب ارجاع | Return requested |
| 167 | تم الارجاع | Returned |
| 168 | تم رفع فاتورة المرتجع | Credit note uploaded |
| 169 | تم التسوية | Settled |

> ⚠️ **قائمة الحالات هذه بالعربية بينما `item_status` بالإنجليزية** — لا توجد ترجمة/i18n،
> اللغة مخزَّنة داخل البيانات. التصميم الجديد يحتاج enum + جدول ترجمات.

### List 16 — `user_role` (الأدوار) — 9 قيم
| id | القيمة | الطرف |
|---|---|---|
| 170 | Client Admin | العميل |
| 171 | Service Advisor | العميل |
| 195 | Branch Manager | العميل |
| 172 | Qparts Admin | المشغِّل |
| 173 | Qparts Account Manager | المشغِّل |
| 269 | Purchasing | المشغِّل |
| 270 | Part Number Extractor | المشغِّل |
| 245 | Vendor Admin | المورّد |
| 246 | Vendor | المورّد |

### List 17 — `order_type` (نوع الطلب) — قيمتان
| id | القيمة |
|---|---|
| 174 | Service Order |
| 175 | Stock |

### List 18 — `user_type` (نوع المستخدم) — 3 قيم
| id | القيمة |
|---|---|
| 183 | Clients |
| 185 | Qparts Team |
| 205 | Vendors |

> 💡 هذه الثلاثة هي **الأطراف الثلاثة للمنصّة**: الورشة العميلة / المشغِّل / المورّد.
> تصبح في التصميم الجديد ثلاث بوابات (portals) تحت الـ tenant الواحد.

### List 19 — `branches_bonuses_tiers` (شرائح حوافز الفروع) — 8 قيم
| id | القيمة |
|---|---|
| 187 | 1st tier in mechanical |
| 188 | 2nd tier in mechanical |
| 189 | 3rd tier in mechanical |
| 190 | 4th tier in mechanical |
| 191 | 1st tier in body |
| 192 | 2nd tier in body |
| 193 | 3rd tier in body |
| 194 | 4th tier in body |

### List 20 — `Reason for Cancellation` (أسباب الإلغاء) — 10 قيم
> ⚠️ اسم القائمة نفسه فيه مسافات وحروف كبيرة (غير متسق مع باقي الأسماء snake_case).

| id | القيمة |
|---|---|
| 196 | Wrong part number |
| 197 | Wrong part class |
| 198 | Damaged part |
| 199 | Extra parts |
| 200 | Different price |
| 201 | Late delivery |
| 202 | Part not needed |
| 203 | Customer Canceled service |
| 204 | Customer Self-Purchased Parts |
| 206 | Price Too High |

### List 21 — `order_categories` (تصنيف الطلب) — قيمتان
| id | القيمة |
|---|---|
| 208 | Regular |
| 209 | Bulk |

### List 22 — `attendance_record_type` (نوع سجل الحضور) — 3 قيم
| id | القيمة |
|---|---|
| 210 | Vacation |
| 211 | Excuse |
| 212 | Overtime |

### List 23 — `return_reasons_client_side` (أسباب الإرجاع — من جهة العميل) — 7 قيم
| id | القيمة |
|---|---|
| 216 | Ready For Quotation ⚠️ **قيمة حالة، ليست سبب إرجاع** |
| 217 | Extract PN ⚠️ نفس الملاحظة |
| 218 | Sent To Vendor ⚠️ نفس الملاحظة |
| 219 | Wrong Quantity |
| 220 | Defective Item |
| 221 | Pricing Issue |
| 222 | Delay |

> ⚠️ **بيانات ملوَّثة:** القيم 216–218 هي حالات بند (`item_status`) دخلت بالخطأ في قائمة أسباب الإرجاع.
> يجب عدم ترحيلها.

### List 24 — `part_number_source` (مصدر رقم القطعة) — 3 قيم
| id | القيمة |
|---|---|
| 232 | Client |
| 233 | Vendor |
| 234 | Qparts Member |

### List 25 — *غير موجود* (فجوة في `lists`)

### List 26 — `vendor_type` (نوع المورّد) — 7 قيم
| id | القيمة | المعنى |
|---|---|---|
| 238 | تجزئه | Retail |
| 239 | جملة | Wholesale |
| 240 | مستورد | Importer |
| 241 | وكاله | Agency / Dealer |
| 242 | تشليح | Scrapyard (used parts) |
| 243 | وسيط | Broker |
| 244 | داخلي | Internal |

---

## 6. ملاحظات لإعادة التصميم / Notes for the Redesign

### 6.1 لا وجود لأي مفهوم tenant — الأخطر
- **لا يوجد `tenant_id` / `company_id` / `organization_id` في أي جدول من الـ 68.**
- "الشركة" = `user_data.user_company` → صف في `list_data` (list 1). أي إضافة عميل جديد = إدخال صف dropdown.
- الفصل بين العملاء يعتمد كلياً على منطق التطبيق: `quotation_items.customer_id` (على مستوى **البند**، لا الرأس!).
- **نتيجة خطيرة:** لا يمكن عزل البيانات بـ RLS في النظام القديم.
- ✅ **المعالجة:** ADR-0003 + ADR-0008 — `tenant_id` على كل جدول معاملات + RLS إلزامي.

### 6.2 العميل مربوط بالبند لا بالطلب
`quotations` **لا يحمل `customer_id`** — العميل يوجد فقط على `quotation_items.customer_id`.
نظرياً يمكن أن يحوي طلب واحد بنوداً لعملاء مختلفين. هذا يجعل كل تقارير "الطلبات لكل عميل"
تحتاج join + distinct.
✅ **المعالجة:** `workshop_branch_id` (أو ما يعادله) على مستوى الـ RFQ نفسه، ملزم NOT NULL.

### 6.3 كل الأنواع في جدولَي `lists` / `list_data`
- 25 قائمة، 172 قيمة، كلها `int4` FK إلى نفس الجدول.
- **لا يمنع شيء** وضع `car_brand` في عمود `item_status` — كل الـ FKs تشير إلى `list_data_id` عام.
- خلط اللغات داخل نفس النموذج (item_status إنجليزي، vendor_status عربي، vendor_type عربي).
- تلوّث فعلي موجود: list 23 تحوي 3 قيم حالة.
✅ **المعالجة المقترحة:** PostgreSQL enums أو جداول lookup **مستقلة لكل مفهوم** + جدول ترجمات (ar/en)،
مع الاحتفاظ الكامل بالمفردات في §5.

### 6.4 مفاهيم مكرَّرة (نفس المعنى في مكانين أو أكثر)
| المفهوم | التكرار |
|---|---|
| مشكلة الإرجاع | `return_issues` (قديم) **و** `returned_issues` (جديد) |
| المرفقات | `files` (polymorphic) **و** `quotation_attachments` **و** `purchase_invoice_attachments` **و** `returned_issue_attachments` |
| تدقيق نسب الربح | `profit_margins_audit` **و** `profit_percentage_update_logs` |
| أيام الراحة | `weekly_daysoff` (مصفوفات uuid) **و** `account_manager_weekly_daysoff` |
| فاتورة المورّد | `purchase_orders.vendor_invoice_url/number` **و** `purchase_invoice_attachments` |
| مرتجع المورّد | `purchase_orders.vendor_return_url` **و** `vendor_creditnotes` |
| مرفقات الـ RFQ | `quotation_vendors.attachment_url` (jsonb) **و** `quotation_attachments` |
| `client_po` | `confirmed_orders.client_po` **و** `deliveries.client_po` |
| تصنيف Bulk | `client_branches.is_bulk_client` **و** `client_branches.order_category` (list 21) |
| SLA | `quotation_vendor_items.sla` (text) **و** `.sla_hours` (numeric) |
| نوع المورّد | `vendors.vendor_type` (text) **و** `.vendor_type_id` (FK) |
| مصدر التسعير | list 8 **و** CHECK نصّي في `cost_logs`/`pricing_logs` **و** `quotation_vendor_items.price_source` (text) |
| موقع فرع المورّد | `location_lat`+`location_lng`+`address` **و** `location` (text) |
| المنطقة | `client_branches.region_id` (FK) **و** `.city` (text) · `vendor_branches.region` (jsonb) **و** `.city` (text) |
| منفِّذ تغيير الحالة | `status_logs.status_changed_by` **و** `.created_by` |
| الحالة `Canceled` | list 3 id **18** و id **268** |
| الماركة BYD | list 4 id **184** و id **256** |

### 6.5 أعمدة تبدو legacy / غير مستخدمة
- `user_data.retool_user_name` — إرث من Retool.
- `quotation_items.item_pk` (text) — مفتاح خارجي نصّي قديم.
- `vendors.vendor_type` (text) — استُبدل بـ `vendor_type_id`.
- `list 14 final_status` — **لا يشير إليه أي FK** في المخطط كله.
- `status_logs.updated_by` — جدول append-only، لا معنى للتحديث.
- `cost_logs.updated_by` / `pricing_logs.updated_by` — نفس الملاحظة.
- فجوات ترتيب الأعمدة (أعمدة مُسقَطة تاريخياً): `vendors` (5–9، 12–15، 19–20، 24)،
  `vendor_branches` (18–24)، `quotation_items` (26).
- `commercial_registeration_number` — خطأ إملائي مثبَّت في السكيما.

### 6.6 مشاكل الأنواع
- `delivery_notes` و`return_notes`: **التواريخ والمبالغ مخزَّنة كـ `text`**
  (`confirmation_date`, `delivery_date`, `total_price_before_vat`, `vat`, `total_price_including_vat`).
  → مستحيل الحساب أو الفرز أو التجميع عليها في SQL.
- خلط `float8` / `float4` / `numeric` للمبالغ في نفس النطاق
  (`deliveries.shipping_price` float8 مقابل `returns.shipping_price` float4؛
  `quotation_items.price_before_vat` float8 مقابل `quotation_vendor_items.cost` numeric).
  → **يجب استخدام `numeric` فقط لكل المبالغ.**
- `quotation_items.year` نصّي.
- `cost_categories.cost_range` كـ jsonb بدل عمودَي `from`/`to` numeric → لا يمكن فهرسته أو التحقق من التداخل.
- عدم اتساق أحجام المفاتيح: `client_branches.customer_id` int4 بينما
  `account_manager_branches.customer_id` int8؛ `quotation_items.quotation_item_id` int4 بينما
  `rfq_search_index.quotation_item_id` int8؛ `purchase_orders.payment_account` int8 يشير إلى `list_data_id` int4.
- `status`/`role` كنصوص حرة بلا CHECK في: `delivery_notes.status`، `return_notes.status`،
  `notes.status`، `unrecognized_part_names.status`، `report_permission_grants.role`،
  `report_access_audit_log.report_page`، `invoices.zoho_status`، `quotations.shipping_type`.

### 6.7 مستندات مسطَّحة (denormalized documents)
`delivery_notes` و`return_notes` صفوف مسطَّحة بـ **PK = `confirmed_item_id`**، تنسخ اسم العميل والفرع
والماركة ورقم الطلب من مصادرها. يعني:
- صف واحد فقط لكل بند — **لا يدعم تسليماً جزئياً على دفعتين** بشكل صحيح.
- البيانات المنسوخة تتقادم عند تعديل المصدر.
✅ **المعالجة:** توليد المستند (PDF/JSON snapshot) وقت الإصدار وتخزينه كوثيقة غير قابلة للتغيير،
مع الاحتفاظ بالعلاقات المعيارية في الجداول.

### 6.8 الترقيم والتسلسل
`order_number_sequences` يعرّف البادئة + العميل + المنطقة فقط، **بلا عمود counter**.
الرقم التالي يُحسب في التطبيق (`MAX()+1`) → تكرار محتمل تحت التزامن.
✅ **المعالجة:** sequence حقيقي في Postgres لكل (tenant, نطاق) — راجع `CONVENTIONS §DB`.

### 6.9 الأمان
- `quotation_vendors.access_token` uuid **مخزَّن نصاً واضحاً** (UNIQUE، صلاحية 7 أيام) —
  توكن وصول لبوابة المورّد بدون تسجيل دخول، بلا hashing.
- `email_otps.code_hash` مُهاشَة ✅ (النمط الصحيح — طبّقه على التوكنات أيضاً).
- التوقيعات مخزَّنة في عمود `text` (`deliveries.signature`, `returns.signature`,
  `delivery_notes.signature`) — على الأرجح base64 داخل الصف.
✅ **المعالجة:** hash للتوكنات + صلاحية + RLS، والتوقيعات في تخزين ملفات مع مرجع.

### 6.10 التوقيت
كل الجداول `now()` (UTC) **ما عدا** `profit_percentage_update_logs` التي تستخدم
`timezone('Asia/Riyadh', now())` → مقارنات زمنية خاطئة عبر الجداول.
✅ **المعالجة:** `timestamptz` بـ UTC في كل مكان، والتحويل في طبقة العرض.

### 6.11 نطاقات تبدو خارج النواة (قرِّر: نقل أم إسقاط)
- **تخصيص مديري الحسابات** (5 جداول + `weekly_daysoff`): جدولة موارد بشرية كاملة
  (سلوتات، بدلاء، إجازات، أيام راحة، تخصيص محسوب). منطق ثقيل — قرّر إن كان جزءاً من المنتج.
- **حوافز وأهداف الفروع** (`branch_targets`, `branch_bonuses`): وحدة مبيعات/HR مصغّرة،
  وفيها `branch_manager`/`service_advisor` كنصوص لا uuid.
- **صلاحيات التقارير** (5 جداول `report_permission_*` + `report_settings_thresholds`):
  نظام صلاحيات مستقل موازٍ لـ `user_role` — **مصدرا حقيقة للصلاحيات**.
  ✅ في التصميم الجديد: نظام صلاحيات واحد (RBAC/ABAC) يغطي الاثنين.
- `rfq_search_index`: جدول فهرس بلا FK؛ يُعاد بناؤه على كل كتابة (مشكلة أداء مذكورة في المرحلة 1).

### 6.12 مؤشرات حجم البيانات (تقديرية من `pg_class.reltuples`)
| الجدول | تقدير الصفوف |
|---|---|
| `quotation_vendor_items` | ~1,022 |
| `cost_logs` | ~576 |
| `status_logs` | ~565 |
| `quotation_items` | ~424 |
| `part_number_extraction_logs` | ~319 |
| `pricing_logs` | ~216 |
| `list_data` | 172 |
| `quotation_vendors` | ~165 |
| `profit_margins` | 70 |
| `vendors` / `vendor_branches` | ~56 لكل منهما |
| `user_data` | ~43 |
| `quotations` | ~27 |
| `confirmed_items` | ~16 |

> ⚠️ هذه تقديرات إحصائية من الـ planner، وكثير من الجداول أعادت `-1` (لم تُحلَّل بعد `ANALYZE`).
> الأحجام المنخفضة تعني أن هذه النسخة قد لا تحمل كامل تاريخ الإنتاج.
> **المستند مرجع سكيما ومفردات — لا يعتمد على أحجام البيانات.**

---

## 7. الخلاصة العملية / Actionable Summary

**ما يجب الحفاظ عليه من النظام القديم:**
1. **سلسلة الطلب** (§1) — RFQ → تسعيرات موردين → تأكيد → شراء → استلام → تسليم → فوترة → إرجاع → إشعار خصم.
2. **`confirmed_item` كمحور للتنفيذ** — كل مستند تنفيذي يشير إليه.
3. **`cost_id` = التسعيرة الفائزة** — الربط بين البند وسعر المورّد المختار.
4. **كل مفردات §5** — الحالات، الأدوار، أنواع المورّدين، أسباب الإرجاع/الإلغاء، شرائح الحوافز.
5. **تصنيف مسؤولية الإرجاع** (Internal / Vendor / Client / Delivery Agent) — لكن كعمود مستقل.
6. **نموذج هوامش الربح**: (فئة قطعة × صنف ماركة) × شريحة تكلفة → نسبة، مع تجاوز على مستوى الفرع.
7. **الأطراف الثلاثة**: عميل (ورشة) / مشغِّل / مورّد — وبوابة لكل منها.

**ما يجب عدم نقله:**
`lists`/`list_data` كنظام أنواع · غياب الـ tenant · العميل على مستوى البند · المستندات المسطَّحة
(`delivery_notes`/`return_notes`) · التكرارات في §6.4 · الأنواع النصية للأرقام والتواريخ ·
`MAX()+1` للترقيم · التوكنات بلا hashing · القيم الملوَّثة في list 23 · التكرارات في list 3 و list 4.
