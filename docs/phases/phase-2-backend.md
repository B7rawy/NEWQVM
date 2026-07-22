# المرحلة 2 — الباك إند (NestJS + Drizzle)

**الحالة:** 🚧 جارية — بدأت 2026-07-22
**الهدف:** باك إند domain-driven فوق سكيما المرحلة 1، RLS-scoped لكل request، أمان صحيح، بلا تكرار.

## المبادئ المطبَّقة
- التطبيق يتصل بدور `qvm_app` (غير superuser)؛ كل query داخل `DbService.withContext` الذي يفتح
  transaction ويضبط `SET LOCAL app.tenant_id/user_id/is_internal` → **RLS يعزل تلقائياً، بلا فلتر يدوي**.
- تشغيل بـ **SWC** (`.swcrc`) لا tsx (esbuild لا يولّد decorator metadata → ينكسر Nest DI).
- التحقق من المدخلات بـ **zod** على كل حدّ (لا class-validator). موديول لكل مجال.

## السجل

### Phase 2a — أساس الباك + Auth (commit 193cde6)
`DbService` + `AuthGuard` (JWT → subdomain→tenant → role) + auth (argon2 login + JWT) + /me + /rfqs (قراءة).
مُتحقَّق HTTP: login، باسورد غلط مرفوض، /me، عزل RLS عبر الـ API، 401 بدون توكن.

### Phase 2b — نموذج الهوية + التبديل بين الـ workspaces (commit b312bdf)
ADR-0010 (قاعدة واحدة، رفض القاعدة-المنفصلة). `platform_members` + 3 طبقات وصول +
`GET /api/workspaces` (أساس السويتشر) + منع غير الأعضاء (403).
مُتحقَّق HTTP: admin يرى 3 workspaces، advisor يرى 1، multi يبدّل بين riyadh+jeddah، غير العضو 403.

### Phase 2c — سلسلة الطلب: إنشاء RFQ ✅ (هذا الكومِت)
- **`RolesGuard` + `@Roles`** (قابل لإعادة الاستخدام): platform staff يمر دائماً؛ company/vendor حسب
  الدور المصرَّح؛ بلا `@Roles` = أي مستخدم مُصادَق (لا يزال معزولاً بالـ RLS).
- **`RfqService.create`**: transaction واحد tenant-scoped — يتحقق أن الفرع من نفس الـ workspace،
  يشتق prefix من منطقة الفرع، يصدر رقم الطلب بـ `next_order_number()` الذرّية، ينشئ الرأس + البنود
  بحالة `new_rfq`. الـ RLS + trigger التدقيق يعملان تلقائياً.
- **`POST /api/rfqs`** (أدوار الورش: company_admin/branch_manager/service_advisor + platform) +
  **`GET /api/rfqs`**.

**مُتحقَّق HTTP:** إنشاء RFQ (CEN-1) ببندين · ترقيم ذرّي متسلسل (CEN-2, CEN-3) · قائمة معزولة ·
عضو غير مصرّح له بالـ workspace = 403 · **فرع من workspace آخر مرفوض بالـ RLS** ("not found in
this workspace").

## التالي (Phase 2d+)
إرسال RFQ للموردين (rfq_vendors + توكن مُهاش) → استقبال تسعيرات المورّد (rfq_vendor_items) →
اختيار التسعيرة الفائزة → تأكيد الطلب (orders/order_items). ثم طبقة notifications (side-effects
خلف sandbox guard) قبل أي إرسال حقيقي.
