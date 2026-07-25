import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";
import {
  ChevronsUpDown,
  Search,
  Settings,
  Code2,
  MessagesSquare,
  ArrowUpRight,
  Check,
  Eye,
  Sun,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Globe,
  FlaskConical,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { navForPersona, type Persona } from "../nav";
import ActivationBanner from "./ActivationBanner";
import UpgradeBanner from "./UpgradeBanner";

/** Friendly labels for the raw role codes shown in the top bar. */
const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admin",
  staff: "Staff",
  account_manager: "Account manager",
  purchasing: "Purchasing",
  part_extractor: "Part extractor",
  finance_manager: "Finance manager",
  pricing_supervisor: "Pricing supervisor",
  company_admin: "Company admin",
  branch_manager: "Branch manager",
  service_advisor: "Service advisor",
  vendor_admin: "Vendor admin",
  vendor_user: "Vendor user",
  vendor: "Vendor",
  workshop: "Workshop",
};

/** Stripe-style shell: workspace switcher + search at the top of the sidebar, flat dense nav,
 *  settings pinned at the bottom. The rail collapses to an icon-only strip (persisted). */
export default function AppShell() {
  const { me, workspaces, activeSlug, environment, switchWorkspace, setEnvironment, logout, stopImpersonating } = useAuth();
  const active = workspaces.find((w) => w.slug === activeSlug);
  const [wsOpen, setWsOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("qvm_sidebar") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("qvm_sidebar", collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  // Portal preview — platform staff can preview any persona's sidebar (design aid; nav only).
  const realPersona: Persona = me?.persona ?? "workspace";
  const canPreview = !!me?.isInternal;
  const [previewPersona, setPreviewPersona] = useState<Persona | "">(() => {
    try {
      return (localStorage.getItem("qvm_portal_preview") as Persona) || "";
    } catch {
      return "";
    }
  });
  function changePreview(p: Persona | "") {
    setPreviewPersona(p);
    try {
      if (p) localStorage.setItem("qvm_portal_preview", p);
      else localStorage.removeItem("qvm_portal_preview");
    } catch {
      /* ignore */
    }
  }
  const previewing = canPreview && !!previewPersona && previewPersona !== realPersona;
  const persona: Persona = canPreview && previewPersona ? previewPersona : realPersona;
  const groups = navForPersona(persona, {
    isSuperAdmin: previewing ? true : me?.platformRole === "super_admin",
    isCompanyAdmin: previewing ? true : me?.role === "company_admin",
    unscoped: persona === "platform" && !activeSlug,
  });
  const items = groups.flatMap((g, i) => g.items.map((it, idx) => ({ ...it, groupStart: i > 0 && idx === 0 })));
  const portalLabel =
    ({ platform: "Platform", workspace: "Workspace", vendor: "Vendor", workshop: "Workshop", service_provider: "Provider" } as const)[
      persona
    ] ?? "Workspace";

  return (
    <div
      className={`grid h-full ${collapsed ? "grid-cols-[64px_1fr]" : "grid-cols-[248px_1fr]"} bg-appbg transition-[grid-template-columns] duration-200 ease-in-out`}
    >
      <aside className="flex min-w-0 flex-col border-r border-line bg-sidebar">
        {/* brand */}
        <div className={`flex items-center pb-1 pt-4 ${collapsed ? "justify-center px-0" : "gap-2 px-3.5"}`}>
          <img src="/qvm-logo.png" alt="QParts" className="h-6 w-auto shrink-0" />
          {!collapsed && (
            <>
              <span className="text-[17px] font-bold uppercase tracking-tight text-navy">Parts</span>
              <span className="ml-auto rounded-full bg-accent-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
                {portalLabel}
              </span>
            </>
          )}
        </div>

        {/* workspace switcher */}
        <div className={`relative pb-1.5 pt-2 ${collapsed ? "px-2" : "px-2.5"}`}>
          <button
            onClick={() => setWsOpen((v) => !v)}
            title={collapsed ? active?.name ?? "Workspace" : undefined}
            className={
              collapsed
                ? "flex w-full items-center justify-center rounded-md border border-line bg-panel py-2 shadow-cardsm"
                : "flex w-full items-center gap-2.5 rounded-md border border-line bg-panel px-2.5 py-2 text-left shadow-cardsm"
            }
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-[11px] font-semibold text-white">
              {activeSlug ? active?.name?.[0] ?? "Q" : <Globe className="h-3.5 w-3.5" />}
            </span>
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-[12.5px] font-semibold text-ink">
                    {activeSlug ? active?.name ?? "Workspace" : persona === "platform" ? "Admin workspace" : `${portalLabel} account`}
                  </span>
                  <span className="block text-[10.5px] text-faint">
                    {activeSlug ? "Workspace" : persona === "platform" ? "Platform · system" : "Self-service"}
                  </span>
                </span>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-faint" />
              </>
            )}
          </button>
          {wsOpen && (
            <div
              className={
                collapsed
                  ? "absolute left-full top-2 z-30 ml-2 w-52 overflow-hidden rounded-lg border border-line bg-panel shadow-pop"
                  : "absolute inset-x-2.5 z-20 mt-1 overflow-hidden rounded-lg border border-line bg-panel shadow-pop"
              }
            >
              {/* Platform staff can leave every workspace and run the system-wide (unscoped) view. */}
              {me?.isInternal && (
                <button
                  onClick={() => {
                    switchWorkspace(null);
                    setWsOpen(false);
                  }}
                  className="flex w-full items-center gap-2 border-b border-line-2 px-3 py-2 text-left text-[13px] font-medium text-sub hover:bg-surface"
                >
                  <Globe className="h-4 w-4 shrink-0 text-muted" />
                  <span className="flex-1 truncate">Admin workspace</span>
                  {!activeSlug && <Check className="h-4 w-4 text-accent" />}
                </button>
              )}
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  onClick={() => {
                    switchWorkspace(w.slug);
                    setWsOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-sub hover:bg-surface"
                >
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.slug === activeSlug && <Check className="h-4 w-4 text-accent" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* search */}
        {collapsed ? (
          <div className="px-2 pb-2">
            <button
              onClick={() => setCollapsed(false)}
              title="Search"
              className="flex w-full items-center justify-center rounded-md border border-line-2 bg-surface py-1.5 text-faint transition hover:text-ink"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="px-2.5 pb-2">
            <div className="flex items-center gap-2 rounded-md border border-line-2 bg-surface px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-faint" />
              <span className="flex-1 text-[12.5px] text-faint">Search</span>
              <span className="rounded border border-line bg-panel px-1.5 text-[10.5px] text-faint">⌘K</span>
            </div>
          </div>
        )}

        {/* Communications — deliberately NOT a nav row.
            This is the doorway to a separate portal where a workspace connects its OWN WhatsApp and
            Gmail, so it should not read as one more page in the list. It is given its own treatment
            so the eye lands on it, and it collapses to a single glyph like everything else. */}
        <div className={collapsed ? "px-2 pt-1" : "px-2.5 pt-1"}>
          <NavLink
            to="/communications"
            title={collapsed ? "Communications" : undefined}
            className={({ isActive }) =>
              `group relative flex items-center overflow-hidden rounded-lg border transition ${
                collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2.5"
              } ${
                isActive
                  ? "border-accent bg-accent-50"
                  : "border-line-2 bg-surface hover:border-accent/40 hover:bg-accent-50/40"
              }`
            }
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-white">
              <MessagesSquare className="h-[15px] w-[15px]" />
            </span>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold leading-tight text-ink">
                  Communications
                </span>
                <span className="block truncate text-[11px] leading-tight text-muted">
                  WhatsApp &amp; Gmail
                </span>
              </span>
            )}
            {!collapsed && <ArrowUpRight className="h-4 w-4 shrink-0 text-faint group-hover:text-accent" />}
          </NavLink>
        </div>

        {/* nav */}
        <nav className="flex flex-col gap-0.5 py-1">
          {items.map((it) => (
            <div key={it.path}>
              {it.groupStart && <div className={`my-2 h-px bg-line-2 ${collapsed ? "mx-3" : "mx-4"}`} />}
              <NavLink
                to={it.path}
                title={collapsed ? it.label : undefined}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center" : ""}`}
              >
                <it.icon className="h-[17px] w-[17px] shrink-0" />
                {!collapsed && <span className="flex-1">{it.label}</span>}
                {!collapsed && it.soon && <span className="text-[10px] font-medium text-faint">Soon</span>}
              </NavLink>
            </div>
          ))}
        </nav>

        {/* bottom */}
        <div className="mt-auto border-t border-line-2 py-1.5">
          <NavLink
            to="/developers"
            title={collapsed ? "Developers" : undefined}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center" : ""}`}
          >
            <Code2 className="h-[17px] w-[17px] shrink-0" />
            {!collapsed && <span>Developers</span>}
          </NavLink>
          <NavLink
            to="/settings"
            title={collapsed ? "Settings" : undefined}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center" : ""}`}
          >
            <Settings className="h-[17px] w-[17px] shrink-0" />
            {!collapsed && <span>Settings</span>}
          </NavLink>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Sandbox must be impossible to miss: the whole point is that nothing here is real, and the
            expensive mistake is believing test data is production data (or the reverse). */}
        {environment === "sandbox" && (
          <div className="flex items-center gap-2.5 bg-amber-400 px-6 py-2 text-[13px] font-semibold text-[#5a4300]">
            <FlaskConical className="h-4 w-4" />
            <span>
              Sandbox — this is test data. Nothing you do here reaches real vendors, workshops or invoices.
            </span>
            <button
              onClick={() => {
                setEnvironment("live");
                window.location.reload();
              }}
              className="ml-auto rounded-md bg-[#5a4300]/15 px-3 py-1 text-[12px] font-semibold hover:bg-[#5a4300]/25"
            >
              Back to Live
            </button>
          </div>
        )}
        {me?.impersonating && (
          <div className="flex items-center gap-3 bg-[#0a2540] px-6 py-2 text-[13px] text-white">
            <Eye className="h-4 w-4" />
            <span>
              {me.impersonatorName ? <>{me.impersonatorName} viewing as </> : <>Viewing as </>}
              <b className="font-semibold">{me.user?.full_name}</b>
            </span>
            <button
              onClick={stopImpersonating}
              className="ml-auto rounded-md bg-white/15 px-3 py-1 text-[12px] font-semibold hover:bg-white/25"
            >
              ← Back to admin
            </button>
          </div>
        )}
        <header className="flex items-center gap-3 border-b border-line px-6 py-3">
          {/* collapse / expand the sidebar */}
          <button
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="grid h-8 w-8 place-items-center rounded-md border border-line bg-panel text-muted transition hover:bg-surface hover:text-ink"
          >
            {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </button>
          {/* Live ⇄ Sandbox environment toggle */}
          <div className="flex items-center overflow-hidden rounded-md border border-line text-[12px] font-semibold">
            {(["live", "sandbox"] as const).map((e) => (
              <button
                key={e}
                onClick={() => {
                  if (environment !== e) {
                    setEnvironment(e);
                    window.location.reload();
                  }
                }}
                className={
                  environment === e
                    ? e === "sandbox"
                      ? "bg-amber-400 px-3 py-1.5 text-[#5a4300]"
                      : "bg-accent px-3 py-1.5 text-white"
                    : "bg-panel px-3 py-1.5 text-muted hover:bg-surface"
                }
              >
                {e === "live" ? "Live" : "Sandbox"}
              </button>
            ))}
          </div>
          {canPreview && (
            <label className="flex items-center gap-1.5" title="Preview a portal's sidebar">
              <Eye className="h-3.5 w-3.5 text-faint" />
              <select
                value={previewPersona}
                onChange={(e) => changePreview(e.target.value as Persona | "")}
                className={`rounded-md border px-2 py-1 text-[12px] ${previewing ? "border-accent text-accent" : "border-line bg-panel text-muted"}`}
              >
                <option value="">My portal</option>
                <option value="platform">Platform</option>
                <option value="workspace">Workspace (manager)</option>
                <option value="vendor">Vendor</option>
                <option value="workshop">Workshop</option>
                <option value="service_provider">Provider</option>
              </select>
            </label>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              title={theme === "dark" ? "Light mode" : "Dark mode"}
              className="grid h-8 w-8 place-items-center rounded-md border border-line bg-panel text-muted transition hover:bg-surface hover:text-ink"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <span className="text-[12px] text-muted">
              {me?.user?.full_name}
              {(() => {
                const code = me?.isInternal ? me?.platformRole ?? "staff" : me?.role;
                return code ? ` · ${ROLE_LABEL[code] ?? code}` : "";
              })()}
            </span>
            <button onClick={logout} className="btn btn-sm">
              Sign out
            </button>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[12px] font-semibold text-white">
              {me?.user?.full_name?.split(" ").map((p) => p[0]).slice(0, 2).join("") ?? "?"}
            </span>
          </div>
        </header>
        <ActivationBanner />
        <UpgradeBanner />
        <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <ErrorBoundary resetKey={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
