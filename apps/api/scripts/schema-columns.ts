/**
 * Print the columns the DRIZZLE SCHEMA FILES declare and the columns the newest SNAPSHOT records,
 * so `guard-check.sh` can hold both up against the live database.
 *
 * WHY THIS EXISTS. Three artefacts have to agree — `drizzle/schema/*.ts`, the newest
 * `drizzle/migrations/meta/*_snapshot.json`, and the database — and for a long time none of them
 * did. `workflow_steps.pages` and `.owner_roles` were in the .ts and in the database but not in the
 * snapshot, so `drizzle-kit generate` wanted to ADD COLUMN for columns that already existed — SQL
 * that cannot run anywhere. The five columns 0049 added by hand were in the database and in neither
 * of the other two, so nothing in TypeScript could see them at all. Both failures are invisible
 * until somebody runs `db:generate`, and the person who does is not the person who caused it.
 *
 * The snapshot is READ FROM DISK rather than regenerated, because regenerating is what writes a
 * migration file — a check that mutates the repo is not a check.
 *
 * Output is one `source<TAB>table.column` line per column, `source` being `schema` or `snapshot`,
 * covering only the tables the schema files actually model. That is deliberate: the database holds
 * eight more `workflow_*` tables written entirely in hand-authored SQL (the action library, the
 * outbox, the digests…), and those are not drift — drizzle was never told about them on purpose.
 *
 * Usage:  tsx scripts/schema-columns.ts [table-name-prefix]
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "../drizzle/schema/index";

const prefix = process.argv[2] ?? "";
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle", "migrations");

const modelled = new Set<string>();
const lines: string[] = [];

for (const value of Object.values(schema as Record<string, unknown>)) {
  if (!is(value, PgTable)) continue;
  const table = getTableName(value as PgTable);
  if (!table.startsWith(prefix)) continue;
  modelled.add(table);
  for (const column of Object.values(getTableColumns(value as PgTable)))
    lines.push(`schema\t${table}.${column.name}`);
}

// The newest snapshot on disk, by the numeric prefix drizzle-kit gives them. NOT the newest journal
// entry: hand-written migrations deliberately produce no snapshot, so the chain legitimately sits
// behind the journal — what must not happen is it sitting behind the DATABASE.
const newest = readdirSync(join(migrations, "meta"))
  .filter((f) => /^\d+_snapshot\.json$/.test(f))
  .sort()
  .pop();
if (!newest) throw new Error(`no snapshot found in ${join(migrations, "meta")}`);

const snapshot = JSON.parse(readFileSync(join(migrations, "meta", newest), "utf8")) as {
  tables: Record<string, { columns: Record<string, unknown> }>;
};
for (const [key, table] of Object.entries(snapshot.tables)) {
  const name = key.includes(".") ? key.slice(key.indexOf(".") + 1) : key;
  if (!modelled.has(name)) continue;
  for (const column of Object.keys(table.columns)) lines.push(`snapshot\t${name}.${column}`);
}

console.log(lines.sort().join("\n"));
