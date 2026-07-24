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
  activationStatus: string | null; // QNEW-71: pending self-registration → active
  impersonating: boolean;
  impersonatorName: string | null;
}

export interface SignupDto {
  kind: "vendor" | "workshop";
  fullName: string;
  email: string;
  password: string;
  mobile?: string;
}

interface AuthState {
  authed: boolean;
  me: Me | null;
  workspaces: Workspace[];
  activeSlug: string | null;
  environment: "live" | "sandbox";
  login: (email: string, password: string) => Promise<void>;
  signup: (dto: SignupDto) => Promise<void>;
  refreshMe: () => Promise<void>;
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

  /**
   * Settle the user on their correct home AFTER the active workspace is resolved. The boot/login
   * `/me` is fetched before a workspace is chosen, so for a workspace user it comes back with
   * `role: null` (no tenant context). This heals that:
   *   - a workspace user on the apex is sent to their workspace subdomain (tenant-correct home);
   *   - if we stay on the apex (subdomain not reachable yet) and a workspace was auto-selected,
   *     re-resolve `/me` so the workspace role (company_admin, …) is reflected in the nav.
   * Platform/vendor/workshop personas are cross-workspace and stay on the apex.
   * Returns true when navigating away (caller should stop).
   */
  async function settleHome(meData: Me, slug: string | null): Promise<boolean> {
    if (slug && subdomainMode() && meData.persona === "workspace" && currentSubdomain() !== slug) {
      if (await subdomainReachable(slug)) {
        window.location.href = workspaceUrl(slug);
        return true;
      }
    }
    if (slug && !meData.role && !currentSubdomain()) await loadMe();
    return false;
  }

  useEffect(() => {
    if (!authed) return;
    loadMe()
      .then(async (m) => {
        const slug = await loadWorkspaces(m.isInternal);
        await settleHome(m, slug);
      })
      .catch(() => logout());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string }>("/auth/login", { email, password });
    auth.setToken(res.token);
    setAuthed(true);
    const meData = await loadMe();
    const slug = await loadWorkspaces(meData.isInternal);
    await settleHome(meData, slug);
  }
  /** Self-registration (QNEW-71): create a counterparty account and sign in, landing on its portal. */
  async function signup(dto: SignupDto) {
    const res = await api.post<{ token: string }>("/auth/signup", dto);
    auth.setToken(res.token);
    setAuthed(true);
    const meData = await loadMe();
    const slug = await loadWorkspaces(meData.isInternal);
    await settleHome(meData, slug);
  }
  /** Re-fetch /me (e.g. after activation flips activationStatus pending → active). */
  async function refreshMe() {
    await loadMe();
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
      value={{ authed, me, workspaces, activeSlug, environment, login, signup, refreshMe, logout, switchWorkspace, setEnvironment, impersonate, stopImpersonating }}
    >
      {children}
    </Ctx.Provider>
  );
}
