import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { getContext } from "./request-context.js";
import { PLATFORM_ONLY_KEY, ROLES_KEY } from "./roles.decorator.js";

/**
 * Role gate. Runs AFTER AuthGuard (which populates req.ctx).
 *  - @PlatformOnly(): requires ctx.isInternal (Qparts platform staff). A membership role can never
 *    satisfy it — fixes the role-namespace collision (review #1 / ADR-0010).
 *  - @Roles(...company roles): platform staff pass; company/vendor pass only if their workspace
 *    role is listed.
 *  - neither: open to any authenticated user (still tenant-scoped by RLS).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const ctx = getContext(context.switchToHttp().getRequest<Request>());

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ONLY_KEY, targets);
    if (platformOnly) {
      if (ctx.isInternal) return true;
      throw new ForbiddenException("this action is restricted to platform staff");
    }

    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, targets);
    if (!allowed || allowed.length === 0) return true;
    if (ctx.isInternal) return true;
    if (ctx.role && allowed.includes(ctx.role)) return true;
    throw new ForbiddenException("insufficient role for this action");
  }
}
