/** Single API client. Adds the JWT and the active-workspace header (X-Tenant) to every call. */
const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const TOKEN_KEY = "qvm_token";
const WS_KEY = "qvm_ws";
const ENV_KEY = "qvm_env";

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY)),
  workspace: () => localStorage.getItem(WS_KEY),
  setWorkspace: (slug: string | null) =>
    slug ? localStorage.setItem(WS_KEY, slug) : localStorage.removeItem(WS_KEY),
  environment: (): "live" | "sandbox" => (localStorage.getItem(ENV_KEY) === "sandbox" ? "sandbox" : "live"),
  setEnvironment: (e: "live" | "sandbox") => localStorage.setItem(ENV_KEY, e),
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
