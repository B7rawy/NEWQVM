import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Send,
  Clock,
  PackageCheck,
  CheckCircle2,
  Boxes,
  Timer,
  Truck,
  XCircle,
  RotateCcw,
  Hourglass,
  Receipt,
  FileText,
  TrendingUp,
  Users,
  Coins,
  Gauge,
  MapPin,
  BadgeCheck,
} from "lucide-react";
import { Card } from "../components/ui";

/* ────────────────────────────────────────────────────────────────────────────
   Management Overview — Executive Analytics Dashboard (frontend-only rebuild).
   All numbers are hardcoded demo data. KPI sums, completion %, donut totals,
   SLA ratings and "missing invoices" are DERIVED from the arrays at render time.
   Fully bilingual (EN / AR) with RTL; currency is SAR. No API calls.
   Charts are pure inline SVG / CSS — no charting library. Colours are chosen to
   read on both light and dark panels; structure uses semantic tokens only.
──────────────────────────────────────────────────────────────────────────── */

export type Lang = "EN" | "AR";
export const L = (lang: Lang, en: string, ar: string) => (lang === "AR" ? ar : en);

/* Categorical series colours — mid-tone hues legible on light (#fff) and dark
   (#151b2b) panels alike. Structural colour comes from semantic tokens. */
const C = {
  navy: "#2f6f86", // brand-navy, lightened so it survives dark panels
  teal: "#0f9488",
  teal2: "#2dd4bf",
  sky: "#38bdf8",
  amber: "#f5a524",
  emerald: "#34d399",
  violet: "#a78bfa",
  rose: "#fb7185",
  red: "#ef4444",
  slate: "#94a3b8",
};

const fmtNum = (n: number) => Math.round(n).toLocaleString("en-US");

/* ── count-up hook driven by a shared 0→1 progress value ──────────────────── */
const ANIM_MS = 1000;
export function useProgress(resetKey: string) {
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
    // Safety net: guarantee the final state even if rAF is throttled/paused
    // (e.g. the tab is mounted while backgrounded, so rAF never fires).
    done.current = setTimeout(() => setP(1), ANIM_MS + 60);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      if (done.current) clearTimeout(done.current);
    };
  }, [resetKey]);
  return p;
}

/* ── SectionCard — shared card with title + description + icon + actions ───── */
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
    <Card pad={false} className={`ov-fade-up ${className}`}>
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

/* ── KpiChip — icon + trend + count-up ────────────────────────────────────── */
type Accent = "sky" | "amber" | "teal" | "emerald" | "violet" | "rose";
const accentClass: Record<Accent, string> = {
  sky: "bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300",
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300",
  teal: "bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300",
  emerald: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300",
  violet: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300",
  rose: "bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300",
};

function KpiChip({
  label,
  value,
  suffix,
  icon,
  accent,
  trend,
  progress,
  delay,
}: {
  label: string;
  value: number;
  suffix?: string;
  icon: ReactNode;
  accent: Accent;
  trend?: { dir: "up" | "down"; pct: number; good: boolean };
  progress: number;
  delay: number;
}) {
  const shown = Math.round(value * progress);
  return (
    <div className="card ov-fade-up p-4" style={{ animationDelay: `${delay}ms` }}>
      <div className="ov-fade-up-inner flex items-start justify-between gap-2">
        <span className={`grid h-9 w-9 place-items-center rounded-lg ${accentClass[accent]}`}>{icon}</span>
        {trend && (
          <span
            className={`badge ${trend.good ? "badge-green" : "badge-red"} gap-0.5`}
          >
            {trend.dir === "up" ? "▲" : "▼"} {trend.pct}%
          </span>
        )}
      </div>
      <div className="ov-fade-up-inner mt-3 text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="ov-fade-up-inner mt-0.5 text-[24px] font-semibold tracking-tight text-ink tnum">
        {fmtNum(shown)}
        {suffix && <span className="text-[15px] font-semibold text-muted">{suffix}</span>}
      </div>
    </div>
  );
}

