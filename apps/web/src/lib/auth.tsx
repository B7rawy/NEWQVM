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
  counterpartyType: string | null; // QNEW-71: individual | company (drives the upgrade option)
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
    // The URL is only authoritative if this user can actually reach that workspace. After a
    // "view as" the host may still be the ADMIN's last subdomain, which the impersonated user has
    // no access to — trusting it would show a workspace that isn't theirs (and 403 every call).
    if (sub && res.workspaces.some((w) => w.slug === sub)) {
      setActiveSlug(sub);
      return sub;
    }
    if (sub) {
      // wrong host for this account → drop the stale choice and let the rules below pick.
      auth.setWorkspace(null);
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
      .catch(() => {
        // A failed boot is usually "this session cannot use THIS HOST", not "these credentials are
        // bad" — so recover in that order instead of destroying the session:
        if (auth.realToken()) return stopImpersonating(); // borrowed session → back to the admin
        if (subdomainMode() && currentSubdomain()) {
          // stuck on a workspace subdomain we have no access to → drop it and retry on the apex
          auth.setWorkspace(null);
          window.location.href = apexUrl("/");
          return;
        }
        logout();
      });
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
    // setToken/setWorkspace/setRealToken(null) each clear BOTH the per-origin copy and the shared
    // cookie — otherwise a live admin JWT would linger in another origin's localStorage.
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
    let res: { token: string };
    try {
      res = await api.post<{ token: string }>("/admin/impersonate", { userId });
    } catch (e) {
      // No call site handles this; without a message a refusal is indistinguishable from a bug.
      window.alert(`Can't view as this user: ${(e as Error).message}`);
      return;
    }
    if (!auth.realToken()) auth.setRealToken(auth.token()); // stash the real admin token once
    auth.setToken(res.token);
    auth.setWorkspace(null); // the impersonated user's own default workspace resolves on load

    // Land on a host the TARGET can actually use. Staying on the admin's current subdomain is the
    // root of "wrong workspace at the top" and of 403s that make Back-to-admin look broken: the
    // target may have no access to it. The apex always works, and settleHome() then forwards a
    // workspace user to their own subdomain.
    if (subdomainMode() && currentSubdomain()) window.location.href = apexUrl("/");
    else window.location.href = "/";
  }
  function stopImpersonating() {
    // Record the end while the BORROWED token is still active (fire-and-forget: the audit trail
    // must not be able to block the way out).
    void api.post("/admin/impersonate/stop", {}).catch(() => {});
    const real = auth.realToken();
    if (real) {
      auth.setToken(real);
      auth.setRealToken(null);
      auth.setWorkspace(null);
    } else {
      // No stash (expired cookie / cleared storage): never strand the user inside a borrowed
      // session — end it, so they land on the sign-in page instead of a dead "Back to admin".
      logout();
    }
    // Return to the apex, not the impersonated user's subdomain — the admin's own home is unscoped
    // and the borrowed subdomain may not even be one they were working in.
    if (subdomainMode() && currentSubdomain()) window.location.href = apexUrl("/");
    else window.location.href = "/";
  }

  return (
    <Ctx.Provider
      value={{ authed, me, workspaces, activeSlug, environment, login, signup, refreshMe, logout, switchWorkspace, setEnvironment, impersonate, stopImpersonating }}
    >
      {children}
    </Ctx.Provider>
  );
}
