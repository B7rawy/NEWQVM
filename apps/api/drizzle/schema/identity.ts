import { pgTable, text, uuid, index, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { audit, isActive, pk } from "./_shared";
import { membershipRole, platformRole } from "./enums";
import { tenants } from "./tenancy";
import { workshopBranches } from "./org";

/**
 * Identity. Users are GLOBAL (no tenant_id) so one person can belong to multiple workspaces,
 * and a vendor user can serve multiple tenants (ADR-0008). Access to a workspace is granted
 * via `tenant_memberships`; vendor-portal access via vendor_users (see vendors.ts).
 */

/** Global user account. Auth is self-hosted (argon2 password hash + JWT). */
export const users = pgTable(
  "users",
  {
    id: pk(),
    email: text("email").notNull(),
    passwordHash: text("password_hash"), // argon2; null until activated via invite
    fullName: text("full_name").notNull(),
    phone: text("phone"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

/**
 * Platform staff (Qparts internal). A row here = the user oversees ALL workspaces
 * (drives app.is_internal). Global (no tenant_id) — see ADR-0010.
 */
export const platformMembers = pgTable(
  "platform_members",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: platformRole("role").notNull(),
    isActive: isActive(),
    ...audit,
  },
  (t) => [uniqueIndex("platform_members_user_uq").on(t.userId)],
);

/**
 * Membership of a user in a workspace, with their role there. RLS-scoped by tenant_id.
 * `workshopBranchId` is set for workshop (client) users, null for platform staff.
 */
export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRole("role").notNull(),
    workshopBranchId: uuid("workshop_branch_id").references(() => workshopBranches.id),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    unique("tenant_memberships_tenant_user_role_uq").on(t.tenantId, t.userId, t.role),
    index("tenant_memberships_tenant_idx").on(t.tenantId),
    index("tenant_memberships_user_idx").on(t.userId),
    index("tenant_memberships_branch_idx").on(t.workshopBranchId),
  ],
);
