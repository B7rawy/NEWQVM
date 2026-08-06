import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { targetTenant } from "../../common/tenant-target.js";
import { envOf } from "../../common/env-guards.js";

export const createProviderSchema = z
  .object({
    counterpartyType: z.enum(["individual", "company"]).default("company"),
    scope: z.enum(["internal", "external"]).default("external"),
    legalName: z.string().min(2),
    serviceType: z.string().max(120).optional(),
    taxNumber: z.string().optional(),
    primaryEmail: z.string().email().optional(),
    primaryPhone: z.string().optional(),
    classification: z.string().optional(),
    tenantId: z.string().uuid().optional(),
  })
  // QNEW-71: same mandatory-identifier rule as vendors/workshops.
  .superRefine((d, ctx) => {
    if (d.counterpartyType === "company" && !d.taxNumber)
      ctx.addIssue({ code: "custom", path: ["taxNumber"], message: "a company requires a tax number" });
    if (d.counterpartyType === "individual" && !d.primaryPhone)
      ctx.addIssue({ code: "custom", path: ["primaryPhone"], message: "an individual requires a mobile number" });
  });
export const providerStatusSchema = z.object({ status: z.enum(["active", "suspended", "archived"]) });

@Injectable()
export class ProvidersService {
  constructor(private readonly dbService: DbService) {}

  /** Providers LINKED to the active workspace, OR the GLOBAL directory when platform staff are unscoped. */
  async list(ctx: RlsContext) {
    const global = ctx.isInternal && !ctx.tenantId;
    const rows = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: global },
      (tx) =>
        global
          ? tx.execute(sql`
              select sp.id, sp.legal_name, sp.scope, sp.service_type, sp.counterparty_type, sp.activation_status,
                sp.tax_number, sp.primary_email, sp.primary_phone,
                case when sp.is_active then 'active' else 'inactive' end as status,
                null::text as classification,
                (select spu.user_id from service_provider_users spu where spu.service_provider_id = sp.id order by spu.is_provider_admin desc limit 1) as user_id,
                (select count(*)::int from tenant_service_providers t where t.service_provider_id = sp.id and t.status <> 'archived') as workspaces
              from service_providers sp order by sp.legal_name`)
          : tx.execute(sql`
              select sp.id, sp.legal_name, sp.scope, sp.service_type, sp.counterparty_type, sp.activation_status,
                sp.tax_number, sp.primary_email, sp.primary_phone,
                tsp.status, tsp.classification,
                (select spu.user_id from service_provider_users spu where spu.service_provider_id = sp.id order by spu.is_provider_admin desc limit 1) as user_id
              from tenant_service_providers tsp
              join service_providers sp on sp.id = tsp.service_provider_id
              where tsp.status <> 'archived' order by sp.legal_name`),
    );
    return { count: rows.length, providers: rows };
  }

  /** Create a global provider + link it to the target workspace (internal / global write). */
  async create(ctx: RlsContext, dto: z.infer<typeof createProviderSchema>) {
    const target = targetTenant(ctx, dto.tenantId);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      let sp: { id: string };
      try {
        [sp] = (await tx.execute(sql`
        insert into service_providers (legal_name, counterparty_type, scope, service_type, tax_number,
          primary_email, primary_phone, created_by, updated_by)
        values (${dto.legalName}, ${dto.counterpartyType}, ${dto.scope}, ${dto.serviceType ?? null}, ${dto.taxNumber ?? null},
          ${dto.primaryEmail ?? null}, ${dto.primaryPhone ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid)
        returning id`)) as Array<{ id: string }>;
      } catch (e) {
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("a counterparty with this identifier already exists — link the existing one instead");
        throw e;
      }
      await tx.execute(sql`
        insert into tenant_service_providers (tenant_id, service_provider_id, status, classification, linked_by, created_by, updated_by)
        values (${target}::uuid, ${sp.id}::uuid, 'active', ${dto.classification ?? null}, ${ctx.userId}::uuid, ${ctx.userId}::uuid, ${ctx.userId}::uuid)`);
      return { id: sp.id };
    });
  }

  /** Suspend / archive / reactivate a provider's link to a workspace (tenant_service_providers.status). */
  async setStatus(ctx: RlsContext, id: string, dto: z.infer<typeof providerStatusSchema>) {
    const target = targetTenant(ctx);
    return this.dbService.withContext({ tenantId: target, userId: ctx.userId, isInternal: ctx.isInternal, environment: envOf(ctx) }, async (tx) => {
      const rows = (await tx.execute(sql`
        update tenant_service_providers set status = ${dto.status}, updated_by = ${ctx.userId}::uuid, updated_at = now()
        where service_provider_id = ${id}::uuid and tenant_id = ${target}::uuid returning id`)) as Array<{ id: string }>;
      if (!rows[0]) throw new NotFoundException("provider not linked to this workspace");
      return { ok: true };
    });
  }
}
