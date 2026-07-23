import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ChevronsUpDown, Search, Settings, Code2, Check, Eye, Sun, Moon } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { navForPersona } from "../nav";

/** Stripe-style shell: workspace switcher + search at the top of the sidebar, flat dense nav,
 *  settings pinned at the bottom. QVM red is the accent. */
export default function AppShell() {
  const { me, workspaces, activeSlug, environment, switchWorkspace, setEnvironment, logout, stopImpersonating } = useAuth();
  const active = workspaces.find((w) => w.slug === activeSlug);
  const [wsOpen, setWsOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const persona = me?.persona ?? "workspace";
  const groups = navForPersona(persona, {
    isSuperAdmin: me?.platformRole === "super_admin",
    isCompanyAdmin: me?.role === "company_admin",
  });
  const items = groups.flatMap((g, i) => g.items.map((it, idx) => ({ ...it, groupStart: i > 0 && idx === 0 })));
  const portalLabel =
    persona === "platform" ? "Platform" : persona === "vendor" ? "Vendor" : "Workspace";

  return (
    <div className="grid h-full grid-cols-[248px_1fr] bg-appbg">
      <aside className="flex flex-col border-r border-line bg-sidebar">
        {/* brand */}
        <div className="flex items-center gap-2 px-3.5 pb-1 pt-4">
          <img src="/qvm-logo.png" alt="QParts" className="h-6 w-auto" />
          <span className="text-[17px] font-bold uppercase tracking-tight text-navy">Parts</span>
          <span className="ml-auto rounded-full bg-accent-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
            {portalLabel}
          </span>
        </div>
        {/* workspace switcher */}
        <div className="relative px-2.5 pb-1.5 pt-2">
          <button
            onClick={() => setWsOpen((v) => !v)}
            className="flex w-full items-center gap-2.5 rounded-md border border-line bg-panel px-2.5 py-2 text-left shadow-cardsm"
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[11px] font-semibold text-white">
              {active?.name?.[0] ?? "Q"}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12.5px] font-semibold text-ink">{active?.name ?? "Workspace"}</span>
              <span className="block text-[10.5px] text-faint">{active?.is_sandbox ? "Sandbox" : "Workspace"}</span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-faint" />
          </button>
          {wsOpen && (
            <div className="absolute inset-x-2.5 z-20 mt-1 overflow-hidden rounded-lg border border-line bg-panel shadow-pop">
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
        <div className="px-2.5 pb-2">
          <div className="flex items-center gap-2 rounded-md border border-line-2 bg-surface px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-faint" />
            <span className="flex-1 text-[12.5px] text-faint">Search</span>
            <span className="rounded border border-line bg-panel px-1.5 text-[10.5px] text-faint">⌘K</span>
          </div>
        </div>
        {/* nav */}
        <nav className="flex flex-col gap-0.5 py-1">
          {items.map((it) => (
            <div key={it.path}>
              {it.groupStart && <div className="mx-4 my-2 h-px bg-line-2" />}
              <NavLink to={it.path} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
                <it.icon className="h-[17px] w-[17px]" />
                <span className="flex-1">{it.label}</span>
                {it.soon && <span className="text-[10px] font-medium text-faint">Soon</span>}
              </NavLink>
            </div>
          ))}
        </nav>
        {/* bottom */}
        <div className="mt-auto border-t border-line-2 py-1.5">
          <NavLink to="/developers" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <Code2 className="h-[17px] w-[17px]" />
            <span>Developers</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
            <Settings className="h-[17px] w-[17px]" />
            <span>Settings</span>
          </NavLink>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        {me?.impersonating && (
          <div className="flex items-center gap-3 bg-[#0a2540] px-6 py-2 text-[13px] text-white">
            <Eye className="h-4 w-4" />
            <span>
              Viewing as <b className="font-semibold">{me.user?.full_name}</b>
              {me.impersonatorName ? ` — as ${me.impersonatorName}` : ""}
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
              {me?.isInternal ? " · staff" : me?.role ? ` · ${me.role}` : ""}
            </span>
            <button onClick={logout} className="btn btn-sm">
              Sign out
            </button>
            <span className="grid h-8 w-8 place-items-center rounded-full bg-accent text-[12px] font-semibold text-white">
              {me?.user?.full_name?.split(" ").map((p) => p[0]).slice(0, 2).join("") ?? "?"}
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
