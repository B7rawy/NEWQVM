import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";

/**
 * Allowed roles for a route. Platform staff (is_internal) always pass; company/vendor users
 * pass only if their resolved tenant role is in the list. Empty/absent = any authenticated user.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
