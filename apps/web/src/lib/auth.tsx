import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, auth } from "./api";
import { subdomainMode, currentSubdomain, workspaceUrl } from "./tenant";

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
  switchWorkspace: (slug: string) => Promise<void>;
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

  async function loadWorkspaces() {
    const res = await api.get<{ workspaces: Workspace[] }>("/workspaces");
    setWorkspaces(res.workspaces);
    // On a workspace subdomain the URL is the source of truth — never override it.
    const sub = currentSubdomain();
    if (sub) {
      setActiveSlug(sub);
      return sub;
    }
    let slug = auth.workspace();
    if (!slug || !res.workspaces.some((w) => w.slug === slug)) {
      slug = res.workspaces[0]?.slug ?? null;
      auth.setWorkspace(slug);
    }
    setActiveSlug(slug);
    return slug;
  }
  async function loadMe() {
    setMe(await api.get<Me>("/me"));
  }

  useEffect(() => {
    if (!authed) return;
    loadWorkspaces()
      .then(() => loadMe())
      .catch(() => logout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string }>("/auth/login", { email, password });
    auth.setToken(res.token);
    setAuthed(true);
    const slug = await loadWorkspaces();
    const meData = slug ? await api.get<Me>("/me") : null;
    if (meData) setMe(meData);
    // A workspace user signing in on the apex is sent to their workspace subdomain.
    // (Platform / vendor / workshop are cross-workspace and stay on the apex.)
    if (meData && slug && subdomainMode() && meData.persona === "workspace" && currentSubdomain() !== slug) {
      window.location.href = workspaceUrl(slug);
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
  async function switchWorkspace(slug: string) {
    // In subdomain mode, switching workspace = navigating to that workspace's subdomain.
    if (subdomainMode()) {
      auth.setWorkspace(slug);
      window.location.href = workspaceUrl(slug);
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
