# @qvm/api — Backend (NestJS + Drizzle)

الباك إند للمنصّة. RLS-scoped لكل request عبر دور `qvm_app` غير الـ superuser.

## التشغيل
```bash
corepack pnpm --filter @qvm/api dev     # node + @swc-node/register (يولّد decorator metadata لـ Nest DI)
```
> **مهم:** لا تستخدم `tsx` لتشغيل الـ API — esbuild لا يولّد `emitDecoratorMetadata` فينكسر الـ DI.
> نستخدم SWC (`.swcrc`). الـ seed والميجريشنز تعمل بـ tsx/drizzle-kit عادي.

## البنية (المرحلة 2a — منفَّذة)
```
src/
├── db/            DbService — يتصل بدور qvm_app؛ withContext() يفتح transaction ويضبط
│                  SET LOCAL app.tenant_id/user_id/is_internal (هذا ما يجعل RLS فعّالاً)
├── common/        request-context (حلّ الساب-دومين/الدور) + AuthGuard (JWT → tenant → role)
└── modules/
    ├── auth/      POST /api/auth/login — argon2 + JWT
    ├── me/        GET  /api/me
    └── rfq/       GET  /api/rfqs — tenant-scoped بلا فلتر يدوي (RLS يعزل)
```

## مُتحقَّق (HTTP حقيقي)
login (argon2+JWT) · باسورد غلط مرفوض · /me يحلّ الدور · /rfqs يعزل بالـ RLS
(مستخدم على workspace آخر = صفر) · بدون توكن = 401 · internal يرى عبر الكل.

## التالي (المرحلة 2b)
موديولات المجالات (rfq كتابة، orders، pricing، vendors…) + طبقة notifications
(side-effects خلف sandbox guard) + Zod DTOs لكل endpoint.
