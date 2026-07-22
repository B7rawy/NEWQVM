import { SetMetadata } from "@nestjs/common";

export const ROLES_KEY = "roles";
export const PLATFORM_ONLY_KEY = "platformOnly";

/**
 * Allowed COMPANY roles for a route. Platform staff (is_internal) always pass; company/vendor
 * users pass only if their resolved tenant role is in the list. Empty/absent = any authed user.
 * NOTE: never list platform-tier role names here (they collide with membership_role values) —
 * use @PlatformOnly() for internal-only actions instead.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Internal-only action: requires the caller to be Qparts platform staff (a platform_members row →
 * ctx.isInternal). A company/vendor membership role can never satisfy this (ADR-0010).
 */
export const PlatformOnly = () => SetMetadata(PLATFORM_ONLY_KEY, true);
