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
  environment: (): "live" | "sandbox" => (localStorage.getItem(ENV_KEY) === "sandbox" ? "sandbox" : "live"),
  setEnvironment: (e: "live" | "sandbox") => localStorage.setItem(ENV_KEY, e),
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = auth.token();
  if (token) headers.authorization = `Bearer ${token}`;
  const ws = auth.workspace();
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
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, body?: unknown) => request<T>("POST", p, body),
  patch: <T>(p: string, body?: unknown) => request<T>("PATCH", p, body),
};
