# QVM Platform — Architecture Reference

> النسخة الجديدة المعاد تأسيسها من مشروع Qparts/QVM. مبنية من الصفر بشكل نظيف، معزولة تماماً عن
> المشروع الحقيقي. هذا الملف هو **المرجع الوحيد** لكل قرار معماري — يُحدَّث مع تطوّر المشروع.

---

## 1. لماذا نسخة جديدة؟ (ملخص القرار)

النظام القديم (`AhmedSHG97/qvm-new-production` + Supabase) **يعمل وظيفياً** لكنه:

- **الأمان مكسور من الجذر**: RLS مقفول على 56+ جدول، توكن موردين مكشوف للعامة، 156 دالة SECURITY DEFINER مفتوحة للمجهولين.
- **single-tenant متنكّر**: لا يوجد كيان "شركة/tenant"، الشركة مجرد صف في قائمة، والعزل بين العملاء منطق تطبيق لا ضمان قاعدة بيانات.
- **تكرار ضخم**: 3 أجيال داشبورد RFQ (~6800 سطر ميت مشحون)، 41 دالة مكررة بين `public` و`qvm_new_apps`، god-modules.
- **بيئات متبهدلة**: 3 قواعد Supabase كلها `MIGRATIONS_FAILED`، dev فاضية، `.env` يشير للقاعدة الغلط.
- **scale غير مختبَر**: أكبر جدول ~1000 صف، قنابل موقوتة (توليد أرقام طلبات بـ max()+1 مع FOR UPDATE، فهرس بحث يُعاد بناؤه على كل كتابة، 123 FK بدون index).

النسخة الجديدة تحتفظ بالأصل القيّم (**نموذج البيانات + منطق البيزنس + مكوّنات الواجهة**) وتعيد بناء الطبقة المكسورة (الأمان، الـ tenancy، التنظيم، البيئات) بشكل صحيح.

---

## 2. الـ Stack

| الطبقة | الاختيار | السبب |
|---|---|---|
| قاعدة البيانات | **PostgreSQL 16** (self-hosted، كونتينر معزول) | تحكّم كامل + الداتا على سيرفرنا + ترحيل سهل من Postgres الحالي (`pg_dump`) + قوة jsonb/arrays/full-text |
| الباك إند | **NestJS** (TypeScript) | معمارية مفروضة (modules/services/controllers) تمنع التكرار وال god-files |
| ORM + الميجريشنز | **Drizzle** | أنواع مولّدة من السكيما (يقتل مشكلة الـ `any`) + مصدر واحد للميجريشنز |
| المصادقة | self-hosted (JWT + argon2 داخل NestJS، أو Better Auth) | نظام الدخول والأدوار كودنا، متحكّمون فيه بالكامل |
| تخزين الملفات | **MinIO** (S3-compatible على سيرفرنا) | الملفات على سيرفرنا بواجهة S3 معيارية |
| الفرونت إند | **React + Vite** (نعيد استخدام مكوّنات الـ UI الحالية) | نحافظ على شغل الواجهة، نبنيه نظيف فوق الـ API الجديد |
| الريبو | **Monorepo** (pnpm workspaces) | مشاركة الأنواع + تزامن + نسخة واحدة |

**لماذا ليس MySQL:** النظام يعتمد على `jsonb` (كل الـ RPCs)، `to_tsvector`/`pg_trgm` (البحث)، arrays (`int[]`/`uuid[]`)، `FOR UPDATE`. MySQL أضعف/يفتقد هذه، والانتقال = إعادة كتابة كاملة في محرك أضعف + خسارة العزل عبر RLS.

**لماذا ليس Supabase self-hosted:** المطلوب تحكّم وبساطة؛ تشغيل حزمة Supabase كاملة (gotrue/postgrest/kong/storage/realtime) أثقل تشغيلاً، لا أخفّ.

---

## 3. Multi-tenancy (القلب)

**النموذج: Shared schema + `tenant_id` على كل جدول + RLS + subdomain routing.**
(ليس database-per-tenant ولا schema-per-tenant — هذان كابوس تشغيلي.)