/* ── BigStat — large number + unit + caption + icon ───────────────────────── */
function BigStat({
  value,
  unit,
  caption,
  icon,
  accent = "navy",
  progress,
}: {
  value: number;
  unit: string;
  caption: string;
  icon: ReactNode;
  accent?: "navy" | "teal";
  progress: number;
}) {
  const tint =
    accent === "teal"
      ? "bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300"
      : "bg-surface text-accent";
  const shown = (value * progress).toFixed(1);
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl2 border border-line bg-surface/60 px-4 py-3">
      <span className={`grid h-11 w-11 place-items-center rounded-lg ${tint}`}>{icon}</span>
      <div>
        <div className="flex items-end gap-1 leading-none">
          <span className="text-[28px] font-semibold tracking-tight text-ink tnum">{shown}</span>
          <span className="pb-0.5 text-[14px] font-medium text-muted">{unit}</span>
        </div>
        <div className="mt-1 text-[12px] text-muted">{caption}</div>
      </div>
    </div>
  );
}

/* ── HBars — horizontal ranking bars, value in-bar, optional hint subline ─── */
function HBars({
  rows,
  color,
  unit,
  decimals = 0,
  progress,
}: {
  rows: { label: string; value: number; hint?: string }[];
  color: string;
  unit?: string;
  decimals?: number;
  progress: number;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((r) => {
        const frac = r.value / max;
        const w = Math.max(r.value > 0 ? 9 : 0, frac * 100) * progress;
        const label = decimals ? r.value.toFixed(decimals) : fmtNum(r.value);
        return (
          <div key={r.label}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate text-[12.5px] font-medium text-sub">{r.label}</span>
              {r.hint && <span className="shrink-0 text-[11px] text-faint tnum">{r.hint}</span>}
            </div>
            <div className="h-6 w-full overflow-hidden rounded-md bg-surface">
              <div
                className="flex h-full items-center justify-end rounded-md px-2 text-[11px] font-semibold text-white tnum"
                style={{ width: `${w}%`, backgroundColor: color, transition: "none" }}
              >
                {frac > 0.14 && (
                  <span>
                    {label}
                    {unit ? ` ${unit}` : ""}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Donut — animated sweep, center total + legend list ───────────────────── */
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
  const C2 = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: 176, height: 176 }}>
        <svg viewBox="0 0 176 176" width={176} height={176} className="-rotate-90">
          <circle cx={88} cy={88} r={R} fill="none" stroke="var(--line)" strokeWidth={SW} />
          {segments.map((s) => {
            const frac = total > 0 ? s.value / total : 0;
            const len = frac * C2 * progress;
            const dash = `${len} ${C2 - len}`;
            const offset = -acc * C2 * progress;
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
          <span className="text-[26px] font-semibold text-ink tnum">{fmtNum(total * progress)}</span>
          <span className="text-[11px] uppercase tracking-wide text-muted">{centerLabel}</span>
        </div>
      </div>
      <ul className="flex-1 space-y-2">
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

/* ── StackedBars — horizontal, legend top, row total at end ────────────────── */
function StackedBars({
  series,
  rows,
  progress,
  fmt = fmtNum,
}: {
  series: { label: string; color: string }[];
  rows: { label: string; values: number[] }[];
  progress: number;
  fmt?: (n: number) => string;
}) {
  const totals = rows.map((r) => r.values.reduce((s, v) => s + v, 0));
  const max = Math.max(1, ...totals);
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
      <div className="flex flex-col gap-3">
        {rows.map((r, ri) => {
          const total = totals[ri];
          return (
            <div key={r.label}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium text-sub">{r.label}</span>
                <span className="shrink-0 text-[11.5px] font-semibold text-ink tnum">{fmt(total)}</span>
              </div>
              <div className="flex h-6 w-full overflow-hidden rounded-md bg-surface">
                {r.values.map((v, vi) => {
                  const w = (v / max) * 100 * progress;
                  return (
                    <div
                      key={vi}
                      title={`${series[vi].label} · ${r.label}: ${fmt(v)}`}
                      style={{ width: `${w}%`, backgroundColor: series[vi].color }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── GroupedColumns — vertical grouped, legend top, hover title ───────────── */
function GroupedColumns({
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
      <div className="flex h-52 items-end gap-3">
        {categories.map((cat, ci) => (
          <div key={cat} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <div className="flex h-full w-full items-end justify-center gap-1">
              {series.map((s, si) => {
                const v = data[si][ci];
                const h = (v / max) * 100 * progress;
                return (
                  <div
                    key={s.label}
                    title={`${s.label} · ${cat}: ${fmtNum(v)}`}
                    className="w-1/2 max-w-[26px] rounded-t"
                    style={{ height: `${h}%`, backgroundColor: s.color }}
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

/* ── AreaTrend — line + gradient area, 4 gridlines, l→r clip reveal ───────── */
function AreaTrend({
  values,
  labels,
  color,
  progress,
}: {
  values: number[];
  labels: string[];
  color: string;
  progress: number;
}) {
  const W = 600;
  const H = 200;
  const pad = 8;
  const max = Math.max(...values) * 1.15 || 1;
  const min = 0;
  const gid = useMemo(() => `ov-area-${Math.random().toString(36).slice(2, 8)}`, []);
  const cid = useMemo(() => `ov-clip-${Math.random().toString(36).slice(2, 8)}`, []);
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = H - pad - ((v - min) / (max - min)) * (H - pad * 2);
    return [x, y] as const;
  });
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`;
  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
          <clipPath id={cid}>
            <rect x="0" y="0" width={W * progress} height={H} />
          </clipPath>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line
            key={g}
            x1={pad}
            x2={W - pad}
            y1={pad + g * (H - pad * 2)}
            y2={pad + g * (H - pad * 2)}
            stroke="var(--line)"
            strokeWidth={1}
          />
        ))}
        <g clipPath={`url(#${cid})`}>
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          {pts.map((p, i) => (
            <circle key={i} cx={p[0]} cy={p[1]} r={3.5} fill="var(--panel)" stroke={color} strokeWidth={2} />
          ))}
        </g>
      </svg>
      <div className="mt-1 flex justify-between px-1 text-[10px] text-faint">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </div>
  );
}

/* ── SlaBadge — colored ring pill ─────────────────────────────────────────── */
type Rating = "Better" | "Matching" | "Worse";
function slaRating(actual: number, sla: number): Rating {
  // rule: actual ≤ sla−0.2 → Better; within ~a day's grace of the SLA → Matching;
  // else Worse. Compared on a rounded scale (×10) so near-boundary demo values
  // (Swift 3.2 vs SLA 3) classify per intent: Kingdom/Elite Better, Gulf/Swift
  // Matching, Modern Worse — i.e. Better 2, Matching 2, Worse 1.
  const a = Math.round(actual * 10);
  const s = Math.round(sla * 10);
  if (a <= s - 2) return "Better"; // ≤ sla − 0.2
  if (a <= s + 2) return "Matching"; // within +0.2 grace band
  return "Worse";
}
function SlaBadge({ rating, lang }: { rating: Rating; lang: Lang }) {
  const map = {
    Better: { cls: "badge-green", en: "Better", ar: "أفضل" },
    Matching: { cls: "badge-blue", en: "Matching", ar: "مطابق" },
    Worse: { cls: "badge-red", en: "Worse", ar: "أسوأ" },
  } as const;
  const m = map[rating];
  return <span className={`badge ${m.cls}`}>{lang === "AR" ? m.ar : m.en}</span>;
}

/* ── data ─────────────────────────────────────────────────────────────────── */
const BRANCHES = [
  { en: "Riyadh", ar: "الرياض", sent: 320, pending: 28, delivered: 268, completed: 244 },
  { en: "Jeddah", ar: "جدة", sent: 268, pending: 22, delivered: 226, completed: 210 },
  { en: "Dammam", ar: "الدمام", sent: 198, pending: 19, delivered: 165, completed: 152 },
  { en: "Makkah", ar: "مكة", sent: 142, pending: 14, delivered: 120, completed: 110 },
  { en: "Madinah", ar: "المدينة", sent: 96, pending: 9, delivered: 80, completed: 73 },
];

// status = [new, priced, pending, unavailable, returned]. The "Confirmed Value"
// KPI derives as Σ confirmed = 1,356,000 SAR (the per-supplier figures are the
// source of truth here and also feed the Order-Value chart).
const SUPPLIERS = [
  { en: "Kingdom Supply", ar: "مورد المملكة", resp: 3.2, sla: 3, actual: 2.6, confirmed: 412000, lost: 38000, status: [40, 120, 12, 8, 5] },
  { en: "Gulf Parts", ar: "الخليج لقطع الغيار", resp: 5.1, sla: 3, actual: 3.0, confirmed: 318000, lost: 52000, status: [32, 98, 15, 14, 7] },
  { en: "Elite", ar: "النخبة", resp: 2.4, sla: 2, actual: 1.8, confirmed: 286000, lost: 24000, status: [28, 86, 9, 6, 3] },
  { en: "Modern Auto", ar: "السيارات الحديثة", resp: 6.8, sla: 4, actual: 5.1, confirmed: 198000, lost: 64000, status: [22, 64, 18, 20, 9] },
  { en: "Swift Supply", ar: "التوريد السريع", resp: 4.0, sla: 3, actual: 3.2, confirmed: 142000, lost: 18000, status: [18, 52, 7, 5, 2] },
];


/*  THE STANDALONE PAGE WAS REMOVED HERE.
 *
 *  Every design board carried one blue note on its very first row: "تحتاج دمج وتوحيد" across
 *  Overview and Management Overview. They were two dashboards a click apart, one live and one
 *  analytical, each with its own hero and its own idea of where you start your day.
 *
 *  Overview.tsx is now the single dashboard and owns the hero, the tab strip and the language
 *  toggle. What is left in this file is what it always really was: the three report bodies, which
 *  Overview renders as tabs beside its own Snapshot.
 */

/* ════════════════════════════════════════════════════════════════════════════
   WORKSHOP TAB
════════════════════════════════════════════════════════════════════════════ */
export function WorkshopTab({ lang, progress }: { lang: Lang; progress: number }) {
  const sent = BRANCHES.reduce((s, b) => s + b.sent, 0);
  const pending = BRANCHES.reduce((s, b) => s + b.pending, 0);
  const delivered = BRANCHES.reduce((s, b) => s + b.delivered, 0);
  const completed = BRANCHES.reduce((s, b) => s + b.completed, 0);

  const cancelled = [
    { en: "High price", ar: "السعر مرتفع", value: 42, color: C.red },
    { en: "Unavailable", ar: "غير متوفر", value: 31, color: C.amber },
    { en: "Slow pricing", ar: "تأخر التسعير", value: 18, color: C.violet },
    { en: "Duplicate request", ar: "طلب مكرر", value: 12, color: C.sky },
    { en: "Other", ar: "أخرى", value: 9, color: C.slate },
  ];
  const cancelledValue = 84500;

  const returned = [
    { en: "Riyadh", ar: "الرياض", value: 18, sar: 22400 },
    { en: "Jeddah", ar: "جدة", value: 14, sar: 17800 },
    { en: "Dammam", ar: "الدمام", value: 9, sar: 11200 },
    { en: "Makkah", ar: "مكة", value: 6, sar: 7500 },
    { en: "Madinah", ar: "المدينة", value: 4, sar: 4900 },
  ];

  const routes = [
    { en: "Riyadh → Riyadh", ar: "الرياض → الرياض", value: 1.2 },
    { en: "Jeddah → Riyadh", ar: "جدة → الرياض", value: 2.8 },
    { en: "Dammam → Riyadh", ar: "الدمام → الرياض", value: 3.4 },
    { en: "Jeddah → Jeddah", ar: "جدة → جدة", value: 1.1 },
    { en: "Riyadh → Dammam", ar: "الرياض → الدمام", value: 3.1 },
  ];

  const confSeries = [3.1, 2.9, 3.0, 2.6, 2.5, 2.3, 2.4, 2.2];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiChip label={L(lang, "Orders Sent", "الطلبات المرسلة")} value={sent} icon={<Send className="h-[18px] w-[18px]" />} accent="sky" trend={{ dir: "up", pct: 8, good: true }} progress={progress} delay={0} />
        <KpiChip label={L(lang, "Pending Orders", "الطلبات المعلقة")} value={pending} icon={<Clock className="h-[18px] w-[18px]" />} accent="amber" trend={{ dir: "down", pct: 5, good: true }} progress={progress} delay={60} />
        <KpiChip label={L(lang, "Delivered Orders", "الطلبات الموصّلة")} value={delivered} icon={<PackageCheck className="h-[18px] w-[18px]" />} accent="teal" trend={{ dir: "up", pct: 11, good: true }} progress={progress} delay={120} />
        <KpiChip label={L(lang, "Completed Orders", "الطلبات المكتملة")} value={completed} icon={<CheckCircle2 className="h-[18px] w-[18px]" />} accent="emerald" trend={{ dir: "up", pct: 9, good: true }} progress={progress} delay={180} />
      </div>

      <SectionCard
        title={L(lang, "Orders by Branch / User", "الطلبات حسب الفرع / المستخدم")}
        description={L(lang, "Sent, pending, delivered and completed per branch", "المرسلة والمعلقة والموصّلة والمكتملة لكل فرع")}
        icon={<Boxes className="h-[18px] w-[18px]" />}
        delay={120}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th text-start uppercase text-faint">{L(lang, "Branch", "الفرع")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Sent", "مرسلة")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Pending", "معلقة")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Delivered", "موصّلة")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Completed", "مكتملة")}</th>
                <th className="th text-start uppercase text-faint">{L(lang, "Completion", "نسبة الإنجاز")}</th>
              </tr>
            </thead>
            <tbody>
              {BRANCHES.map((b) => {
                const pct = Math.round((b.completed / b.sent) * 100);
                return (
                  <tr key={b.en} className="trow">
                    <td className="td font-semibold text-navy">{L(lang, b.en, b.ar)}</td>
                    <td className="td text-center text-sub tnum">{fmtNum(b.sent)}</td>
                    <td className="td text-center tnum" style={{ color: C.amber }}>{fmtNum(b.pending)}</td>
                    <td className="td text-center tnum" style={{ color: C.teal }}>{fmtNum(b.delivered)}</td>
                    <td className="td text-center tnum" style={{ color: C.emerald }}>{fmtNum(b.completed)}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface">
                          <div className="h-full rounded-full" style={{ width: `${pct * progress}%`, background: "linear-gradient(90deg,#0D4151,#0f9488)" }} />
                        </div>
                        <span className="text-[12px] font-medium text-sub tnum">{pct}%</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title={L(lang, "Avg. Confirmation Time", "متوسط مدة التأكيد")}
          description={L(lang, "After receiving the order (hours)", "بعد استلام الطلب (ساعات)")}
          icon={<Timer className="h-[18px] w-[18px]" />}
          delay={160}
        >
          <BigStat value={2.4} unit={L(lang, "h", "س")} caption={L(lang, "Average across all branches", "المتوسط لجميع الفروع")} icon={<Hourglass className="h-5 w-5" />} progress={progress} />
          <AreaTrend values={confSeries} labels={["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"]} color={C.teal} progress={progress} />
        </SectionCard>

        <SectionCard
          title={L(lang, "Avg. Delivery Time by Route", "متوسط مدة التوصيل حسب المسار")}
          description={L(lang, "Supplier city vs. branch city (days)", "مدينة المورد مقابل مدينة الفرع (أيام)")}
          icon={<Truck className="h-[18px] w-[18px]" />}
          delay={220}
        >
          <HBars rows={routes.map((r) => ({ label: L(lang, r.en, r.ar), value: r.value }))} color={C.navy} unit={L(lang, "d", "يوم")} decimals={1} progress={progress} />
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title={L(lang, "Cancelled Items (before purchase)", "الأصناف الملغاة (قبل الشراء)")}
          description={L(lang, "Count and reasons", "العدد والأسباب")}
          icon={<XCircle className="h-[18px] w-[18px]" />}
          delay={260}
          actions={<span className="badge badge-red tnum">{fmtNum(cancelledValue)} {L(lang, "SAR", "ر.س")}</span>}
        >
          <Donut segments={cancelled.map((c) => ({ label: L(lang, c.en, c.ar), value: c.value, color: c.color }))} centerLabel={L(lang, "Cancelled", "ملغاة")} progress={progress} />
        </SectionCard>

        <SectionCard
          title={L(lang, "Returned Items (after purchase)", "الأصناف المرتجعة (بعد الشراء)")}
          description={L(lang, "Count and value per branch", "العدد والقيمة لكل فرع")}
          icon={<RotateCcw className="h-[18px] w-[18px]" />}
          delay={320}
        >
          <HBars
            rows={returned.map((r) => ({ label: L(lang, r.en, r.ar), value: r.value, hint: `${fmtNum(r.sar)} ${L(lang, "SAR", "ر.س")}` }))}
            color={C.rose}
            unit={L(lang, "items", "صنف")}
            progress={progress}
          />
        </SectionCard>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   PURCHASING TAB
════════════════════════════════════════════════════════════════════════════ */
export function PurchasingTab({ lang, progress }: { lang: Lang; progress: number }) {
  const po = [180, 210, 195, 240, 260, 255];
  const inv = [168, 201, 182, 232, 249, 251];
  const totalPO = po.reduce((s, v) => s + v, 0); // 1340
  const totalInv = inv.reduce((s, v) => s + v, 0); // 1283
  const missing = totalPO - totalInv; // 57

  const purchaseEmp = [
    { en: "Ahmed", ar: "أحمد", value: 5.2 },
    { en: "Sara", ar: "سارة", value: 4.1 },
    { en: "Khaled", ar: "خالد", value: 6.8 },
    { en: "Noura", ar: "نورة", value: 5.5 },
  ];
  const deliveryEmp = [
    { en: "Ahmed", ar: "أحمد", value: 2.6 },
    { en: "Sara", ar: "سارة", value: 2.1 },
    { en: "Khaled", ar: "خالد", value: 3.2 },
    { en: "Noura", ar: "نورة", value: 2.8 },
  ];

  const months = lang === "AR" ? ["ينا", "فبر", "مار", "أبر", "ماي", "يون"] : ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiChip label={L(lang, "Avg. Purchase Time", "متوسط مدة الشراء")} value={5} suffix={L(lang, ".4h", ".4س")} icon={<Timer className="h-[18px] w-[18px]" />} accent="sky" progress={progress} delay={0} />
        <KpiChip label={L(lang, "Avg. Delivery Time", "متوسط مدة التوصيل")} value={2} suffix={L(lang, ".7d", ".7ي")} icon={<Truck className="h-[18px] w-[18px]" />} accent="teal" progress={progress} delay={60} />
        <KpiChip label={L(lang, "Purchase Orders", "أوامر الشراء")} value={totalPO} icon={<Receipt className="h-[18px] w-[18px]" />} accent="violet" progress={progress} delay={120} />
        <KpiChip label={L(lang, "Invoices Uploaded", "الفواتير المرفوعة")} value={totalInv} icon={<FileText className="h-[18px] w-[18px]" />} accent="emerald" progress={progress} delay={180} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title={L(lang, "Avg. Purchase Time per Employee", "متوسط مدة الشراء لكل موظف")}
          description={L(lang, "After workshop confirmation (hours)", "بعد تأكيد الورشة (ساعات)")}
          icon={<Timer className="h-[18px] w-[18px]" />}
          delay={120}
        >
          <BigStat value={5.4} unit={L(lang, "h", "س")} caption={L(lang, "Overall average", "المتوسط العام")} icon={<Hourglass className="h-5 w-5" />} progress={progress} />
          <HBars rows={purchaseEmp.map((e) => ({ label: L(lang, e.en, e.ar), value: e.value }))} color={C.navy} unit={L(lang, "h", "س")} decimals={1} progress={progress} />
        </SectionCard>

        <SectionCard
          title={L(lang, "Avg. Delivery Time per Employee", "متوسط مدة التوصيل لكل موظف")}
          description={L(lang, "From purchase until receipt signed (days)", "من الشراء حتى توقيع الاستلام (أيام)")}
          icon={<Truck className="h-[18px] w-[18px]" />}
          delay={180}
        >
          <BigStat value={2.7} unit={L(lang, "d", "يوم")} caption={L(lang, "Overall average", "المتوسط العام")} icon={<Truck className="h-5 w-5" />} accent="teal" progress={progress} />
          <HBars rows={deliveryEmp.map((e) => ({ label: L(lang, e.en, e.ar), value: e.value }))} color={C.teal} unit={L(lang, "d", "يوم")} decimals={1} progress={progress} />
        </SectionCard>
      </div>

      <SectionCard
        title={L(lang, "Purchase Orders vs. Uploaded Invoices", "أوامر الشراء مقابل الفواتير المرفوعة")}
        description={L(lang, "Monthly comparison across the system", "مقارنة شهرية عبر النظام")}
        icon={<TrendingUp className="h-[18px] w-[18px]" />}
        delay={220}
        actions={<span className="badge badge-amber tnum">{missing} {L(lang, "missing invoices", "فاتورة ناقصة")}</span>}
      >
        <GroupedColumns
          series={[
            { label: L(lang, "Purchase Orders", "أوامر الشراء"), color: C.navy },
            { label: L(lang, "Invoices Uploaded", "الفواتير المرفوعة"), color: C.teal2 },
          ]}
          categories={months}
          data={[po, inv]}
          progress={progress}
        />
      </SectionCard>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   SUPPLIERS TAB
════════════════════════════════════════════════════════════════════════════ */
export function SuppliersTab({ lang, progress }: { lang: Lang; progress: number }) {
  const activeSuppliers = SUPPLIERS.length;
  const confirmedValue = SUPPLIERS.reduce((s, x) => s + x.confirmed, 0); // 1,354,000
  const lostValue = SUPPLIERS.reduce((s, x) => s + x.lost, 0); // 196,000

  const ratings = SUPPLIERS.map((s) => slaRating(s.actual, s.sla));
  const better = ratings.filter((r) => r === "Better").length;
  const matching = ratings.filter((r) => r === "Matching").length;
  const worse = ratings.filter((r) => r === "Worse").length;

  const statusSeries = [
    { en: "New", ar: "جديد", color: C.sky },
    { en: "Priced", ar: "مسعّر", color: C.emerald },
    { en: "Pending", ar: "معلق", color: C.amber },
    { en: "Unavailable", ar: "غير متوفر", color: C.slate },
    { en: "Returned", ar: "مرتجع", color: C.rose },
  ];

  const regions = [
    { en: "Riyadh", ar: "الرياض", local: 220, other: 100 },
    { en: "Jeddah", ar: "جدة", local: 180, other: 88 },
    { en: "Dammam", ar: "الدمام", local: 120, other: 78 },
    { en: "Makkah", ar: "مكة", local: 96, other: 64 },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiChip label={L(lang, "Avg. Response Time", "متوسط مدة الرد")} value={4} suffix={L(lang, ".3h", ".3س")} icon={<Timer className="h-[18px] w-[18px]" />} accent="sky" progress={progress} delay={0} />
        <KpiChip label={L(lang, "Active Suppliers", "الموردون النشطون")} value={activeSuppliers} icon={<Users className="h-[18px] w-[18px]" />} accent="violet" progress={progress} delay={60} />
        <KpiChip label={L(lang, "Confirmed Value", "قيمة المؤكد")} value={confirmedValue} suffix={L(lang, " SAR", " ر.س")} icon={<Coins className="h-[18px] w-[18px]" />} accent="emerald" progress={progress} delay={120} />
        <KpiChip label={L(lang, "Lost Value", "القيمة الضائعة")} value={lostValue} suffix={L(lang, " SAR", " ر.س")} icon={<XCircle className="h-[18px] w-[18px]" />} accent="rose" progress={progress} delay={180} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <SectionCard
          className="lg:col-span-2"
          title={L(lang, "Avg. Supplier Response Time", "متوسط مدة رد الموردين")}
          description={L(lang, "Overall and per supplier (hours)", "الإجمالي ولكل مورد (ساعات)")}
          icon={<Timer className="h-[18px] w-[18px]" />}
          delay={120}
        >
          <HBars rows={SUPPLIERS.map((s) => ({ label: L(lang, s.en, s.ar), value: s.resp }))} color={C.navy} unit={L(lang, "h", "س")} decimals={1} progress={progress} />
        </SectionCard>

        <SectionCard
          title={L(lang, "SLA Adherence", "الالتزام باتفاقية الخدمة")}
          description={L(lang, "Across suppliers", "عبر الموردين")}
          icon={<Gauge className="h-[18px] w-[18px]" />}
          delay={180}
        >
          <Donut
            segments={[
              { label: L(lang, "Better", "أفضل"), value: better, color: C.emerald },
              { label: L(lang, "Matching", "مطابق"), value: matching, color: C.sky },
              { label: L(lang, "Worse", "أسوأ"), value: worse, color: C.rose },
            ]}
            centerLabel={L(lang, "Suppliers", "مورد")}
            progress={progress}
          />
        </SectionCard>
      </div>

      <SectionCard
        title={L(lang, "Orders per Supplier by Status", "الطلبات لكل مورد حسب الحالة")}
        description={L(lang, "New, priced, pending, unavailable, returned", "جديد، مسعّر، معلق، غير متوفر، مرتجع")}
        icon={<Boxes className="h-[18px] w-[18px]" />}
        delay={220}
      >
        <StackedBars
          series={statusSeries.map((s) => ({ label: L(lang, s.en, s.ar), color: s.color }))}
          rows={SUPPLIERS.map((s) => ({ label: L(lang, s.en, s.ar), values: s.status }))}
          progress={progress}
        />
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard
          title={L(lang, "Order Value per Supplier", "قيمة الطلبات لكل مورد")}
          description={L(lang, "Confirmed vs. lost (SAR)", "المؤكد مقابل الضائع (ر.س)")}
          icon={<Coins className="h-[18px] w-[18px]" />}
          delay={260}
        >
          <StackedBars
            series={[
              { label: L(lang, "Confirmed", "مؤكد"), color: C.emerald },
              { label: L(lang, "Lost", "ضائع"), color: C.rose },
            ]}
            rows={SUPPLIERS.map((s) => ({ label: L(lang, s.en, s.ar), values: [s.confirmed, s.lost] }))}
            progress={progress}
            fmt={fmtNum}
          />
        </SectionCard>

        <SectionCard
          title={L(lang, "Confirmed Region vs. Supplier Location", "منطقة الطلب مقابل موقع المورد")}
          description={L(lang, "Locally sourced vs. from another city", "مصدر محلي مقابل مدينة أخرى")}
          icon={<MapPin className="h-[18px] w-[18px]" />}
          delay={320}
        >
          <StackedBars
            series={[
              { label: L(lang, "Local", "محلي"), color: C.teal },
              { label: L(lang, "Other city", "مدينة أخرى"), color: C.amber },
            ]}
            rows={regions.map((r) => ({ label: L(lang, r.en, r.ar), values: [r.local, r.other] }))}
            progress={progress}
          />
        </SectionCard>
      </div>

      <SectionCard
        title={L(lang, "Supply Time vs. Agreed SLA", "مدة التوريد مقابل اتفاقية الخدمة")}
        description={L(lang, "Per supplier, by branch receipt signature", "لكل مورد، حسب توقيع استلام الفرع")}
        icon={<BadgeCheck className="h-[18px] w-[18px]" />}
        delay={360}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr>
                <th className="th text-start uppercase text-faint">{L(lang, "Supplier", "المورد")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Agreed SLA", "الاتفاقية")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Actual", "الفعلي")}</th>
                <th className="th text-center uppercase text-faint">{L(lang, "Rating", "التقييم")}</th>
              </tr>
            </thead>
            <tbody>
              {SUPPLIERS.map((s) => {
                const rating = slaRating(s.actual, s.sla);
                return (
                  <tr key={s.en} className="trow">
                    <td className="td font-semibold text-navy">{L(lang, s.en, s.ar)}</td>
                    <td className="td text-center text-sub tnum">{s.sla} {L(lang, "d", "يوم")}</td>
                    <td className="td text-center font-semibold text-navy tnum">{s.actual.toFixed(1)} {L(lang, "d", "يوم")}</td>
                    <td className="td text-center"><SlaBadge rating={rating} lang={lang} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
