/**
 * RLS invariant guard (audit finding: new tables are born fully open to qvm_app via the default
 * ACL, and the 0001 policy loop only covered tables that existed then — platform_audit slipped
 * through exactly this way). Run after migrations (locally, on prod, or in CI):
 *
 *   DATABASE_URL=... pnpm --filter @qvm/api db:verify
 *
 * Fails (exit 1) if any public base table:
 *   1. has RLS disabled or not FORCEd, or
 *   2. has RLS enabled but zero policies (silently blocks qvm_app), or
 *   3. carries tenant_id but has no tenant-scoped policy.
 */
import postgres from "postgres";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://qvm:change_me_in_local_env@localhost:5434/qvm_platform",
  { max: 1 },
);

async function main() {
  const problems: string[] = [];

  const tables = (await sql`
    select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      exists (select 1 from information_schema.columns col
              where col.table_schema='public' and col.table_name=c.relname and col.column_name='tenant_id') as has_tenant,
      (select count(*)::int from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies,
      (select count(*)::int from pg_policies p where p.schemaname='public' and p.tablename=c.relname
        and (p.qual ilike '%current_tenant_id%' or p.with_check ilike '%current_tenant_id%')) as tenant_policies
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relkind='r'
    order by c.relname`) as unknown as Array<{
    name: string; rls: boolean; forced: boolean; has_tenant: boolean; policies: number; tenant_policies: number;
  }>;

  for (const t of tables) {
    if (!t.rls) problems.push(`${t.name}: RLS is DISABLED`);
    else {
      if (t.policies === 0) problems.push(`${t.name}: RLS enabled but has ZERO policies`);
      if (t.has_tenant && !t.forced) problems.push(`${t.name}: tenant table without FORCE ROW LEVEL SECURITY`);
      if (t.has_tenant && t.tenant_policies === 0)
        problems.push(`${t.name}: tenant_id table with no tenant-scoped policy`);
    }
  }

  await sql.end();
  if (problems.length) {
    console.error(`RLS VERIFY FAILED (${problems.length}):`);
    for (const p of problems) console.error("  ✗ " + p);
    process.exit(1);
  }
  console.log(`RLS verify OK — ${tables.length} tables all covered.`);
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
