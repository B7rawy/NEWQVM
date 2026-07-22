import type { Request } from "express";
import { PlatformRole } from "@qvm/shared";

/** Resolved per-request identity + tenant, attached to req by middleware/guard. */
export interface RequestContext {
  userId: string | null;
  tenantSlug: string | null;
  tenantId: string | null;
  role: string | null;
  isInternal: boolean;
}

const PLATFORM_ROLES = new Set<string>(Object.values(PlatformRole));

/** A membership role is "internal" (platform staff) if it is a platform-tier role. */
export function isInternalRole(role: string | null | undefined): boolean {
  return role != null && PLATFORM_ROLES.has(role);
}

/** Extract the tenant slug from the subdomain, or the X-Tenant header (local/dev convenience). */
export function resolveTenantSlug(req: Request, rootDomain: string): string | null {
  const header = req.header("x-tenant");
  if (header) return header.trim().toLowerCase();
  const host = (req.headers.host ?? "").split(":")[0];
  if (host && host.endsWith(`.${rootDomain}`)) {
    return host.slice(0, host.length - rootDomain.length - 1).toLowerCase() || null;
  }
  return null;
}

export function getContext(req: Request): RequestContext {
  return (req as Request & { ctx?: RequestContext }).ctx ?? {
    userId: null,
    tenantSlug: null,
    tenantId: null,
    role: null,
    isInternal: false,
  };
}
