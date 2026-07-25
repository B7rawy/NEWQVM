import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { requireCounterparty } from "../../common/counterparty.helpers.js";
import { envOf } from "../../common/env-guards.js";

/**
 * Service-provider self-service portal (cross-workspace), the third counterparty portal. A provider
 * has no RFQ→quote loop of its own (it delivers a SERVICE — shipping, inspection, claims), so the
 * portal is its own record: who it is, which workspaces it serves, and its people. Scoped by
 * ownership via service_provider_users, exactly like the vendor/workshop portals.
 */
@Injectable()
export class ProviderPortalService {
  constructor(private readonly dbService: DbService) {}

  private requireProviderId(tx: Tx, userId: string | null): Promise<string> {
    return requireCounterparty(tx, userId, "service_provider");
  }

  /** The provider's own record + the workspaces it serves. */
  async overview(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      const id = await this.requireProviderId(tx, ctx.userId);
      const provider = (await tx.execute(sql`
        select legal_name, scope, service_type, counterparty_type, activation_status,
          tax_number, primary_email, primary_phone
        from service_providers where id = ${id}::uuid limit 1`))[0] as object;
      const workspaces = (await tx.execute(sql`
        select t.name from tenant_service_providers tsp join tenants t on t.id = tsp.tenant_id
        where tsp.service_provider_id = ${id}::uuid and tsp.status = 'active' order by t.name`)) as Array<{ name: string }>;
      const teammates = await tx.execute(sql`
        select u.full_name, u.email, spu.is_provider_admin, u.is_active
        from service_provider_users spu join users u on u.id = spu.user_id
        where spu.service_provider_id = ${id}::uuid order by spu.is_provider_admin desc, u.full_name`);
      return { ...provider, workspaces: workspaces.map((w) => w.name), teammates };
    });
  }
}
