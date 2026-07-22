# المرحلة 1 — نموذج البيانات والـ Tenancy

**الحالة:** 🚧 جارية — بدأت 2026-07-22
**الهدف:** سكيما نظيفة متعددة المستأجرين، بـ RLS وفهارس وsequences صحيحة من أول ميجريشن،
مع seed وهمي واقعي يشمل sandbox tenant.

## المخرجات المستهدفة
- [x] `docs/reference/old-system-schema.md` — مرجع السكيما القديمة (قراءة فقط، لا نسخ) ✅
- [x] تصميم السكيما الجديدة — `docs/design/new-schema-design.md` (بانتظار مراجعة كريم) ✅
- [ ] `apps/api/src/db/schema/*.ts` — تعريفات Drizzle
- [ ] الميجريشن الأولى: الجداول + RLS + الفهارس + الـ sequences
- [ ] `apps/api/drizzle/seed/` — بيانات وهمية + sandbox tenant

## القرارات الحاكمة لهذه المرحلة
- **ADR-0003** — shared schema + `tenant_id` + RLS + subdomains.
- **ADR-0008** — الـ tenant = workspace كامل؛ **الموردون كيان عالمي** مربوط عبر `tenant_vendors`.
- **ADR-0007** — التطوير على seed وهمي؛ الداتا الحقيقية تُنقل مموَّهة في المرحلة 6.
- **CONVENTIONS §DB** — `tenant_id` + composite index على كل جدول، RLS إلزامي، index لكل FK،
  ممنوع `MAX()+1`، schema واحد، ممنوع ازدواج.

## سجل التنفيذ

### 2026-07-22 — بدء المرحلة
1. **ADR-0008 كُتب**: نموذج الـ tenant الكامل + تصميم الموردين القابل للمشاركة مستقبلاً
   (كيان عالمي `vendors` + جدول ربط `tenant_vendors` يحمل الـ `tenant_id` والـ RLS).
   السبب: متطلب صريح — "ممكن مستقبلاً الموردين يبقوا مشتركين مع أكتر من مكان".
2. **استخراج مرجع السكيما القديمة** (قراءة فقط من قاعدة الإنتاج القديمة) —
   الهدف: عدم فقدان أي منطق بيزنس (سلسلة الطلب، الحالات، مفردات القوائم).
   ⚠️ مرجع للتصميم فقط — السكيما الجديدة **ليست نسخة** من القديمة.

### 2026-07-22 — القرارات النهائية + الشريحة الأولى من السكيما (Phase 1a)
**قرارات كريم:** الحالات = **نفس مفردات القديم** (محفوظة بالكامل) · المفتاح uuid · profit_categories tenant-scoped
· regions/cities جداول مرجعية · الباقي "اعمل الصح".

**اتنفّذ (Phase 1a — الأساس):**
- أدوات `apps/api`: package.json (drizzle-orm/drizzle-kit/postgres/tsx)، tsconfig، drizzle.config.ts.
- `drizzle/schema/`: `_shared` (helpers: pk/audit/money/pct)، `enums` (10 enums)، `reference`
  (13 جدول مرجعي)، `tenancy` (plans/tenants + is_sandbox)، `identity` (users عالمي + tenant_memberships)،
  `org` (workshops/workshop_branches — العميل صعد للرأس).
- `drizzle/seed/reference-data.ts`: **مفردات الحالات كاملة زي القديم** (item_status 24 قيمة، vendor_status 14)
  مع `legacyId` للترحيل؛ دمج `Canceled/Cancelled` في `cancelled` واحد يحمل الـ id القديمين [18,268].
- **ميجريشن مولّدة ومتحقَّق منها:** `0000_foundation.sql` — 18 جدول، 10 enums، unique indexes صحيحة، typecheck نضيف.

**متبقّي (Phase 1b — الشريحة التالية):** vendors (عالمي + tenant_vendors)، سلسلة الطلب
(rfq→orders→purchasing→fulfillment→billing)، pricing، crosscutting (attachments/status_logs/notes/sequences)،
ثم **RLS policies + الفهارس على كل FK + sequences** في SQL يدوي مُلحق، ثم seed كامل + sandbox tenant.

### 2026-07-22 — سلسلة الطلب الكاملة (Phase 1b)
**اتنفّذ:**
- `vendors` (عالمي) + `vendor_branches` + `vendor_users` + **`tenant_vendors`** (الربط، يحمل tenant_id).
- سلسلة الطلب: `rfq` (rfqs/rfq_items/rfq_vendors/rfq_vendor_items) · `orders` (orders/order_items — المحور) ·
  `purchasing` (purchase_orders/items + pickups) · `fulfillment` (deliveries/items + returns/items + return_issues + signatures) ·
  `billing` (invoices/items + credit_notes/items).
