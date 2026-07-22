# المرحلة 3 — موديولات الرودماب (QNEW)

**الحالة:** ✅ كل الأنظمة الفرعية الـ9 مبنيّة ومُتحقَّقة — 2026-07-22
**الهدف:** بناء رودماب عبدالله (QNEW) فوق نواة سلسلة الطلب (المرحلة 2) بنفس المعايير
(RLS/tenant_id، zod، @PlatformOnly، مُتحقَّق HTTP، كل خطوة commit).

## البنية التحتية المشتركة
- **دوال RLS مساعدة** (ميجريشن 0010): `apply_tenant_rls` / `apply_global_rls` idempotent — كل موديول
  جديد يطبّق الـ RLS بسطر واحد.

## الأنظمة الفرعية (كل واحد commit مستقل ومُتحقَّق HTTP)

| # | النظام | QNEW | أبرز ما بُني | تحقّق |
|---|---|---|---|---|
| 3a | **Master Data** | 28/32/33/34 | parts_master+مرادفات+تطبيع؛ `cleanPartNumber`؛ كشف الفئة | clean/detect/search ✓ |
| 3b | **Pricing Engine** | 30/39/40/41 | agency_price_reference، pricing_basis_settings، حساب سعر البيع (هامش/وكالة/تكلفة)؛ **وُصِّل بالفاتورة** | فاتورة 125 (هامش 25%) ✓ |
| 3c | **Insurance/Payer** | 31/42/43/45 | insurance_companies، payer_type على RFQ، حالات موافقة التأمين | payer+approval flow ✓ |
| 3d | **Auto Vendor Assign** | 29/35/38 | vendor_selection_rules؛ اقتراح موردين حسب الفئة/المدينة + autoSend | match/no-match ✓ |
| 3e | **Infra** | 47 | audit_log؛ business_calendar + حساب المواعيد بأيام العمل/العطلات | deadline skips Fri/Sat/holiday ✓ |
| 3f | **Approval Engine** | 53 | policies/levels/requests/actions؛ متعدد المستويات بمعتمِدين مسمّين | 2-level + reject halt ✓ |
| 3g | **Vendor Self-Service** | 49/51 | vendor_stock_items (إخفاء الكمية)، vendor_pricing_policies (الأخص يفوز) | mask + region>global ✓ |
| 3h | **Vendor Finance** | 50/52 | vendor_payments+allocations (جزئي)، statement، financing (فائدة ثابتة) | partially_paid + financing ✓ |
| 3i | **Shipping/Logistics** | 54/55 | shipping_carriers، shipments، drivers، بث توصيل (أول من يقبل يفوز) | broadcast/first-accept ✓ |

## التحقق النهائي (القاعدة معاد بناؤها من الصفر — 24 ميجريشن)
- إعادة بناء كاملة + seed: نجحت.
- الفحص الأمني: **81 جدول · صفر بدون RLS · صفر FK بدون index · صفر جدول tenant بلا policy عزل ·
  103 policy · 66 audit trigger.**
- smoke شامل: سلسلة الطلب كاملة + كل موديولات الرودماب تعمل بعد إعادة البناء.

## ملاحظات (نطاقات مؤجَّلة موثَّقة)
- ترحيل قاموس القطع الكامل (615 مدخل) = مهمة بيانات.
- خدمة الموردين الذاتية مبوَّبة @PlatformOnly لحين ربط مصادقة مستخدمي الموردين في الحارس.
- shipment_legs / driver_ratings / carrier_pricing_rules التفصيلية = تُبنى عند الحاجة.
- محرك التسعير: سعر البيع placeholder→محسوب؛ باقي التكامل الدقيق per-payer عند تفعيل الشاشات.
- **محرك الموافقات:** المنفَّذ = sequential بمعتمِد لكل مستوى. `parallel` mode و`is_required` و`reassign`
  (الأعمدة/enum موجودة) **مؤجَّلة صراحةً** — تُنفَّذ عند الحاجة (لا تُدّعى كمكتملة).
