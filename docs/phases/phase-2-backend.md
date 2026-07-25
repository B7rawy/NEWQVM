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

### Phase 2d — إرسال RFQ للموردين + بوابة التسعيرة + طبقة الإشعارات ✅ (هذا الكومِت)
- **`NotificationsService`** = حدّ الآثار الجانبية الوحيد (ADR-0012 / CONVENTIONS §BE-3). لا شيء
  يبعت email/whatsapp/webhook إلا عبره. في tenant sandbox (أو provider مقفول/non-prod) يسجّل
  الرسالة `suppressed` ولا يلمس أي provider حقيقي. كل محاولة تُكتب في **`notification_log`**
  (جدول جديد، tenant-scoped + RLS، 0005/0006) = السجل والبرهان.
- **`POST /api/rfqs/:id/send`** (داخلي فقط): ينشئ `rfq_vendors` بتوكن **مُهاش** (sha256، صلاحية 7 أيام)
  + إشعار مضبوط لكل مورّد؛ يتحقق أن المورّد مرتبط بالـ workspace.
- **`POST /api/quote-access/:token/quote`** (عام، بدون تسجيل دخول): التوكن هو الصلاحية — يُحلّ كـ internal
  ثم الكتابة تُقيَّد بـ tenant التوكن (RLS يطبَّق)؛ يتحقق أن البنود تخص الـ RFQ؛ ينشئ `rfq_vendor_items`.

**مُتحقَّق HTTP:** إرسال على riyadh(prod) → `sent`؛ المورّد يسعّر بالتوكن بلا دخول → مخزَّن (150.50)؛
**إرسال على sandbox → `suppressed`**؛ **notification_log: riyadh=sent, sandbox=suppressed** (برهان
عزل الـ sandbox)؛ توكن غلط → 404.

### Phase 2e — اختيار الفائز + تأكيد الطلب ✅ (هذا الكومِت)
- `VendorRfqService.getQuotes` (مقارنة التسعيرات) + `selectWinner` (يضبط
  rfq_items.winning_vendor_quote_item_id = old cost_id؛ يتحقق أن التسعيرة تخص الـ RFQ+البند).
- `OrdersService.confirm`: ينشئ order + order_items للبنود ذات التسعيرة الفائزة فقط؛ **رقم الطلب
  يُعاد استخدامه من الـ RFQ (يظل ثابتاً عبر دورة الحياة)**؛ order_item↔rfq_item علاقة 1:1
  (DB-enforced) → RFQ يُؤكَّد مرة واحدة فقط.
- Endpoints: GET /rfqs/:id/quotes، POST /rfqs/:id/items/:itemId/winning-quote (داخلي)،
  POST /rfqs/:id/confirm (أدوار الورش)، GET /orders.

**مُتحقَّق HTTP (السلسلة الكاملة):** RFQ ببندين → إرسال → تسعير المورّد → مقارنة → اختيار الفائز
→ تأكيد (CEN-1 نفس الرقم، بندين) → قائمة الطلبات (Confirmed) → تأكيد مكرر مرفوض → 1:1 مؤكَّد.

### Phase 2-review — تصليب بعد المراجعة النقدية ✅ (هذا الكومِت)
مراجعة نقدية مستقلة أكّدت نواة العزل سليمة (صفر ثغرة حرجة). عولجت كل الملاحظات:
- **#1 تصادم أسماء الأدوار (High):** الـ endpoints الداخلية كانت تُبوَّب على نص دور يتصادم مع
  membership_role. أُضيف `@PlatformOnly()` → تتطلب `ctx.isInternal` (platform staff فقط)، فمستحيل
  يمرّ مستخدم ورشة (يحمي أسعار الموردين السرّية getQuotes/select-winner). طُبِّق على send/quotes/select-winner.
- **#2 التوكن الخام (High):** كان يُكتب في notification_log.payload ويُرجَع بالـ HTTP. الآن: السجل
  يحمل metadata غير سرّية فقط؛ الرابط بالتوكن يُمرَّر للـ provider عبر وسيط `secret` لا يُخزَّن؛ التوكن
  يُرجَع في الـ response فقط في non-prod.
- **#3 المستخدم المعطَّل (High):** الحارس يتحقق الآن من `users.is_active` (كان يتخطّاه حتى انتهاء الـ JWT).
- **#4/#5 أقفال بعد التأكيد (Medium):** select-winner و submit-quote يُرفضان بعد تأكيد الطلب.
- **#6 + فهرس (Medium/NTH):** `orders.rfq_id` unique (طلب واحد لكل RFQ) + unique index على
  `rfq_vendors.token_hash` (بحث البوابة السريع + منع تكرار التوكن). + money zod `.finite().max()`.