- `pricing` (cost_logs/pricing_logs append-only + profit_categories/margins/branch/audit + stock_files).
- `crosscutting`: `attachments` (موحّد) · `status_logs` (append-only) · `notes` · `order_number_counters`.
- أُغلقت الـ 4 علاقات المؤجلة (winning_vendor_quote_item_id, workshop_branch_id, invoice_id, credit_note_id).

**التحقق الفعلي (لا مجرد كود):**
- `tsc --noEmit` نضيف · `drizzle-kit generate` → `0000_full_schema.sql`.
- طُبِّقت على **Postgres 16 حقيقي** (docker) على قاعدة جديدة: **53 جدول · 137 FK · 185 index · 9 enums**.

**ملاحظات تشغيل:**
- بورت Postgres المحلي = **5434** (5432/5433 مشغولان بـ ghini/ingeneral) عبر `POSTGRES_PORT` في `.env`.
- تحذير تجميلي: أسماء بعض قيود الـ FK تتجاوز 63 حرفاً فيقصّرها Postgres — لا تعارض حدث (137 FK)؛ تُهذَّب لاحقاً.
- الميجريشن الأولى تبقى قابلة لإعادة التوليد **حتى أول إصدار/staging**، بعدها تصبح ثابتة (اتجاه واحد).

**متبقّي (Phase 1c):** RLS policies على كل جدول tenant-scoped + trigger التدقيق (created_by/updated_by) +
دالة توليد رقم الطلب الذرّية + seed كامل (شركات/موردين/طلبات وهمية) + **sandbox tenant**.

### 2026-07-22 — RLS + الدوال + seed (Phase 1c) ✅ المرحلة 1 مكتملة
**اتنفّذ (ميجريشنز 0002 + 0003، hand-authored):**
- **دوال الجلسة:** `current_tenant_id()`, `app_user_id()`, `app_is_internal()` (كلها `search_path=''`).
- **RLS:** enable+**force**+policy عزل على كل الجداول tenant-scoped (loop على أعمدة tenant_id)؛
  الجداول العالمية: قراءة للجميع + كتابة للـ internal فقط. **71 policy على 53 جدول.**
- **trigger التدقيق:** `set_row_audit` (كامل) + `set_created_by` (append-only) — **37 trigger**؛
  created_by/updated_by من الجلسة لا من جسم الطلب.
- **دالة رقم الطلب الذرّية:** `next_order_number(tenant,prefix,region)` — upsert على عدّاد
  `(tenant_id, prefix)` بدل `MAX()+1`.
- **دور التشغيل `qvm_app`** (غير superuser) — التطبيق يتّصل به؛ الـ owner للميجريشن/الـ seed فقط.
- **seed:** مفردات الحالات كاملة (24+14) + brand_classes/brands/regions/cities + خطة + مستخدم أدمن +
  **مستأجرين (منهم sandbox)** + ورشة/فرع + مورّد عالمي مربوط + سلسلة RFQ كاملة (`RYD-1` من الدالة).

**التحقق الفعلي على Postgres (كدور qvm_app الخاضع للـ RLS):**
- داخلي يرى الكل · مستأجر t1 يرى صفّه فقط · **مستأجر آخر = صفر** · بلا سياق = صفر ·
  **كتابة عابرة للمستأجرين مرفوضة بـ RLS policy** · created_by/updated_by مضبوطان تلقائياً ·
  `next_order_number` متسلسل ذرّي (TST-1/2/3).

> **درس حرج التقطه الاختبار:** الـ superuser/owner يتخطّى الـ RLS حتى مع FORCE — لذلك التطبيق
> **يجب** أن يتصل بدور `qvm_app` غير الـ superuser. أُضيف كقاعدة ملزمة في CONVENTIONS §DB-2.

