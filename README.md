# QVM Platform

إعادة تأسيس نظيفة ومتعددة المستأجرين (multi-tenant) لنظام مشتريات قطع الغيار Qparts/QVM.
**معزول تماماً عن المشروع الحقيقي** — ريبو خاص، سيرفر وقاعدة بيانات خاصان.

**📚 التوثيق هو المرجع — كل خطوة موثَّقة 100%:** ابدأ من [`docs/README.md`](docs/README.md)
(onboarding · معمارية · قواعد ملزمة · سجل قرارات ADRs · سجل مراحل التنفيذ)

## المكوّنات
- `apps/api` — الباك إند (NestJS + Drizzle + PostgreSQL)
- `apps/web` — الواجهة (React + Vite، تعيد استخدام تصميم الحالي)
- `packages/shared` — أنواع وأدوار مشتركة
- `infra` — Docker (Postgres + MinIO)

## المتطلبات
- Node ≥ 22، Docker
- pnpm عبر corepack: `corepack pnpm ...` (أو `npm i -g pnpm` إن توفّر sudo)

## التشغيل المحلي (بعد اكتمال المراحل 1–3)
```bash
cp .env.example .env      # ثم عدّل الأسرار
corepack pnpm install
corepack pnpm db:up       # postgres + minio
corepack pnpm db:migrate
corepack pnpm db:seed     # بيانات وهمية واقعية
corepack pnpm dev         # api + web
```

## الحالة: المرحلة 0 (التأسيس)
تم: بنية الـ monorepo، Docker، البيئات، الأنواع/الأدوار المشتركة، الوثيقة المعمارية.
التالي: المرحلة 1 — نموذج البيانات + tenant_id + RLS + seed.