**الـ tenant = workspace كامل** (مؤسسة وسيطة مثل Qparts) وتحته عالمه المعزول بالكامل:

```
tenant (workspace)  ← ساب-دومين + هوية + إعدادات + باقة
├── workshops (الورش العميلة) + فروعها
├── vendors (الموردون المرتبطون بهذا الـ workspace)
├── users (موظفو المشغّل + مستخدمو الورش + مستخدمو الموردين)
├── RFQs → quotations → orders → deliveries → returns → invoices
└── portals: بوابة الورشة + بوابة المورد + لوحة المشغّل
```

- كيان **`tenants`** حقيقي: id, name, slug/subdomain, logo, settings, plan, is_sandbox, created_at…
- **كل جدول أساسي يحمل `tenant_id`** (FK → tenants) مع composite index على `(tenant_id, …)`.
- **الموردون استثناء مقصود (ADR-0008)**: `vendors` كيان **عالمي بلا `tenant_id`**، ويُربط بالـ workspaces
  عبر جدول ربط **`tenant_vendors`** (هو الذي يحمل الـ `tenant_id` والـ RLS وإعدادات العلاقة).
  اليوم: كل workspace يرى مورديه فقط. مستقبلاً: نفس المورد يُربط بأكثر من workspace **بلا أي تغيير سكيما**.
  بيانات المعاملات (عروض/أوامر شراء/فواتير) تحمل `tenant_id` دائماً — تاريخ كل workspace معزول حتى مع مورد مشترك.
- **RLS من أول ميجريشن**: كل جدول له policy `tenant_id = current_tenant()` — العزل مضمون على مستوى قاعدة البيانات، لا يعتمد على التطبيق.
- **`current_tenant()`**: يُشتق من الـ JWT claim / session، يُضبط عبر `SET LOCAL app.tenant_id` في بداية كل request.
- **Subdomain routing**: `company-a.qvm.app` → middleware يحلّ الـ slug إلى `tenant_id` → يُضبط في السياق → كل الاستعلامات مفلترة تلقائياً.
- **موظفو Qparts الداخليون** (staff/super-admin): دور خاص يتخطّى فلتر الـ tenant (يرى كل الشركات) عبر policy إضافية `is_internal_staff()`.

## 4. الأدوار والصلاحيات

- أدوار على مستويين: **مستوى المنصّة** (super-admin, Qparts staff) و**مستوى الشركة** (company admin, service advisor, branch manager, …) و**الموردون** (vendor).
- التفويض في طبقة التطبيق (guards) **+** RLS في قاعدة البيانات (دفاع في العمق).
- لا دوال SECURITY DEFINER مفتوحة للعامة؛ كل endpoint محميّ بـ guard صريح.

## 5. الـ Sandbox / بيئة التيست للإدارة

**Sandbox = tenant متعلّم عليه `is_sandbox = true`** — نفس الكود والسلوك بالضبط، معزول بالـ RLS.

