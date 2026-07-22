import { defineConfig } from "drizzle-kit";

// Single source of truth for schema + migrations (CONVENTIONS §DB-7, one-way migrations).
export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle/schema/index.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://qvm:change_me_in_local_env@localhost:5432/qvm_platform",
  },
  // We enable RLS + policies + sequences via hand-authored SQL appended to the generated
  // migration (drizzle generates DDL; RLS/policies live in migrations/_rls.sql — see phase-1 log).
  verbose: true,
  strict: true,
});
