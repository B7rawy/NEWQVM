/**
 * Subdomain ↔ workspace mapping.
 *
 * Production: each workspace lives at `<slug>.easycarty.store`. The subdomain IS the active
 * workspace (the backend also resolves the tenant from it). The apex (`easycarty.store`) is the
 * login/landing surface; after a workspace user signs in they're sent to their subdomain, and the
 * auth token is shared across subdomains via a cookie scoped to the registrable domain.
 *
 * Local dev (`localhost`): no subdomains — everything stays header-based (unchanged behaviour).
 */

const RESERVED = new Set(["www", "app", "api", "admin", "static", "assets"]);

/** The registrable root domain (e.g. "easycarty.store"), or null on localhost / bare IP (dev). */
export function rootDomain(): string | null {
  const h = window.location.hostname;
  if (h === "localhost" || h.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return null;
  const parts = h.split(".");
  if (parts.length < 2) return null;
  return parts.slice(-2).join(".");
}

/** True when we're on a real domain that supports subdomain-per-workspace (i.e. not local dev). */
export function subdomainMode(): boolean {
  return rootDomain() !== null;
}

/** The workspace slug encoded in the current subdomain, or null (apex / reserved / dev). */
export function currentSubdomain(): string | null {
  const root = rootDomain();
  if (!root) return null;
  const h = window.location.hostname;
  if (h === root) return null; // apex
  const sub = h.slice(0, h.length - root.length - 1);
  if (!sub || sub.includes(".") || RESERVED.has(sub)) return null;
  return sub.toLowerCase();
}

/** Absolute URL of a workspace's subdomain app. */
export function workspaceUrl(slug: string, path = "/"): string {
  const root = rootDomain();
  return `${window.location.protocol}//${slug}.${root}${path}`;
}

/**
 * Is a workspace subdomain actually reachable? Used to gate the post-login redirect so nothing
 * breaks before the wildcard DNS (`*.easycarty.store`) is live — if the subdomain doesn't resolve
 * yet, we simply stay on the apex (header mode). Self-heals the moment the DNS record exists.
 */
export async function subdomainReachable(slug: string): Promise<boolean> {
  try {
    await fetch(workspaceUrl(slug, "/"), { mode: "no-cors", signal: AbortSignal.timeout(2500) });
    return true;
  } catch {
    return false;
  }
}

/** Cookie domain (".easycarty.store") so the token is shared across every workspace subdomain. */
function cookieDomain(): string | null {
  const root = rootDomain();
  return root ? `.${root}` : null;
}

/** Persist a value in a cross-subdomain cookie (used for the auth token). No-op on localhost. */
export function setSharedCookie(name: string, value: string | null): void {
  const domain = cookieDomain();
  if (!domain) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    value === null
      ? `${name}=; domain=${domain}; path=/; max-age=0; SameSite=Lax${secure}`
      : `${name}=${encodeURIComponent(value)}; domain=${domain}; path=/; max-age=${60 * 60 * 24}; SameSite=Lax${secure}`;
}

export function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