### 2026-07-22 — إصلاحات المراجعة النقدية (Phase 1d) ✅
مراجعة نقدية (وكيل مستقل) قارنت السكيما بالنظام القديم. المعالَجات:
- **C1** أُضيف `vendor_credit_notes` + `vendor_credit_note_items` (حلقة مرتجع الشراء كانت مفقودة).
- **C2** `cost_ranges` بحدود رقمية (`lower_bound/upper_bound`) — محرك الهوامش يقدر يشتغل الآن.
- **S1** فهرس على `rfq_items.winning_vendor_quote_item_id`.
- **S2** `status_logs` بـ `status_domain` (item/vendor) — يسجّل تحوّلات حالة المورّد صح.
- **S4** `return_reasons` بعمود `side` (client/internal) — يستوعب قائمتَي القديم (13+23).
- **S5** `tenant_vendors.status` → enum؛ `return_issues.issue_type` → enum (بدل نص حر).
- **S7** أعمدة الشحن (`shipping_price/shipping_cost/delivery_company`) على deliveries + rfqs.
- **N1** إزالة `any` من forward ref (استخدام `AnyPgColumn`).
- **N2 + FK-sweep** فهارس على كل FK متبقّي — **صفر FK بدون index** (مُتحقَّق).
- **N5** أُضيف `car_year`, `alternative_part_number` على rfq_items؛ `received_qty` على delivery_items.
- **S3** جدولة مديري الحسابات/الحوافز **مؤجَّلة رسمياً** (ADR-0009)؛ حُذف `bonus_tiers` اليتيم.
- صُحِّح ادعاء خاطئ في وثيقة التصميم (كانت تقول credit_notes تغطّي مرتجع المورّد).
> ملاحظتا الوكيل S6 (RLS غايب) و N3 (العدّاد) كانتا على لقطة أقدم — الاتنين مطبَّقان ومُتحقَّقان فعلاً.

**التحقق النهائي على Postgres (قاعدة جديدة + seed + دور qvm_app):**
`54 جدول · 142 FK · 209 index · 71 policy · 39 trigger` · **صفر FK بدون index** ·
عزل RLS مؤكَّد (t1=صفّه، آخر=صفر) · `next_order_number`=RYD-1 · cost_ranges بحدود · return_reasons بجانبين.

### 2026-07-22 — نموذج الهوية + التبديل بين الـ workspaces (Phase 2b) ✅
قرار صاحب المشروع: **قاعدة واحدة multi-tenant بطريقتنا** — أُلغيت فكرة القاعدة-المنفصلة-لكل-شركة
(QNEW-56) نهائياً (ADR-0010). كشف متطلب "تبديل الـ workspace" ثغرة: "الداخلي" كان يُشتق من عضوية
tenant واحد، فموظف Qparts لم يكن يرى كل الـ workspaces. المعالجة:
- **جدول `platform_members`** (global): موظفو Qparts، دور على مستوى المنصّة → يرون كل الـ workspaces.
  enum `platform_role` (+ finance_manager/pricing_supervisor لمعالجة تعارض الأدوار QNEW-48-A).
- **`AuthGuard` أعيد تصميمه:** is_internal من platform_members؛ الوصول = platform staff أو عضو الـ
  workspace، وإلا **403**.
- **`GET /api/workspaces`** — يرجّع كل الـ workspaces التي يصلها المستخدم من الطبقات الثلاث
  (platform / membership / vendor) — أساس السويتشر في الواجهة.
- **seed** موسّع: workspaceان حقيقيان (riyadh, jeddah) + sandbox؛ admin=platform staff؛
  advisor=عضو t1؛ **multi=عضو t1+t2** (لاختبار التبديل).
- ميجريشنز 0003 (الجدول) + 0004 (RLS/trigger للجدول الجديد).

**مُتحقَّق عبر HTTP:** admin يرى 3 workspaces؛ advisor يرى riyadh فقط؛ **multi يرى riyadh+jeddah
بأدوار مختلفة ويبدّل بينهما فعلياً**؛ غير العضو = 403؛ platform staff يصل الكل بـ isInternal=true.

## المشاكل القديمة التي تُعالَج هنا صراحةً
| مشكلة النظام القديم | المعالجة في التصميم الجديد |
|---|---|
| لا يوجد مفهوم tenant إطلاقاً ("الشركة" صف في dropdown) | كيان `tenants` + `tenant_id` على كل جدول |
| RLS مقفول على 56+ جدول | RLS مع policy العزل من أول ميجريشن لكل جدول |
| 123 FK بلا index | index لكل FK + composite `(tenant_id, …)` |
| أرقام الطلبات بـ `MAX()+1` (خنق تحت الضغط + تكرار) | PostgreSQL sequence حقيقي لكل (tenant, نطاق) |
| فهرس البحث يُعاد بناؤه على كل كتابة | فهرس/تحديث تزايدي مصمّم من البداية |
| ازدواج `public` × `qvm_new_apps` (41 دالة مكررة) | schema واحد، مصدر واحد للحقيقة |
| `access_token` مكشوف بلا RLS | التوكنات مجزّأة/مُهاشة + RLS + صلاحية زمنية |
