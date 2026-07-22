import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, auth } from "./api";

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
    let slug = auth.workspace();
    if (!slug || !res.workspaces.some((w) => w.slug === slug)) {
      slug = res.workspaces[0]?.slug ?? null;
      auth.setWorkspace(slug);
      setActiveSlug(slug);
    }
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
    if (slug) await loadMe();
  }
  function logout() {
    auth.setToken(null);
    auth.setWorkspace(null);
    setAuthed(false);
    setMe(null);
    setWorkspaces([]);
    setActiveSlug(null);
  }
  async function switchWorkspace(slug: string) {
    auth.setWorkspace(slug);
    setActiveSlug(slug);
    await loadMe();
  }
  function setEnvironment(e: "live" | "sandbox") {
    auth.setEnvironment(e);
    setEnvironmentState(e);
  }

  return (
    <Ctx.Provider
      value={{ authed, me, workspaces, activeSlug, environment, login, logout, switchWorkspace, setEnvironment }}
    >
      {children}
    </Ctx.Provider>
  );
}
