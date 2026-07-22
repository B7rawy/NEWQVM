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
