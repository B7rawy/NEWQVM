import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../drizzle/schema/index";

/**
 * Postgres connection + Drizzle instance.
 * The runtime API sets app.tenant_id / app.user_id / app.is_internal per request (SET LOCAL)
 * so RLS scopes every query; this bare client is used by scripts (seed) and the request layer.
 */
const connectionString =
  process.env.DATABASE_URL ??
  "postgresql://qvm:change_me_in_local_env@localhost:5434/qvm_platform";

export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
export { schema };
