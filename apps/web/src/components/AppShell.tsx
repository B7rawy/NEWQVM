import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import ErrorBoundary from "./ErrorBoundary";
import { useUnreadMessages, unreadLabel } from "../lib/unread";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Code2,
  Eye,
  FlaskConical,
  Globe,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { navForPersona, iconByName, MODULE_TAG, OWN_MODULE, type NavGroup, type Persona } from "../nav";
import { api } from "../lib/api";
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
  const unread = unreadLabel(useUnreadMessages());
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
  /**
   * THE SIDEBAR COMES FROM THE SERVER, because only the server knows which counterparties this
   * workspace has linked and which pages this role may see. The static tree in nav.tsx is kept as
   * the FALLBACK, not as dead code: if /nav fails — offline, a bad deploy, a 500 — a stale menu is
   * recoverable and an empty one is not, since with no links there is no way to navigate to safety.
   *
   * Previewing another portal deliberately keeps using the static tree. The preview is a client-side
   * "what does a vendor see" for platform staff, and /nav answers for who you ACTUALLY are — asking
   * it while previewing would return your own tree and make the switcher look broken.
   */
  const [served, setServed] = useState<NavGroup[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const { pathname } = useLocation();
  useEffect(() => {
    let live = true;
    api
      .get<{ groups: Array<{ heading: string; items: Array<{ key: string; label: string; path: string; icon: string; soon: boolean; module?: string; children?: Array<{ key: string; label: string; path: string; icon: string; soon: boolean; module?: string }> }> }> }>(
        previewing ? `/nav?persona=${encodeURIComponent(persona)}` : "/nav",
      )
      .then((d) => {
        if (!live) return;
        setServed(d.groups.map((g) => ({
          heading: g.heading,
          items: g.items.map((i) => ({
            label: i.label, path: i.path, icon: iconByName(i.icon), soon: i.soon, module: i.module,
            children: (i.children ?? []).map((c) => ({ label: c.label, path: c.path, icon: iconByName(c.icon), soon: c.soon, module: c.module })),
          })),
        })));
      })
      .catch(() => { if (live) setServed(null); });
    return () => { live = false; };
    // re-resolves when the workspace or the environment changes: linking a counterparty in another
    // tab is picked up the next time either of those does, without a reload.
  }, [realPersona, persona, previewing, activeSlug, environment]);

  const fallback = navForPersona(persona, {
    isSuperAdmin: previewing ? true : me?.platformRole === "super_admin",
    isCompanyAdmin: previewing ? true : me?.role === "company_admin",
    unscoped: persona === "platform" && !activeSlug,
  });
  /**
   * The preview now asks the SERVER for the chosen portal instead of rendering the static tree. The
   * static tree knows nothing about which counterparties a workspace has linked, so previewing an
   * empty workspace showed New RFQ, Vendors, Providers and Internal — none of which a real manager
   * there would see. A preview that contradicts the product is worse than no preview.
   *
   * The static tree stays as the fallback for BOTH cases: if the call fails, a stale menu is
   * recoverable and an empty one is not.
   */
  const groups = served ?? fallback;
  // The heading travels with the first item of each group. The catalog has always had headings —
  // Procurement, Reports, Pricing, Directory, Setup — and the sidebar drew only a divider line, so
  // the grouping was invisible: three Workshop rows, a line, one more Workshop row, a line, two
  // Vendor rows reads as arbitrary until you can see WHY each line is there.
  const items = groups.flatMap((g, i) =>
    g.items.map((it, idx) => ({ ...it, groupStart: idx === 0, heading: g.heading, firstGroup: i === 0 })));

  /**
   * Whose page is this? Shown only when the answer is not "yours". Inside the vendor portal every
   * page is a vendor page and eighteen identical tags would be decoration; in a workspace menu the
   * same tag tells you at a glance that RFQs are here because a workshop is linked and Pricing
   * because a vendor is.
   */
  const own = OWN_MODULE[persona];
  const tagFor = (m?: string) => (m && m !== "core" && m !== own ? MODULE_TAG[m] : undefined);
  const Tag = ({ m }: { m?: string }) => {
    const t = tagFor(m);
    if (!t) return null;
    return (
      <span
        title={`This page is here because a ${t.label.toLowerCase()} is linked to this workspace`}
        // Sentence case, no letter-spacing. Uppercase + tracking made "Workshop" 66px wide, which
        // left the label 67px and cut single words like "Statements" that cannot wrap. The same word
        // set in normal case is ~48px and every label fits.
        className={`mt-[2px] shrink-0 self-start rounded px-1 py-px text-[9.5px] font-semibold leading-[1.45] ${t.tone}`}
      >
        {t.label}
      </span>
    );
  };
  const portalLabel =
    ({ platform: "Platform", workspace: "Workspace", vendor: "Vendor", workshop: "Workshop", service_provider: "Provider", internal: "Internal" } as const)[
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

        {/* nav */}
        <nav className="flex flex-col gap-0.5 py-1">
          {items.map((it) => {
            const kids = it.children ?? [];
            // Open when you are inside it, so landing on a child by URL never hides where you are.
            const inside = kids.some((c) => pathname === c.path || pathname.startsWith(c.path + "/"));
            const open = expanded[it.path] ?? inside;
            return (
            <div key={it.path}>
              {it.groupStart &&
                // Collapsed to 64px there is no room for a word, so the rail keeps the old divider —
                // and skips it above the first group, where it would draw a line under nothing.
                (collapsed ? (
                  !it.firstGroup && <div className="mx-3 my-2 h-px bg-line-2" />
                ) : (
                  <div className={`px-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted ${it.firstGroup ? "pt-1" : "mt-3 border-t border-line-2 pt-3"}`}>
                    {it.heading}
                  </div>
                ))}
              <NavLink
                to={it.path}
                title={collapsed ? it.label : undefined}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center" : ""}`}
              >
                <it.icon className="h-[17px] w-[17px] shrink-0" />
                {/* WRAPS, does not truncate. A 248px rail cannot hold "Purchase & Return Invoices"
                    plus a Workshop tag plus a Soon pill on one line — measured, the label got 67px of
                    the 166 it needs and rendered as "Purchas…". Truncating the name to make room for
                    a tag ABOUT that name is the wrong trade, so the label takes a second line and the
                    row grows only for the few that need it. */}
                {!collapsed && <span className="min-w-0 flex-1 leading-tight">{it.label}</span>}
                {!collapsed && <Tag m={it.module} />}
                {!collapsed && it.soon && <span className="mt-px shrink-0 self-start text-[10px] font-medium text-faint">Soon</span>}
                {!collapsed && kids.length > 0 && (
                  // A span, not a button: a <button> inside the <a> is invalid HTML and React will
                  // hand the click to the link anyway. stopPropagation keeps the chevron from
                  // navigating while still letting the label itself work as a link.
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={open ? `Collapse ${it.label}` : `Expand ${it.label}`}
                    aria-expanded={open}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((x) => ({ ...x, [it.path]: !open })); }}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setExpanded((x) => ({ ...x, [it.path]: !open })); } }}
                    className="-me-1 grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-[var(--panel-2)]"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 text-faint transition-transform ${open ? "" : "-rotate-90"}`} />
                  </span>
                )}
              </NavLink>
              {/* Children are hidden on the collapsed rail — there is no room to indent inside 64px,
                  and the parent's tooltip is the only affordance left. */}
              {!collapsed && open && kids.map((c) => (
                <NavLink
                  key={c.path}
                  to={c.path}
                  className={({ isActive }) => `nav-item ms-4 ps-4 ${isActive ? "active" : ""}`}
                >
                  <c.icon className="h-[15px] w-[15px] shrink-0" />
                  <span className="min-w-0 flex-1 leading-tight">{c.label}</span>
                  <Tag m={c.module} />
                  {c.soon && <span className="shrink-0 text-[10px] font-medium text-faint">Soon</span>}
                </NavLink>
              ))}
            </div>
          );})}
        </nav>

        {/* bottom */}
        <div className="mt-auto border-t border-line-2 py-1.5">
          {/* Deliberately NOT a nav row: this is the doorway to a separate portal, so it should not
              read as one more page in the list. It gets its own treatment and collapses to a single
              glyph like everything else. */}
          <div className={collapsed ? "px-2 pb-1.5" : "px-2.5 pb-1.5"}>
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
                <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md bg-accent text-white">
                  <MessagesSquare className="h-[15px] w-[15px]" />
                  {/* Anchored to the tile, not the row, so it survives the collapsed sidebar where the
                      label is gone and the tile is all that is left. */}
                  {unread && (
                    <span className="absolute -right-1.5 -top-1.5 grid h-[17px] min-w-[17px] place-items-center rounded-full border-2 border-panel bg-navy px-1 text-[10px] font-bold leading-none text-white">
                      {unread}
                    </span>
                  )}
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold leading-tight text-ink">
                      Communications
                    </span>
                    {/* The badge counts IN-APP notifications, which is what this button now opens.
                        Leaving the old "WhatsApp & Gmail" subtitle here would have pointed a real
                        number at two channels that are still not connected. */}
                    <span className="block truncate text-[11px] leading-tight text-muted">
                      Notifications &amp; channels
                    </span>
                  </span>
                )}
                {!collapsed &&
                  (unread ? (
                    <span className="shrink-0 rounded-full bg-navy px-1.5 py-0.5 text-[10.5px] font-bold leading-none text-white">
                      {unread}
                    </span>
                  ) : (
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-faint group-hover:text-accent" />
                  ))}
              </NavLink>
            </div>
          {/* The MCP pill. It is the one thing in this sidebar announcing itself, so it has to survive
              the collapsed rail too — an announcement only the wide sidebar can make is invisible to
              anybody who works collapsed. Wide: a pill beside the label. Collapsed: the same accent
              as a dot on the icon's corner, which is all the room there is. */}
          <NavLink
            to="/developers"
            title={collapsed ? "Developers — MCP" : undefined}
            className={({ isActive }) => `nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center" : ""}`}
          >
            <span className="relative flex shrink-0">
              <Code2 className="h-[17px] w-[17px]" />
              {collapsed && (
                <span className="absolute -right-1 -top-0.5 h-[7px] w-[7px] rounded-full bg-[var(--chip-red-fg)] ring-2 ring-[var(--panel)]" />
              )}
            </span>
            {!collapsed && (
              <>
                <span>Developers</span>
                <span className="ms-auto shrink-0 rounded-full bg-[var(--chip-red-bg)] px-1.5 py-[3px] text-[9.5px] font-bold uppercase leading-none tracking-[0.06em] text-[var(--chip-red-fg)]">
                  MCP
                </span>
              </>
            )}
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

      {/* min-h-0 is load-bearing, not tidying. A flex item defaults to min-height:auto, so without it
          this column grows to its content instead of to the grid row, <main>'s overflow-auto never
          has a height to scroll within, and the DOCUMENT scrolls instead — taking the sidebar and
          the header with it. It only shows up once a page is taller than the viewport, which is why
          it survived this long. */}
      <div className="flex min-h-0 min-w-0 flex-col">
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
                <option value="internal">Internal (back office)</option>
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
