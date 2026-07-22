import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { getContext } from "./request-context.js";
import { ROLES_KEY } from "./roles.decorator.js";

/**
 * Role gate. Runs AFTER AuthGuard (which populates req.ctx). Platform staff pass everything;
 * company/vendor users pass only if their resolved workspace role is allowed. No @Roles = open
 * to any authenticated user (still tenant-scoped by RLS).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed || allowed.length === 0) return true;

    const ctx = getContext(context.switchToHttp().getRequest<Request>());
    if (ctx.isInternal) return true;
    if (ctx.role && allowed.includes(ctx.role)) return true;
    throw new ForbiddenException("insufficient role for this action");
  }
}
