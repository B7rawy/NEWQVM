# 🚀 Onboarding — تشغيل المشروع من الصفر

> الهدف: مطوّر جديد يوصل لبيئة شغّالة خلال ~15 دقيقة، بدون ما يسأل حد.

## 1. المتطلبات

| الأداة | النسخة | ملاحظات |
|---|---|---|
| Node.js | ≥ 22 | |
| Docker | حديث | للـ Postgres + MinIO محلياً |
| pnpm | 9.x | عبر corepack: استخدم `corepack pnpm <cmd>` — أو `npm i -g pnpm` إن كان عندك صلاحيات |

> **ملاحظة macOS:** لو `corepack enable pnpm` فشل بـ EACCES (يحتاج sudo لعمل symlink في `/usr/local/bin`)،
> استخدم الصيغة `corepack pnpm <command>` مباشرة — تعمل بدون أي صلاحيات.

## 2. التهيئة

```bash
git clone <REPO_URL> qvm-platform
cd qvm-platform
cp .env.example .env        # ⚠️ عدّل كل قيم change_me — لا تشغّل بالقيم الافتراضية
corepack pnpm install
```

## 3. تشغيل البنية التحتية المحلية

```bash
corepack pnpm db:up         # postgres (host port $POSTGRES_PORT, default 5433) + minio :9000
```

> **تعارض بورت:** لو 5432/5433 مشغولين بمشاريع أخرى، عيّن `POSTGRES_PORT` في `.env` لبورت فاضٍ
> (بيئة التطوير الحالية تستخدم **5434**) وحدّث `DATABASE_URL` وفقاً له.

بيانات Docker المحلية تُخزَّن في `infra/data/` (خارج git).

## 4. الميجريشنز والبيانات الوهمية

```bash
corepack pnpm db:migrate    # يطبّق ميجريشنز drizzle (اتجاه واحد دائماً)
corepack pnpm db:seed       # يزرع شركات/طلبات/موردين وهميين + sandbox tenant
```

## 5. التشغيل

```bash
corepack pnpm dev           # api على :4000 + web على vite dev server
```

الوصول للـ workspaces محلياً عبر subdomains على `qvm.localhost`
(مثلاً `demo-co.qvm.localhost` — المتصفحات الحديثة تحلّ `*.localhost` تلقائياً بدون تعديل hosts).

## 6. أين تقرأ بعد التشغيل؟

- [ARCHITECTURE.md](ARCHITECTURE.md) — افهم البنية قبل ما تكتب سطر.
- [CONVENTIONS.md](CONVENTIONS.md) — القواعد الملزمة.
- `phases/` — آخر مرحلة نشطة فيها "الحالة والخطوة التالية".

## حالة المشروع الحالية

المشروع في **المرحلة 0/1** — الـ api والـ web لم يُولَّدا بعد؛ أوامر `db:migrate`/`db:seed`/`dev`
ستعمل بعد اكتمال المرحلة 1 والمرحلة 2. راجع `phases/` لآخر حالة فعلية.
