import { applyDecorators, SetMetadata } from "@nestjs/common";

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

/**
 * ONE ROUTE ON A @PlatformOnly() CONTROLLER THAT WORKSPACE PEOPLE MAY ALSO USE.
 *
 * The failure this exists to fix: WorkflowController carries @PlatformOnly() at class level because
 * almost all of it is flow AUTHORING, but two of its routes are not authoring at all — My Work and
 * claiming a record. Custody assigns work to tenant_memberships roles (company_admin,
 * branch_manager, service_advisor), so the people the queue is FOR were the only people who could
 * not open it.
 *
 * WHY OPT OUT PER ROUTE RATHER THAN MOVING @PlatformOnly() DOWN ONTO EACH AUTHORING ROUTE. Both
 * would work today; only this one keeps failing safely. RolesGuard reads the metadata with
 * getAllAndOverride([handler, class]) — the handler's value wins, so writing `false` here cancels
 * the class's `true` for exactly this route. A route added to that controller tomorrow by somebody
 * who has not read this comment therefore inherits the platform-only door and is shut, which is the
 * correct direction for a mistake about a rules engine to fail in.
 *
 * The role list is NOT optional. Cancelling the platform door without naming who may come through
 * would leave the route open to any authenticated session — including a vendor's and a workshop's —
 * on a controller whose entire subject is the workspace's internal work queue.
 */
export const WorkspaceRoute = (...roles: string[]) =>
  applyDecorators(SetMetadata(PLATFORM_ONLY_KEY, false), Roles(...roles));
