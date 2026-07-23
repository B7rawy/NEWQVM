import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, auth } from "./api";
import { subdomainMode, currentSubdomain, workspaceUrl, apexUrl, subdomainReachable } from "./tenant";

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  is_sandbox: boolean;
  role: string | null;
}
import type { Persona } from "../nav";

interface Me {
  user: { id: string; email: string; full_name: string } | null;
  role: string | null;
  isInternal: boolean;
  platformRole: string | null;
  isVendor: boolean;
  persona: Persona;
  impersonating: boolean;
  impersonatorName: string | null;
}

interface AuthState {
  authed: boolean;
  me: Me | null;
  workspaces: Workspace[];
  activeSlug: string | null;
  environment: "live" | "sandbox";
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  switchWorkspace: (slug: string | null) => Promise<void>;
  setEnvironment: (e: "live" | "sandbox") => void;
  impersonate: (userId: string) => Promise<void>;
  stopImpersonating: () => void;
}

const Ctx = createContext<AuthState | null>(null);
export const useAuth = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside provider");
  return c;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(!!auth.token());
  const [me, setMe] = useState<Me | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(auth.workspace());
  const [environment, setEnvironmentState] = useState<"live" | "sandbox">(auth.environment());

  async function loadMe() {
    const m = await api.get<Me>("/me");
    setMe(m);
    return m;
  }
  /** Resolve the active workspace. Subdomain wins; on the apex a workspace is auto-picked, EXCEPT
   *  for platform staff who may run unscoped ("All workspaces" / system mode → activeSlug null). */
  async function loadWorkspaces(isInternal: boolean) {
    const res = await api.get<{ workspaces: Workspace[] }>("/workspaces");
    setWorkspaces(res.workspaces);
    const sub = currentSubdomain();
    if (sub) {
      setActiveSlug(sub);
      return sub;
    }
    const stored = auth.workspace();
    if (stored && res.workspaces.some((w) => w.slug === stored)) {
      setActiveSlug(stored);
      return stored;
    }
    if (isInternal) {
      // platform staff with no chosen workspace → unscoped system view
      auth.setWorkspace(null);
      setActiveSlug(null);
      return null;
    }
    const slug = res.workspaces[0]?.slug ?? null;
    auth.setWorkspace(slug);
    setActiveSlug(slug);
    return slug;
  }

  useEffect(() => {
    if (!authed) return;
    loadMe()
      .then((m) => loadWorkspaces(m.isInternal))
      .catch(() => logout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string }>("/auth/login", { email, password });
    auth.setToken(res.token);
    setAuthed(true);
    const meData = await loadMe();
    const slug = await loadWorkspaces(meData.isInternal);
    // A workspace user signing in on the apex is sent to their workspace subdomain (once wildcard
    // DNS is live). Platform/vendor/workshop are cross-workspace and stay on the apex.
    if (slug && subdomainMode() && meData.persona === "workspace" && currentSubdomain() !== slug) {
      if (await subdomainReachable(slug)) window.location.href = workspaceUrl(slug);
    }
  }
  function logout() {
    auth.setToken(null);
    auth.setWorkspace(null);
    auth.setRealToken(null);
    setAuthed(false);
    setMe(null);
    setWorkspaces([]);
    setActiveSlug(null);
  }
  async function switchWorkspace(slug: string | null) {
    // slug === null → unscoped "All workspaces" / system view (platform staff).
    if (subdomainMode()) {
      auth.setWorkspace(slug);
      window.location.href = slug ? workspaceUrl(slug) : apexUrl("/admin/workspaces");
      return;
    }
    auth.setWorkspace(slug);
    setActiveSlug(slug);
    await loadMe();
  }
  function setEnvironment(e: "live" | "sandbox") {
    auth.setEnvironment(e);
    setEnvironmentState(e);
  }
  async function impersonate(userId: string) {
    const res = await api.post<{ token: string }>("/admin/impersonate", { userId });
    if (!auth.realToken()) auth.setRealToken(auth.token()); // stash the real admin token once
    auth.setToken(res.token);
    auth.setWorkspace(null); // let the impersonated user's default workspace resolve
    window.location.href = "/";
  }
  function stopImpersonating() {
    const real = auth.realToken();
    if (real) {
      auth.setToken(real);
      auth.setRealToken(null);
      auth.setWorkspace(null);
    }
    window.location.href = "/";
  }

  return (
    <Ctx.Provider
      value={{ authed, me, workspaces, activeSlug, environment, login, logout, switchWorkspace, setEnvironment, impersonate, stopImpersonating }}
    >
      {children}
    </Ctx.Provider>
  );
}
