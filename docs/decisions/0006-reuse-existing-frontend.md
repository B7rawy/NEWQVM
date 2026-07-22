# ADR-0006: إعادة استخدام واجهة المشروع الحالي كأساس (لا rewrite كامل)

**الحالة:** مقبول — 2026-07-22 (اختيار صاحب المشروع)

## القرار
الفرونت الجديد (`apps/web`) يُبنى بنسخ الأصول القيّمة من `/Users/wael/qvm-new-production`:
- مكوّنات `components/ui/*` (Button, Table, Modal, Drawer, Badge, …) و`components/layout/*`.
- التصميم والهوية البصرية (brand-navy / brand-red) وقواميس الترجمة (تُنقل لموديول i18n top-level).
- الـ `qvm-superadmin` prototype → أساس داشبورد السوبر أدمن (المرحلة 5).

مع **استبعاد** صريح لـ: طبقة الداتا القديمة (`supabase-js`, `apiService.ts`)، الأجيال الميتة
(`rfqs-dashboard`, `rfqs-dashboard-v2`, ملفات `.bak`)، وأي `any` على الحدود.

## الإضافات الجديدة فوق الأساس
workspace/multi-company UX، subdomain routing، sandbox UX، وكل الناقص.

## الأسباب
- شهور شغل واجهة مثبتة تُحفظ بدل ما تُرمى؛ الأعطال كانت في الداتا والتنظيم لا في الـ UI نفسه.
- قرارات إلزامية مرافقة (CONVENTIONS §Frontend): lazy routes، جيل واحد لكل شاشة، مصدر تنسيق واحد.

## البديل المرفوض
- **واجهة من الصفر:** أنظف نظرياً لكن أبطأ بمراحل ويرمي شغلاً جيداً بلا داعٍ.