- ميجريشن 0007.

**مُتحقَّق HTTP (11/11):** السلسلة الكاملة لسه شغّالة (regression) · advisor على send/quotes = 403 ·
**لا توكن في notification_log** · select-winner و re-quote بعد التأكيد مرفوضان · القيود الفريدة موجودة.

### Phase 2f — الشراء (Purchase Orders) ✅ (هذا الكومِت)
- `PurchasingService.createForOrder`: من طلب مؤكّد، كل بند تسعيرته الفائزة تحدّد مورّده
  (order_item → rfq_vendor_item → rfq_vendor → vendor)؛ البنود تُجمَّع حسب المورّد → أمر شراء
  لكل مورّد + purchase_items تربط البند بالتسعيرة الفائزة (التكلفة على التسعيرة — صفر تكرار).
  Idempotent (يرفض لو الأوامر موجودة). `listForOrder` يعرض المورّد + عدد البنود + التكلفة الإجمالية.
- Endpoints: POST/GET /orders/:id/purchase-orders (**@PlatformOnly** — مشتريات داخلية).

**مُتحقَّق HTTP:** طلب ببندين من موردين مختلفين → **أمرا شراء منفصلان** (بند لكل) بتكلفة صحيحة من
التسعيرات الفائزة (600 / 180) · إنشاء مكرر مرفوض · الورشة (advisor) → 403.

### Phase 2g — التسليم (مجزّأ) + الفوترة ✅ (هذا الكومِت)
- `DeliveryService.create`: تسليم مجموعة بنود، **يدعم التجزئة/التسليم على دفعات** (القديم المسطّح
  ماكانش يقدر)؛ يمنع تجاوز الكمية (المُسلَّم+المطلوب ≤ approved_qty)؛ البند يصير `delivered` فقط عند
  اكتمال كميته. POST/GET /orders/:id/deliveries (@PlatformOnly).
- `InvoiceService.issue`: فاتورة واحدة لكل طلب (idempotent)، **ضريبة 15%**؛ سعر البيع = selling_price
  وإلا تكلفة التسعيرة الفائزة (placeholder موثَّق لحين محرك التسعير QNEW-30)؛ رقم فاتورة عبر
  next_order_number('INV-'). POST/GET /orders/:id/invoice (@PlatformOnly).

**مُتحقَّق HTTP:** تسليم جزئي 3/5 (البند يظل confirmed) → تسليم 2 (يكتمل → delivered) → تجاوز 6>5
مرفوض → فاتورة (500 + 75 ضريبة = 575) → فاتورة مكررة مرفوضة → الورشة 403.

### Phase 2h — المرتجعات + إشعارات الخصم ✅ (هذا الكومِت) — دورة الطلب مكتملة
- `ReturnsService.create` (أدوار الورش): إرجاع بنود مُسلَّمة بكمية+سبب+مسؤولية؛ يمنع الإرجاع الزائد
  (المُرجَع+المطلوب ≤ المُسلَّم)؛ ينقل البنود لـ 'return'. POST/GET /orders/:id/returns.
- `ReturnsService.issueCreditNote` (@PlatformOnly — مالية): إشعار خصم للمرتجع، سعر الوحدة من
  invoice_items وإلا selling_price/التكلفة؛ رقم CN- ؛ idempotent عبر حالة المرتجع؛ ينقل لـ
  'credit_note_issued'. POST /returns/:returnId/credit-note.

**مُتحقَّق HTTP:** إرجاع 2/5 → إرجاع زائد 6>5 مرفوض → إشعار خصم (200) → مكرر مرفوض → الورشة 403 →
الحالة النهائية credit_note_issued.

**🏁 دورة حياة الطلب الأساسية مكتملة:** RFQ → إرسال → تسعير → مقارنة → اختيار → تأكيد → شراء →
تسليم(مجزّأ) → فاتورة → مرتجع → إشعار خصم. كلها معزولة بالـ RLS، مؤمّنة بالأدوار، ومُختبَرة end-to-end.

## التالي
موديولات الرودماب الكبيرة: Master Data (parts_master) · محرك التسعير (QNEW-30) · التوزيع الآلي للموردين (QNEW-29) · التأمين/الدافعين (QNEW-31) · محرك الموافقات (QNEW-53) · الشحن (QNEW-54). ثم موديولات الرودماب (master data, pricing engine, auto-assignment…).
