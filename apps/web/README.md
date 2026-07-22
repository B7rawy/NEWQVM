# @qvm/web — Frontend (React + Vite)

الواجهة. **تعيد استخدام مكوّنات الـ UI والتصميم من المشروع الحالي**، مبنية نظيفة فوق الـ API الجديد.

## البداية (المرحلة 3)

1. توليد قاعدة Vite + React + TS نظيفة هنا.
2. **نسخ** مكوّنات الـ design-system القابلة لإعادة الاستخدام من المشروع القديم
   (`/Users/wael/qvm-new-production/components/ui/*`, `layout/*`) — **بدون** طبقة الداتا القديمة.
3. استبدال `supabase-js` بعميل API يكلّم `@qvm/api` (REST/tRPC).
4. استيراد الأنواع والأدوار من `@qvm/shared` (لا إعادة تعريف).

## قرارات إلزامية (إصلاح مشاكل القديم)
- **code-splitting + lazy routes من أول يوم** (القديم = chunk واحد 3MB).
- **i18n في مكانه**: موديول top-level مشترك، لا مدفون تحت `internal-dashboard/`.
- **subdomain routing**: الـ host يحدّد الـ tenant/workspace.
- **صفر نسخ v2/v3** — جيل واحد فقط لكل شاشة.
- **مصدر واحد** لتنسيق العملة/التاريخ وخرائط ألوان الحالة (لا تكرار في 50 ملف).

## ما يُعاد استخدامه من القديم
- مكوّنات `components/ui/` (Button, Table, Modal, Drawer, Badge, …).
- تخطيط `components/layout/` (AppShell, Sidebar, Header) — مع تعديله ليكون tenant-aware.
- الـ `qvm-superadmin` prototype الموجود → يصبح أساس داشبورد السوبر أدمن (المرحلة 5).
