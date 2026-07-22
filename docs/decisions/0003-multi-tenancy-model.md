# ADR-0003: Multi-tenancy = shared schema + tenant_id + RLS + subdomains

**الحالة:** مقبول — 2026-07-22

## القرار
- كيان `tenants` حقيقي (الشركة/الورشة = workspace كامل بهويته وإعداداته وساب-دومينه).
- **schema واحد مشترك** + عمود `tenant_id` على كل جدول أساسي.
- **RLS على كل جدول**: policy `tenant_id = current_tenant()` — العزل مضمون في قاعدة البيانات.
- `current_tenant()` من JWT/session عبر `SET LOCAL app.tenant_id` لكل request.
- **Subdomain لكل شركة** (`company-a.<root>`) → middleware يحلّه إلى tenant_id.
- موظفو المنصّة الداخليون يرون كل الشركات عبر policy `is_internal_staff()` إضافية.

## السياق
القديم single-tenant متنكّر: "الشركة" صف في قائمة dropdown (`lists: 1:client_name`)،
جدول `quotations` لا يحمل أي عمود client/company، والعزل منطق تطبيق فقط مع RLS مقفول —
غلطة param واحدة تكشف بيانات شركة لشركة أخرى.

## البدائل المرفوضة
- **Database-per-tenant:** كابوس تشغيلي (باك أب × N، ميجريشن × N، لا تقارير موحّدة). عكس هدف الترتيب.
- **Schema-per-tenant:** نفس المشاكل بدرجة أقل + تعقيد ميجريشنز كبير.
- **عزل بطبقة التطبيق فقط (زي القديم):** هو بالضبط النموذج الهشّ الذي نصلحه.

## النتائج
- composite indexes إلزامية `(tenant_id, …)` (انظر CONVENTIONS §DB).
- الـ sandbox يصبح مجرد tenant (ADR-0004) — ميزة مجانية من هذا النموذج.
