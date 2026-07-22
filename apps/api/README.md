# @qvm/api — Backend (NestJS)

الباك إند للمنصّة. **لم يُولَّد بعد** — هذا المجلد يحتفظ بالبنية المستهدفة.

## التوليد (المرحلة 2، الخطوة الأولى)

```bash
# من جذر الريبو
corepack pnpm dlx @nestjs/cli new apps/api --skip-git --package-manager pnpm
```

ثم إضافة: `drizzle-orm`, `drizzle-kit`, `postgres`, `argon2`, `@nestjs/jwt`, `zod`.

## البنية المستهدفة (domain-driven — موديول لكل مجال، لا god-modules)

```
apps/api/
├── drizzle/                 # schema + migrations (المصدر الوحيد)
│   ├── schema/              # جدول لكل ملف، كلها تحمل tenant_id
│   ├── migrations/          # مولّدة بـ drizzle-kit، اتجاه واحد
│   └── seed/                # seed وهمي واقعي (شركات/طلبات/موردين)
├── src/
│   ├── common/              # tenant-context middleware, guards, RLS session setter,
│   │                        #   side-effect layer (notifications guard on is_sandbox)
│   ├── modules/
│   │   ├── auth/            # JWT + argon2 + resolve tenant from subdomain
│   │   ├── tenants/         # companies/workspaces CRUD + provisioning + subdomains
│   │   ├── users/
│   │   ├── rfq/  quotations/  pricing/  vendors/
│   │   ├── orders/  deliveries/  returns/  invoices/
│   │   ├── reports/
│   │   ├── admin/          # super-admin surface
│   │   ├── sandbox/        # seed + reset for is_sandbox tenants
│   │   ├── files/          # MinIO/S3 abstraction
│   │   └── notifications/  # email/whatsapp/webhooks — ALL guarded by is_sandbox
│   └── main.ts
```

## قواعد
- **RLS مفعّل**؛ كل request يضبط `SET LOCAL app.tenant_id` من سياق الـ tenant.
- **صفر SECURITY DEFINER مفتوح للعامة** — كل endpoint خلف guard صريح.
- **الأنواع مولّدة من drizzle schema** — لا `any` على حدود البيانات.
