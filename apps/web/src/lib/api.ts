/**
 * Single API client. Adds the JWT and the active-workspace header (X-Tenant) to every call.
 *
 * STORAGE RULE: every session key is written to BOTH localStorage and a cross-subdomain cookie, and
 * read COOKIE-FIRST. localStorage is per-origin, so on the apex↔subdomain hops that "view as"
 * performs a stale same-origin copy would otherwise outrank the value just written elsewhere.
 */
import { currentSubdomain, getCookie, setSharedCookie } from "./tenant";

// Production always talks to the same origin (nginx proxies /api). Dev hits the local API.
// `||` (not `??`) so an unset OR empty VITE_API_URL both fall through to the mode default.
const BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "" : "http://localhost:4000");

const TOKEN_KEY = "qvm_token";
const WS_KEY = "qvm_ws";
const ENV_KEY = "qvm_env";
const REAL_KEY = "qvm_real_token";

export const auth = {
  // Token lives in localStorage AND a cross-subdomain cookie, so a session started on the apex
  // (or another workspace subdomain) carries over to <slug>.easycarty.store seamlessly.
  token: () => getCookie(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY),
  setToken: (t: string | null) => {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
    setSharedCookie(TOKEN_KEY, t);
  },
  // On a workspace subdomain the URL is the source of truth; else fall back to the stored choice.
  workspace: () => currentSubdomain() ?? getCookie(WS_KEY) ?? localStorage.getItem(WS_KEY),
  setWorkspace: (slug: string | null) => {
    if (slug) localStorage.setItem(WS_KEY, slug);
    else localStorage.removeItem(WS_KEY);
    setSharedCookie(WS_KEY, slug); // per-origin storage alone would carry the ADMIN's workspace over
  },
  // Same rule as the rest: cookie-first, so choosing Sandbox on the apex is still Sandbox after the
  // hop to <slug>.easycarty.store. A localStorage-only copy silently reverted to Live on every hop —
  // and reverting to Live is the one direction that must never happen by accident (ADR-0012).
  environment: (): "live" | "sandbox" =>
    (getCookie(ENV_KEY) ?? localStorage.getItem(ENV_KEY)) === "sandbox" ? "sandbox" : "live",
  setEnvironment: (e: "live" | "sandbox" | null) => {
    if (e) localStorage.setItem(ENV_KEY, e);
    else localStorage.removeItem(ENV_KEY);
    setSharedCookie(ENV_KEY, e);
  },
  // "view as": the real admin token is stashed while impersonating so we can return to it. It MUST
  // live in the cross-subdomain cookie too — impersonation routinely moves you between the apex and
  // a workspace subdomain, and a localStorage-only copy would be lost on the way (making "Back to
  // admin" silently do nothing).
  realToken: () => getCookie(REAL_KEY) ?? localStorage.getItem(REAL_KEY),
  setRealToken: (t: string | null) => {
    if (t) localStorage.setItem(REAL_KEY, t);
    else localStorage.removeItem(REAL_KEY);
    setSharedCookie(REAL_KEY, t);
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * `opts.tenant` targets ONE request at a workspace without switching the app into it. Platform staff
 * administer many workspaces from one screen (the flow builder is the first), and making them hop
 * into each workspace to configure it — losing the admin sidebar every time — is the wrong shape.
 * The server already authorises this: AuthGuard lets internal staff name any workspace via X-Tenant
 * and still requires a real membership/link for everyone else, so this widens no access.
 */
export interface ReqOpts {
  tenant?: string | null;
}

async function request<T>(method: string, path: string, body?: unknown, opts?: ReqOpts): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = auth.token();
  if (token) headers.authorization = `Bearer ${token}`;
  const ws = opts?.tenant ?? auth.workspace();
  if (ws) headers["x-tenant"] = ws;
  headers["x-environment"] = auth.environment();

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.message ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string, o?: ReqOpts) => request<T>("GET", p, undefined, o),
  post: <T>(p: string, body?: unknown, o?: ReqOpts) => request<T>("POST", p, body, o),
  put: <T>(p: string, body?: unknown, o?: ReqOpts) => request<T>("PUT", p, body, o),
  patch: <T>(p: string, body?: unknown, o?: ReqOpts) => request<T>("PATCH", p, body, o),
  del: <T>(p: string, o?: ReqOpts) => request<T>("DELETE", p, undefined, o),
};
