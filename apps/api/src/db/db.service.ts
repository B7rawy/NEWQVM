import { Injectable, OnModuleDestroy } from "@nestjs/common";
import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "../../drizzle/schema/index.js";

export { schema };
export type Tx = PostgresJsDatabase<typeof schema>;

/** The RLS session context set on every request-scoped transaction. */
export interface RlsContext {
  tenantId: string | null;
  userId: string | null;
  isInternal: boolean;
  /** Data environment within the workspace — 'live' (default) or 'sandbox'. */
  environment?: "live" | "sandbox";
  /** Real actor when acting under 'view as' — for platform_audit accountability. */
  impersonatorId?: string | null;
}

/**
 * DB access. CRITICAL: connects as the NON-superuser app role (APP_DATABASE_URL → qvm_app) so
 * RLS actually applies (CONVENTIONS §DB-2). Every tenant-scoped query runs inside `withContext`,
 * which opens a transaction and SET LOCAL-s app.tenant_id / app.user_id / app.is_internal — the
 * isolation the whole system depends on. Never query tenant tables outside withContext.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly client: postgres.Sql;
  readonly db: PostgresJsDatabase<typeof schema>;

  constructor() {
    const url =
      process.env.APP_DATABASE_URL ??
      "postgresql://qvm_app:qvm_app_local_dev@localhost:5434/qvm_platform";
    this.client = postgres(url, { max: 10 });
    this.db = drizzle(this.client, { schema });
  }

  /** Run work inside a transaction with the RLS session variables set (transaction-local). */
  async withContext<T>(ctx: RlsContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select
        set_config('app.tenant_id', ${ctx.tenantId ?? ""}, true),
        set_config('app.user_id', ${ctx.userId ?? ""}, true),
        set_config('app.is_internal', ${ctx.isInternal ? "true" : "false"}, true),
        set_config('app.environment', ${ctx.environment ?? "live"}, true),
        set_config('app.impersonator_id', ${ctx.impersonatorId ?? ""}, true)`); // reserved for DB-side audit triggers (no reader yet; the app writes impersonator_id explicitly)
      return work(tx as unknown as Tx);
    });
  }

  async onModuleDestroy() {
    await this.client.end();
  }
}
