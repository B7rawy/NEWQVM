import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Car,
  CheckCircle2,
  Clock,
  FilePlus2,
  Files,
  FileWarning,
  Filter,
  Inbox,
  Package,
  PackageCheck,
  RotateCcw,
  ShoppingCart,
  Store,
  Tag,
  Target,
  TrendingUp,
  Truck,
  XCircle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHero, Card, StatStrip, StatCard, Badge, statusTone, Spinner, EmptyState } from "../components/ui";
import {
  L, useProgress, WorkshopTab, PurchasingTab, SuppliersTab, type Lang,
} from "./ManagementOverview";
import { Wrench, ShoppingBag, Building2, Languages, LayoutDashboard } from "lucide-react";

/* ────────────────────────────────────────────────────────────────────────────
   Workspace Overview — a single workspace's procurement snapshot.

   REAL data (preserved from the original page): the /rfqs and /orders fetches,
   the derived KPI strip (open / awaiting / totals) and the "Recent RFQs" table
   whose rows deep-link to /rfqs/:id.

   Everything visual around them — the pipeline status grid, distribution donut,
   needs-attention alerts, conversion funnel, top vendors and the requests-vs-
   orders trend — is realistic inline MOCK data (SAR, Saudi cities, Toyota/Nissan
   plates, vendor names). No backend for those yet, no new deps. Charts are pure
   inline SVG / CSS. Colours use semantic tokens for structure; only chart series
   fills use fixed mid-tone hues that read on light AND dark panels.
──────────────────────────────────────────────────────────────────────────── */

interface Rfq {
  id: string;
  order_number: string;
  plate_number: string | null;
  status: string | null;
  items: number;
}
interface Order {
  id: string;
  order_number: string;
}

/* Categorical series colours — legible on light (#fff) and dark (#151b2b) alike. */
const C = {
  sky: "#38bdf8",
  amber: "#fbbf24",
  emerald: "#34d399",
  violet: "#a78bfa",
  teal: "#2dd4bf",
  rose: "#fb7185",
  orange: "#fb923c",
  navy: "#2f6f86",
  slate: "#94a3b8",
} as const;

type Accent = "sky" | "amber" | "emerald" | "violet" | "teal" | "rose" | "orange" | "slate";
const accentChip: Record<Accent, string> = {
  sky: "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
  teal: "bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300",
  rose: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
  orange: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-300",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
};

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");
const sar = new Intl.NumberFormat("en-US", { style: "currency", currency: "SAR", maximumFractionDigits: 0 });

/* ── count-up: shared 0→1 eased progress, restarts on resetKey change ──────── */
const ANIM_MS = 1100;
function useMountProgress(resetKey: string) {
  const [p, setP] = useState(0);
  const raf = useRef<number | null>(null);
  const done = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setP(1);
      return;
    }
    setP(0);
    const start = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ANIM_MS);
      setP(ease(t));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    done.current = setTimeout(() => setP(1), ANIM_MS + 60);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      if (done.current) clearTimeout(done.current);
    };
  }, [resetKey]);
  return p;
}

