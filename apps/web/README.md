# @qvm/web — Frontend (React + Vite)

واجهة المنصّة، تتكلم الـ API الجديد. RLS-scoped per workspace عبر رأس X-Tenant.

## التشغيل
```bash
corepack pnpm --filter @qvm/api dev   # API على :4000 (SWC)
corepack pnpm --filter @qvm/web dev   # الواجهة على :5200
```
(أو من الجذر: launch config `qvm-web`.)

## البنية (Phase 4a — منفَّذة)
- `src/lib/api.ts` — fetch client واحد (JWT + X-Tenant للـ workspace النشط).
- `src/lib/auth.tsx` — سياق المصادقة (توكن في localStorage) + workspaces + تبديل نشط.
- `src/pages/Login.tsx` — تسجيل دخول.
- `src/components/AppShell.tsx` — هيدر + **سويتشر workspaces** + تنقّل.
- `src/pages/Rfqs.tsx` — قائمة + إنشاء RFQ (موصولة بالـ API).
- `src/pages/Orders.tsx` — قائمة الطلبات.
- هوية بصرية navy/red من الديزاين القديم (styles.css).

## مُتحقَّق (متصفح)
دخول argon2 → سويتشر يعرض 3 workspaces (platform staff) → إنشاء RFQ (RFQ-1 في Jeddah) →
**التبديل لـ Riyadh يعرض RYD-1 المعزول** والفرع الصحيح. القوائم مقيَّدة بالـ workspace النشط
(is_internal لا يسرّب داتا عبر الـ workspaces في العرض).

## التالي
باقي شاشات دورة الطلب (إرسال/تسعير/تأكيد/شراء/تسليم/فاتورة/مرتجع) + شاشات الرودماب +
داشبورد السوبر أدمن + إعادة استخدام مكوّنات UI أوسع من القديم.
