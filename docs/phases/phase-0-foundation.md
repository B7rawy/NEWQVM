# المرحلة 0 — التأسيس والعزل

**الحالة:** ✅ مكتملة — 2026-07-22
**الهدف:** ريبو معزول تماماً عن المشروع الحقيقي، ببنية monorepo وبنية تحتية محلية ووثائق مؤسِّسة.

## ما تم تنفيذه

### 1. البنية
```
qvm-platform/
├── apps/api/              # placeholder + README بالبنية المستهدفة (يُولَّد NestJS في المرحلة 2)
├── apps/web/              # placeholder + README بخطة إعادة استخدام واجهة القديم
├── packages/shared/       # حزمة أنواع مشتركة — فيها roles.ts (enums الأدوار الجديدة)
├── infra/docker-compose.yml  # Postgres 16 + MinIO (ستاك محلي معزول)
├── docs/                  # كل التوثيق (هذا الملف ضمنه)
├── package.json           # سكربتات الجذر (db:up, db:migrate, dev, …)
├── pnpm-workspace.yaml
├── .env.example           # قالب البيئة — فيه أعلام sandbox/side-effects من اليوم الأول
└── .gitignore
```

### 2. قرارات اتُّخذت وتوثّقت (انظر `docs/decisions/`)
ADR-0001 Postgres self-hosted · ADR-0002 NestJS+Drizzle · ADR-0003 نموذج الـ multi-tenancy ·
ADR-0004 sandbox-as-tenant · ADR-0005 monorepo · ADR-0006 إعادة استخدام الفرونت · ADR-0007 سياسة الداتا.

### 3. أوامر نُفِّذت
```bash
mkdir -p qvm-platform/{docs,apps/api,apps/web,packages/shared,infra}
git init && git add -A && git commit   # commit: fa574d9 (scaffold) ثم commit التوثيق
```

### 4. مشاكل وحلولها
- `corepack enable pnpm` فشل بـ EACCES (symlink في /usr/local/bin يحتاج sudo) →
  **الحل:** استخدام `corepack pnpm <cmd>` مباشرة، موثَّق في ONBOARDING.

## قيود العزل (تحققت)
- لا أي تعديل على `/Users/wael/qvm-new-production` ولا Supabase القديمة ولا سيرفرات الإنتاج.
- الريبو بلا remote حتى الآن — يُنشأ ريبو GitHub خاص جديد عند أول push (ممنوع ربطه بريموت القديم).

## الخطوة التالية → المرحلة 1
نموذج البيانات + الـ tenancy (انظر [phase-1-data-model.md](phase-1-data-model.md) عند بدئها):
1. استخراج السكيما الكاملة من قاعدة القديم كمرجع (بدون نسخ العك).
2. تصميم السكيما الجديدة: `tenants` + `tenant_id` على كل جدول + توحيد الازدواج.
3. RLS policies من أول ميجريشن + indexes على كل FK + `(tenant_id, …)` composite.
4. sequences حقيقية لأرقام الطلبات.
5. seed وهمي واقعي يشمل sandbox tenant.