- **seed**: سكربت يزرع شركات/طلبات/موردين وهميين واقعيين.
- **reset**: مسح آمن (`DELETE WHERE tenant_id = <sandbox>`) + إعادة seed بضغطة.
- **⚠️ عزل الآثار الجانبية (القاعدة #1)**: طبقة موحّدة لكل side-effect (إيميل/واتساب/دفع/webhooks/sheets) تتحقق من `tenant.is_sandbox` وتتوقف/تحوّل لوجهة تجريبية. **لا فلوس ولا رسائل حقيقية من الـ sandbox أبداً.**
- يمكن وجود أكثر من sandbox (لكل مدير/سيناريو).

## 6. البيئات (بديل فوضى القديم)

`Local (جهاز المطوّر)` → `Staging (سيرفر/DB منفصل)` → `Production`

- الميجريشنز تمشي في **اتجاه واحد** فقط، مصدر واحد في الريبو (`apps/api/drizzle/`).
- الـ **Staging** لاختبار الكود والميجريشنز قبل الإنتاج (منفصل تماماً عن sandbox-tenant الذي هو ميزة منتج داخل الإنتاج).

## 7. قابلية التوسّع (إصلاح قنابل القديم)

- **أرقام الطلبات**: `sequence` حقيقي لكل (tenant, region) بدل `MAX()+1 FOR UPDATE`.
- **فهرس البحث**: incremental/debounced أو `tsvector` عمود مُولّد (generated column) بدل trigger يعيد البناء على كل كتابة.
- **كل الـ FKs مفهرسة** + composite indexes على `(tenant_id, …)`.
- **Pagination على السيرفر** افتراضياً في كل قائمة، لا "عدّل صف → اسحب الجدول".
- **connection pooling** صحيح (pgbouncer / نسبة اتصالات).
- اختبار تحميل فعلي قبل الإطلاق.

---

## 8. بنية الـ Monorepo

```
qvm-platform/
├── apps/
│   ├── api/          # NestJS — الباك إند (modules per domain, drizzle schema + migrations)
│   └── web/          # React + Vite — الواجهة (مكوّنات UI معاد استخدامها، تتكلم API الجديد)
├── packages/
│   └── shared/       # أنواع + ثوابت مشتركة بين api و web (DTOs, enums, roles)
├── infra/            # docker-compose (postgres + minio), سكربتات نشر
├── docs/             # ARCHITECTURE.md (هذا الملف) + قرارات لاحقة
└── (workspace config)
```

**موديولات الباك إند (domain-driven، موديول لكل مجال — لا god-modules):**
`auth` · `tenants` · `users` · `rfq` · `quotations` · `pricing` · `vendors` · `orders` ·
`deliveries` · `returns` · `invoices` · `reports` · `admin` (super-admin) · `sandbox` · `files` · `notifications`

## 9. خطة الترحيل (المرحلة 6)

1. نطوّر ونختبر على **seed وهمي** طوال المراحل 1–5.
2. عند الترحيل: `pg_dump` من Postgres القديم → تحويل السكيما للنموذج الجديد (إضافة `tenant_id`, توحيد `public`/`qvm_new_apps`) → **تمويه (anonymize)** البيانات الحساسة → استيراد إلى staging → تحقق → إنتاج.
3. **الداتا الحقيقية ملك العميل** — النقل الفعلي يتم بإذنه فقط.

## 10. خارطة الطريق (7 مراحل)

- **0** التأسيس والعزل (monorepo, docker, بيئات, ميجريشنز) — ✅ مكتملة
- **1** نموذج البيانات + الـ tenancy + RLS + seed ← *نحن هنا*
- **2** الباك إند NestJS (auth, موديولات المجالات, طبقة الآثار الجانبية)
- **3** الفرونت إند (إعادة استخدام + تنظيف + code-splitting + subdomain routing)
- **4** فيتشرز الـ workspace + الـ sandbox
- **5** داشبورد الإدارة + السوبر أدمن
- **6** الترحيل + التصليب + اختبار scale + الإطلاق

---

## قواعد ثابتة (لا يُكسر أيّ منها)

0. **مصدر واحد — صفر ازدواج** — قاعدة بيانات واحدة، ريبو واحد، تطبيق واحد لكل طبقة، لا نسخ ولا تكرار (CONVENTIONS §المبدأ أ).
0.5 **يشتغل فعلاً لا نظرياً** — لا شيء "خلص" بدون تشغيل وتحقق حقيقي؛ الإطلاق مشروط باعتمادية end-to-end مُثبَتة (CONVENTIONS §المبدأ ب).
1. **صفر لمس للمشروع الحقيقي** — هذا الريبو معزول تماماً، ريموت خاص، سيرفر/DB خاص.
2. **RLS + tenant_id من أول ميجريشن** — لا جدول أساسي بدونهما.
3. **صفر تكرار** — أي منطق مشترك في مكان واحد؛ لا نسخ v2/v3، لا god-files.
4. **أنواع مولّدة من السكيما** — لا `any` على حدود البيانات.
5. **عزل الآثار الجانبية في الـ sandbox** — لا رسائل/مدفوعات حقيقية من بيئة التيست.
6. **الميجريشنز في اتجاه واحد** — مصدر واحد، local → staging → prod.
