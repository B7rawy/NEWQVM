import type { Request } from "express";
import { PlatformRole } from "@qvm/shared";

/** Resolved per-request identity + tenant, attached to req by middleware/guard. */
export interface RequestContext {
  userId: string | null;
  tenantSlug: string | null;
  tenantId: string | null;
  role: string | null;
  isInternal: boolean;
  /** Active data environment within the workspace (X-Environment header; default 'live'). */
  environment: "live" | "sandbox";
  /** The real actor's user id when this request is impersonating ('view as'); null otherwise. */
  impersonatorId: string | null;
}

/** Read the requested data environment from the X-Environment header (default 'live'). */
export function resolveEnvironment(req: Request): "live" | "sandbox" {
  return (req.header("x-environment") ?? "").trim().toLowerCase() === "sandbox" ? "sandbox" : "live";
}

const PLATFORM_ROLES = new Set<string>(Object.values(PlatformRole));

/** A membership role is "internal" (platform staff) if it is a platform-tier role. */
export function isInternalRole(role: string | null | undefined): boolean {
  return role != null && PLATFORM_ROLES.has(role);
}

const RESERVED_SUBDOMAINS = new Set(["www", "app", "api", "admin", "static", "assets"]);

/**
 * Resolve the tenant slug. The SUBDOMAIN is authoritative (`riyadh.easycarty.store` → `riyadh`);
 * the X-Tenant header is the fallback for the apex domain and local dev (no subdomains). Reserved
 * subdomains (www/app/api…) are treated as the apex, not a tenant.
 */
export function resolveTenantSlug(req: Request, rootDomain: string): string | null {
  const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
  if (host && host.endsWith(`.${rootDomain}`)) {
    const sub = host.slice(0, host.length - rootDomain.length - 1);
    if (sub && !sub.includes(".") && !RESERVED_SUBDOMAINS.has(sub)) return sub;
  }
  const header = req.header("x-tenant");
  if (header) return header.trim().toLowerCase();
  return null;
}

export function getContext(req: Request): RequestContext {
  return (req as Request & { ctx?: RequestContext }).ctx ?? {
    userId: null,
    tenantSlug: null,
    tenantId: null,
    role: null,
    isInternal: false,
    environment: "live",
    impersonatorId: null,
  };
}