/* ── SectionCard — title + description + icon + optional actions ────────────── */
function SectionCard({
  title,
  description,
  icon,
  actions,
  delay = 0,
  className = "",
  children,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  actions?: ReactNode;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card pad={false} className={`ov-fade-up ${className}`} >
      <div style={{ animationDelay: `${delay}ms` }} className="ov-fade-up-inner">
        <div className="flex items-start gap-3 border-b border-line-2 px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface text-accent">{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink">{title}</div>
            {description && <div className="mt-0.5 text-[12px] text-muted">{description}</div>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
        <div className="p-5">{children}</div>
      </div>
    </Card>
  );
}

/* ── Sparkline — seeded decorative trend (NOT real history) ────────────────── */
function Sparkline({ seed, color }: { seed: number; color: string }) {
  const pts = useMemo(() => {
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const vals = Array.from({ length: 12 }, () => 6 + rnd() * 18);
    const max = Math.max(...vals);
    return vals.map((v, i) => `${(i / 11) * 100},${24 - (v / max) * 22}`).join(" ");
  }, [seed]);
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-full">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" opacity={0.7} />
    </svg>
  );
}

/* ── StatusCard — animated status KPI, clickable, seeded sparkline ─────────── */
function StatusCard({
  label,
  value,
  icon,
  accent,
  color,
  progress,
  delay,
  onClick,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  accent: Accent;
  color: string;
  progress: number;
  delay: number;
  onClick: () => void;
}) {
  const shown = Math.round(value * progress);
  return (
    <button
      onClick={onClick}
      className="card ov-fade-up group relative overflow-hidden p-4 text-left transition hover:-translate-y-0.5 hover:shadow-pop"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className="absolute inset-x-0 top-0 h-1 opacity-0 transition group-hover:opacity-100" style={{ backgroundColor: color }} />
      <div className="flex items-center justify-between gap-2">
        <span className={`grid h-9 w-9 place-items-center rounded-lg ${accentChip[accent]}`}>{icon}</span>
        <span className="text-[26px] font-semibold leading-none tracking-tight text-ink tnum">{fmtNum(shown)}</span>
      </div>
      <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-2 -mx-1">
        <Sparkline seed={value + label.length} color={color} />
      </div>
    </button>
  );
}

/* ── Donut — animated sweep, centre total + legend ─────────────────────────── */
function Donut({
  segments,
  centerLabel,
  progress,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string;
  progress: number;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const R = 70;
  const SW = 18;
  const CIRC = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row">
      <div className="relative shrink-0" style={{ width: 176, height: 176 }}>
        <svg viewBox="0 0 176 176" width={176} height={176} className="-rotate-90">
          <circle cx={88} cy={88} r={R} fill="none" stroke="var(--line)" strokeWidth={SW} />
          {segments.map((s) => {
            const frac = total > 0 ? s.value / total : 0;
            const len = frac * CIRC * progress;
            const dash = `${len} ${CIRC - len}`;
            const offset = -acc * CIRC * progress;
            acc += frac;
            return (
              <circle
                key={s.label}
                cx={88}
                cy={88}
                r={R}
                fill="none"
                stroke={s.color}
                strokeWidth={SW}
                strokeDasharray={dash}
                strokeDashoffset={offset}
                strokeLinecap="butt"
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[28px] font-semibold text-ink tnum">{fmtNum(total * progress)}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-2 self-stretch">
        {segments.map((s) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
          return (
            <li key={s.label} className="flex items-center gap-2 text-[12.5px]">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="flex-1 truncate text-sub">{s.label}</span>
              <span className="font-semibold text-ink tnum">{fmtNum(s.value)}</span>
              <span className="w-9 text-right text-faint tnum">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── Funnel — indexed horizontal bars, value in-bar, share % trailing ──────── */
function Funnel({
  stages,
  progress,
}: {
  stages: { label: string; value: number; color: string }[];
  progress: number;
}) {
  const total = stages.reduce((s, x) => s + x.value, 0) || 1;
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="space-y-4">
      {stages.map((s, i) => {
        const w = Math.max(s.value > 0 ? 8 : 0, Math.round((s.value / max) * 100 * progress));
        const share = Math.round((s.value / total) * 100);
        return (
          <div key={s.label} className="flex items-center gap-3">
            <div className="flex w-28 shrink-0 items-center gap-2 sm:w-36">
              <span className="text-[13px] font-semibold text-faint tnum">{String(i + 1).padStart(2, "0")}</span>
              <span className="truncate text-[12px] font-semibold text-sub">{s.label}</span>
            </div>
            <div className="relative h-7 flex-1 overflow-hidden rounded-lg bg-surface">
              <div
                className="flex h-full items-center justify-end rounded-lg px-2"
                style={{ width: `${w}%`, backgroundColor: s.color, transition: "width .7s ease-out" }}
              >
                <span className="text-[10px] font-semibold text-white tnum drop-shadow">{fmtNum(s.value)}</span>
              </div>
            </div>
            <span className="w-10 shrink-0 text-right text-[11px] text-faint tnum">{share}%</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── HBars — horizontal ranking bars with in-bar value + hint subline ──────── */
function HBars({
  rows,
  color,
  progress,
  fmt = fmtNum,
}: {
  rows: { label: string; value: number; hint?: string }[];
  color: string;
  progress: number;
  fmt?: (n: number) => string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => {
        const frac = r.value / max;
        const w = Math.max(r.value > 0 ? 10 : 0, frac * 100) * progress;
        return (
          <div key={r.label}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-[12.5px] font-medium text-sub">{r.label}</span>
              {r.hint && <span className="shrink-0 text-[11px] text-faint tnum">{r.hint}</span>}
            </div>
            <div className="h-6 w-full overflow-hidden rounded-md bg-surface">
              <div
                className="flex h-full items-center justify-end rounded-md px-2 text-[11px] font-semibold text-white tnum"
                style={{ width: `${w}%`, backgroundColor: color, transition: "width .7s ease-out" }}
              >
                {frac > 0.2 && <span>{fmt(r.value)}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── TrendColumns — vertical grouped columns, legend top, hover title ──────── */
function TrendColumns({
  series,
  categories,
  data,
  progress,
}: {
  series: { label: string; color: string }[];
  categories: string[];
  data: number[][]; // data[seriesIdx][catIdx]
  progress: number;
}) {
  const max = Math.max(1, ...data.flat());
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="flex h-48 items-end gap-3">
        {categories.map((cat, ci) => (
          <div key={cat} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
            <div className="flex h-full w-full items-end justify-center gap-1">
              {series.map((s, si) => {
                const v = data[si][ci];
                const h = (v / max) * 100 * progress;
                return (
                  <div
                    key={s.label}
                    title={`${s.label} · ${cat}: ${fmtNum(v)}`}
                    className="w-1/2 max-w-[24px] rounded-t"
                    style={{ height: `${h}%`, backgroundColor: s.color, transition: "height .7s ease-out" }}
                  />
                );
              })}
            </div>
            <span className="text-[11px] text-faint">{cat}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── QuickLink — navigation quick-link tile ────────────────────────────────── */
function QuickLink({
  title,
  subtitle,
  icon,
  accent,
  onClick,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  accent: Accent;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="card group flex items-center gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:shadow-pop"
    >
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl2 transition group-hover:scale-110 ${accentChip[accent]}`}>
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <div className="truncate text-[11.5px] text-muted">{subtitle}</div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </button>
  );
}

/* ── AlertRow — needs-attention item (raw value, not count-up) ─────────────── */
function AlertRow({
  label,
  value,
  icon,
  accent,
  onClick,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  accent: Accent;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl2 border border-line bg-panel p-3 text-left transition hover:-translate-y-0.5 hover:bg-surface"
    >
      <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${accentChip[accent]}`}>{icon}</span>
      <span className="flex-1 text-[12.5px] font-medium text-sub">{label}</span>
      <span className="text-[18px] font-semibold text-ink tnum">{value}</span>
    </button>
  );
}

/* ── Mock pipeline snapshot (no backend yet) ───────────────────────────────── */
const SNAP = {
  new_rfq: 24,
  processing: 18,
  priced: 15,
  confirmed: 12,
  delivered: 31,
  return_requests: 3,
  cancellation_requests: 2,
  missing_purchase_invoices: 5,
};

const TOP_VENDORS = [
  { name: "Al-Jazira Parts", value: 412000, orders: 38 },
  { name: "Gulf Auto Supply", value: 318000, orders: 31 },
  { name: "Modern Parts Co.", value: 286000, orders: 27 },
  { name: "Kingdom Supply", value: 198000, orders: 19 },
  { name: "Swift Auto Trading", value: 142000, orders: 14 },
];

const TREND_MONTHS = ["Feb", "Mar", "Apr", "May", "Jun", "Jul"];
const TREND_RFQS = [186, 204, 195, 232, 251, 268];
const TREND_ORDERS = [142, 168, 161, 198, 214, 231];

/**
 * THE DASHBOARD. One page, four tabs — Snapshot plus the three management reports.
 *
 * Every design board opened with the same blue note on its first row: "تحتاج دمج وتوحيد" across
 * Overview and Management Overview. They were two dashboards one click apart, each with its own
 * hero, its own date line and its own claim to be where your day starts. Nothing was deleted in
 * merging them — the Snapshot below is the live procurement view, and the three report bodies moved
 * here from ManagementOverview.tsx as tabs.
 *
 * The Snapshot tab needs a workspace to read from, so it is HIDDEN when none is selected: platform
 * staff looking across all workspaces land on Workshop Reports instead of an empty page full of
 * dashes. `defaultTab` exists for /management-overview, which still resolves so old links and the
 * unscoped platform menu keep working.
 */
type DashTab = "snapshot" | "workshop" | "purchasing" | "suppliers";

export default function Overview({ defaultTab }: { defaultTab?: DashTab } = {}) {
  const { activeSlug, me, workspaces } = useAuth();
  const nav = useNavigate();
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const canSnapshot = !!activeSlug;
  const [tab, setTab] = useState<DashTab>(defaultTab ?? (canSnapshot ? "snapshot" : "workshop"));
  const [lang, setLang] = useState<Lang>("EN");
  const reportProgress = useProgress(`${tab}-${lang}`);
  // A workspace can be deselected while you are standing on Snapshot; fall through rather than
  // render a page of dashes.
  const active: DashTab = tab === "snapshot" && !canSnapshot ? "workshop" : tab;
  const onReports = active !== "snapshot";
  const rtl = onReports && lang === "AR";

  const load = useCallback(async () => {
    const [r, o] = await Promise.all([
      api.get<{ rfqs: Rfq[] }>("/rfqs"),
      api.get<{ orders: Order[] }>("/orders").catch(() => ({ orders: [] })),
    ]);
    setRfqs(r.rfqs);
    setOrders(o.orders);
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setRfqs(null);
    load().catch(() => setRfqs([]));
  }, [activeSlug, load]);

  /* ── Real derived KPIs (preserved) ───────────────────────────────────────── */
  const open = rfqs?.filter((r) => !/deliver|closed|cancel/i.test(r.status ?? "")).length ?? 0;
  const awaiting = rfqs?.filter((r) => /sent|quoted/i.test(r.status ?? "")).length ?? 0;

  /* ── Mock-derived pipeline figures ───────────────────────────────────────── */
  const pipelineTotal = SNAP.new_rfq + SNAP.processing + SNAP.priced + SNAP.confirmed + SNAP.delivered;
  const alertsTotal = SNAP.return_requests + SNAP.cancellation_requests + SNAP.missing_purchase_invoices;
  const completionRate = Math.round((SNAP.delivered / pipelineTotal) * 100);

  const progress = useMountProgress(`ov-${rfqs === null ? "load" : "ready"}-${pipelineTotal + alertsTotal}`);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }, []);
  const dateLine = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(
        new Date(),
      ),
    [],
  );
  const firstName = (me?.user?.full_name ?? "there").split(" ")[0];
  const wsName = workspaces.find((w) => w.slug === activeSlug)?.name ?? "your workspace";

  const pipelineStages = [
    { label: "New RFQs", value: SNAP.new_rfq, color: C.sky },
    { label: "Processing", value: SNAP.processing, color: C.amber },
    { label: "Priced", value: SNAP.priced, color: C.emerald },
    { label: "Confirmed", value: SNAP.confirmed, color: C.violet },
    { label: "Delivered", value: SNAP.delivered, color: C.teal },
  ];

  const statusCards: {
    label: string;
    value: number;
    icon: ReactNode;
    accent: Accent;
    color: string;
    to: string;
  }[] = [
    { label: "New RFQs", value: SNAP.new_rfq, icon: <Inbox className="h-[18px] w-[18px]" />, accent: "sky", color: C.sky, to: "/rfqs" },
    { label: "Processing", value: SNAP.processing, icon: <Clock className="h-[18px] w-[18px]" />, accent: "amber", color: C.amber, to: "/rfqs" },
    { label: "Priced", value: SNAP.priced, icon: <Tag className="h-[18px] w-[18px]" />, accent: "emerald", color: C.emerald, to: "/rfqs" },
    { label: "Confirmed", value: SNAP.confirmed, icon: <CheckCircle2 className="h-[18px] w-[18px]" />, accent: "violet", color: C.violet, to: "/orders" },
    { label: "Delivered", value: SNAP.delivered, icon: <PackageCheck className="h-[18px] w-[18px]" />, accent: "teal", color: C.teal, to: "/orders" },
    { label: "Returns", value: SNAP.return_requests, icon: <RotateCcw className="h-[18px] w-[18px]" />, accent: "rose", color: C.rose, to: "/orders" },
    { label: "Cancellations", value: SNAP.cancellation_requests, icon: <XCircle className="h-[18px] w-[18px]" />, accent: "orange", color: C.orange, to: "/orders" },
    { label: "Missing Invoices", value: SNAP.missing_purchase_invoices, icon: <FileWarning className="h-[18px] w-[18px]" />, accent: "slate", color: C.slate, to: "/purchase-invoices" },
  ];

  const quickLinks: { title: string; subtitle: string; icon: ReactNode; accent: Accent; to: string }[] = [
    { title: "RFQs", subtitle: "Browse and manage requests for quotation", icon: <FilePlus2 className="h-5 w-5" />, accent: "sky", to: "/rfqs" },
    { title: "RFQs Dashboard", subtitle: "Review and price incoming requests", icon: <Files className="h-5 w-5" />, accent: "emerald", to: "/rfqs" },
    { title: "Orders Dashboard", subtitle: "Track confirmed orders to fulfilment", icon: <ShoppingCart className="h-5 w-5" />, accent: "violet", to: "/orders" },
    { title: "Delivered Orders", subtitle: "Browse completed deliveries", icon: <Truck className="h-5 w-5" />, accent: "teal", to: "/delivered" },
    { title: "Targets", subtitle: "Monitor performance against goals", icon: <Target className="h-5 w-5" />, accent: "amber", to: "/targets" },
    { title: "Internal Dashboard", subtitle: "Manage RFQs and orders for the team", icon: <Boxes className="h-5 w-5" />, accent: "slate", to: "/internal" },
  ];

  return (
    <>
      <style>{`
        @keyframes ovFadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
        .ov-fade-up, .ov-fade-up-inner { animation: ovFadeUp .5s cubic-bezier(.16,1,.3,1) both; }
        @media (prefers-reduced-motion: reduce) { .ov-fade-up, .ov-fade-up-inner { animation: none !important; } }
      `}</style>

      {/* ── Hero / welcome banner — one hero for all four tabs ─────────────── */}
      <PageHero
        rtl={rtl}
        breadcrumb={[L(lang, "Home", "الرئيسية"), L(lang, "Overview", "النظرة العامة")]}
        title={onReports ? L(lang, "Management Overview", "نظرة الإدارة العامة") : `${greeting}, ${firstName} 👋`}
        badge={
          <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white ring-1 ring-white/25">
            {/* The report tabs are demo data and say so; hiding that behind a shared hero would be
                the merge quietly laundering one tab's honesty into another's. */}
            {onReports ? L(lang, "Demo data", "بيانات تجريبية") : wsName}
          </span>
        }
        meta={dateLine}
        description={
          onReports
            ? L(lang,
                "Executive analytics across workshops, purchasing and suppliers — durations, volumes, value and SLA performance at a glance.",
                "تحليلات تنفيذية للورش والمشتريات والموردين — المدد والأحجام والقيمة والالتزام باتفاقيات الخدمة في لمحة.")
            : "Here is a snapshot of your procurement pipeline — track requests, pricing and fulfilment, and jump straight to what needs your attention."
        }
        corner={
          onReports ? (
            <button
              onClick={() => setLang((l) => (l === "AR" ? "EN" : "AR"))}
              className="flex items-center gap-1.5 rounded-md bg-white/15 px-2.5 py-1.5 text-[12px] font-semibold text-white ring-1 ring-white/25 transition hover:bg-white/25"
            >
              <Languages className="h-3.5 w-3.5" />
              {lang === "AR" ? "EN" : "عربي"}
            </button>
          ) : undefined
        }
        actions={
          onReports ? undefined : (
          <>
            <button
              onClick={() => nav("/rfqs")}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-white shadow-btn transition hover:bg-accent-hover"
            >
              <FilePlus2 className="h-4 w-4" /> New RFQ
            </button>
            <button
              onClick={() => nav("/rfqs")}
              className="inline-flex items-center gap-2 rounded-md bg-white/10 px-3.5 py-2 text-[13px] font-medium text-white ring-1 ring-white/20 transition hover:bg-white/20"
            >
              <Files className="h-4 w-4" /> RFQs Dashboard
            </button>
          </>
          )
        }
      />

      {/* ── The four tabs. Snapshot is dropped when there is no workspace to read. ────── */}
      <div className="flex flex-wrap gap-2">
        {([
          ...(canSnapshot ? [{ key: "snapshot" as const, en: "Snapshot", ar: "لمحة", icon: <LayoutDashboard className="h-4 w-4" /> }] : []),
          { key: "workshop" as const,   en: "Workshop Reports",   ar: "تقارير الورش",     icon: <Wrench className="h-4 w-4" /> },
          { key: "purchasing" as const, en: "Purchasing Reports", ar: "تقارير المشتريات", icon: <ShoppingBag className="h-4 w-4" /> },
          { key: "suppliers" as const,  en: "Suppliers Reports",  ar: "تقارير الموردين",  icon: <Building2 className="h-4 w-4" /> },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-2 rounded-xl2 px-3.5 py-2 text-[13px] font-semibold transition ${
              active === t.key
                ? "bg-accent text-white shadow-card"
                : "border border-line bg-panel text-sub hover:border-accent hover:text-accent"
            }`}
          >
            {t.icon}
            {L(lang, t.en, t.ar)}
          </button>
        ))}
      </div>

      {active === "workshop" && <WorkshopTab lang={lang} progress={reportProgress} />}
      {active === "purchasing" && <PurchasingTab lang={lang} progress={reportProgress} />}
      {active === "suppliers" && <SuppliersTab lang={lang} progress={reportProgress} />}

      {active === "snapshot" && (
        <>

      {/* ── Real KPI strip (preserved) ─────────────────────────────────────── */}
      <StatStrip>
        <StatCard label="Open RFQs" value={open} hint={`${awaiting} awaiting quotes`} />
        <StatCard label="Confirmed orders" value={orders.length} tone="ink" />
        <StatCard label="RFQs total" value={rfqs?.length ?? "—"} />
        <StatCard label="Needs attention" value={awaiting} tone="accent" hint="quotes to review" />
      </StatStrip>

      {/* ── Pipeline status grid (8, mock) ─────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8">
        {statusCards.map((s, i) => (
          <StatusCard
            key={s.label}
            label={s.label}
            value={s.value}
            icon={s.icon}
            accent={s.accent}
            color={s.color}
            progress={progress}
            delay={i * 50}
            onClick={() => nav(s.to)}
          />
        ))}
      </div>

      {/* ── Distribution donut + needs-attention ───────────────────────────── */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title="Pipeline Distribution"
          description="Live breakdown of active requests across stages"
          icon={<TrendingUp className="h-[18px] w-[18px]" />}
          delay={160}
        >
          <Donut
            segments={pipelineStages}
            centerLabel="Active"
            progress={progress}
          />
        </SectionCard>

        <SectionCard title="Needs Attention" icon={<FileWarning className="h-[18px] w-[18px]" />} delay={220}>
          <div className="space-y-2.5">
            <AlertRow label="Return Requests" value={SNAP.return_requests} icon={<RotateCcw className="h-[18px] w-[18px]" />} accent="rose" onClick={() => nav("/orders")} />
            <AlertRow label="Cancellation Requests" value={SNAP.cancellation_requests} icon={<XCircle className="h-[18px] w-[18px]" />} accent="orange" onClick={() => nav("/orders")} />
            <AlertRow label="Missing Purchase Invoices" value={SNAP.missing_purchase_invoices} icon={<FileWarning className="h-[18px] w-[18px]" />} accent="slate" onClick={() => nav("/purchase-invoices")} />
            <div className="mt-3 flex items-center gap-2 rounded-xl2 bg-surface px-3 py-2.5 text-[12px] text-muted">
              <AlertTriangle className="h-4 w-4 shrink-0 text-accent" />
              <span><b className="font-semibold text-ink tnum">{alertsTotal}</b> open alerts need review</span>
            </div>
          </div>
        </SectionCard>
      </div>

      {/* ── Conversion funnel + top vendors ────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title="Conversion Funnel"
          description="How requests progress from quotation to delivery"
          icon={<Filter className="h-[18px] w-[18px]" />}
          delay={260}
          actions={<Badge tone="green">{completionRate}% delivered</Badge>}
        >
          <Funnel stages={pipelineStages} progress={progress} />
        </SectionCard>

        <SectionCard
          title="Top Vendors"
          description="Confirmed value this month (SAR)"
          icon={<Store className="h-[18px] w-[18px]" />}
          delay={300}
        >
          <HBars
            rows={TOP_VENDORS.map((v) => ({ label: v.name, value: v.value, hint: `${v.orders} orders` }))}
            color={C.navy}
            progress={progress}
            fmt={(n) => sar.format(n)}
          />
        </SectionCard>
      </div>

      {/* ── Requests vs Orders trend ───────────────────────────────────────── */}
      <div className="mb-6">
        <SectionCard
          title="Requests vs. Confirmed Orders"
          description="Six-month volume trend across the workspace"
          icon={<Activity className="h-[18px] w-[18px]" />}
          delay={320}
        >
          <TrendColumns
            series={[
              { label: "RFQs received", color: C.navy },
              { label: "Orders confirmed", color: C.teal },
            ]}
            categories={TREND_MONTHS}
            data={[TREND_RFQS, TREND_ORDERS]}
            progress={progress}
          />
        </SectionCard>
      </div>

      {/* ── Recent RFQs (real data, preserved) ─────────────────────────────── */}
      <Card pad={false} className="mb-6 ov-fade-up">
        <div style={{ animationDelay: "360ms" }} className="ov-fade-up-inner">
          <div className="flex items-center border-b border-line-2 px-5 py-3.5">
            <b className="text-[14px] font-semibold text-ink">Recent RFQs</b>
            <span className="ms-2 text-[12px] text-muted">Latest requests across your branches</span>
            <button
              onClick={() => nav("/rfqs")}
              className="ms-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline"
            >
              View all <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {rfqs === null ? (
            <Spinner />
          ) : rfqs.length === 0 ? (
            <EmptyState title="No RFQs yet" hint="Create your first request for quote to get started." icon={<Inbox className="h-6 w-6" />} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead>
                  <tr>
                    <th className="th">Order</th>
                    <th className="th">Vehicle</th>
                    <th className="th text-right">Items</th>
                    <th className="th">Status</th>
                    <th className="th w-4" />
                  </tr>
                </thead>
                <tbody>
                  {rfqs.slice(0, 6).map((r) => (
                    <tr key={r.id} className="trow cursor-pointer" onClick={() => nav(`/rfqs/${r.id}`)}>
                      <td className="td font-semibold text-accent tnum">{r.order_number}</td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface text-accent">
                            <Car className="h-4 w-4" />
                          </span>
                          <span className="tnum text-ink">{r.plate_number ?? <span className="text-faint">No plate</span>}</span>
                        </div>
                      </td>
                      <td className="td text-right">
                        <span className="inline-flex items-center gap-1 text-muted tnum">
                          <Package className="h-3.5 w-3.5" />
                          {r.items}
                        </span>
                      </td>
                      <td className="td">
                        <Badge tone={statusTone(r.status)}>{r.status ?? "—"}</Badge>
                      </td>
                      <td className="td text-right">
                        <ArrowUpRight className="ms-auto h-4 w-4 text-line" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* ── Quick actions ──────────────────────────────────────────────────── */}
      <SectionCard title="Quick Actions" icon={<ArrowRight className="h-[18px] w-[18px]" />} delay={400}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {quickLinks.map((q) => (
            <QuickLink key={q.title} title={q.title} subtitle={q.subtitle} icon={q.icon} accent={q.accent} onClick={() => nav(q.to)} />
          ))}
        </div>
      </SectionCard>
        </>
      )}
    </>
  );
}
