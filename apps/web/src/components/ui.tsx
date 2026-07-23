import { Fragment, type ReactNode } from "react";
import { ChevronRight, Home } from "lucide-react";

/** Stripe-language UI primitives, QVM red accent. */

/**
 * The one page banner used across the app — a single visual identity for every hero.
 * Fixed deep teal-navy gradient (does NOT flip with the theme, so the white text always
 * has contrast), soft glows + dot texture, then: breadcrumb → title (+badge) → meta →
 * description → actions. `corner` renders a top-end control (e.g. a language toggle).
 * Owns its own bottom spacing (mb-5) so pages don't hand-tune the gap.
 */
export function PageHero({
  breadcrumb,
  title,
  badge,
  meta,
  description,
  actions,
  corner,
  rtl = false,
}: {
  breadcrumb?: string[];
  title: string;
  badge?: ReactNode;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  corner?: ReactNode;
  rtl?: boolean;
}) {
  return (
    <div
      className="relative mb-5 overflow-hidden rounded-xl2 border border-line px-6 py-6 sm:px-8 sm:py-7"
      style={{ background: "linear-gradient(120deg,#0D4151 0%,#114a5c 55%,#0f766e 100%)" }}
    >
      <div
        className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full"
        style={{ background: "radial-gradient(circle,rgba(45,212,191,.35),transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-24 left-1/3 h-56 w-56 rounded-full"
        style={{ background: "radial-gradient(circle,rgba(56,189,248,.28),transparent 70%)" }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.12]"
        style={{ backgroundImage: "radial-gradient(rgba(255,255,255,.7) 1px, transparent 1px)", backgroundSize: "22px 22px" }}
      />
      <div className="relative text-white">
        {breadcrumb && breadcrumb.length > 0 && (
          <div className="flex items-center gap-1.5 text-[12px] text-white/70">
            <Home className="h-3.5 w-3.5 shrink-0" />
            {breadcrumb.map((b, i) => (
              <Fragment key={b}>
                {i > 0 && <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${rtl ? "rotate-180" : ""}`} />}
                <span className={i === breadcrumb.length - 1 ? "text-white/90" : undefined}>{b}</span>
              </Fragment>
            ))}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-[24px] font-semibold tracking-tight sm:text-[28px]">{title}</h1>
          {badge}
        </div>
        {meta && <div className="mt-1 text-[12.5px] text-white/70">{meta}</div>}
        {description && <p className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-white/85">{description}</p>}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-3">{actions}</div>}
      </div>
      {corner && <div className="absolute end-5 top-5">{corner}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className = "", pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`card ${pad ? "p-5" : ""} ${className}`}>{children}</div>;
}

/** Stripe metric strip cell — used inside a bordered row of stats. */
export function StatCard({ label, value, hint, tone = "ink" }: { label: string; value: ReactNode; hint?: string; tone?: "ink" | "accent" | "green" }) {
  const tones: Record<string, string> = {
    ink: "text-ink",
    accent: "text-accent",
    green: "text-emerald-600 dark:text-emerald-400",
  };
  return (
    <div className="px-4 py-4">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={`mt-0.5 text-[22px] font-semibold tracking-tight tnum ${tones[tone]}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11.5px] text-muted">{hint}</div>}
    </div>
  );
}

export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="mb-5 grid grid-cols-2 divide-x divide-line-2 overflow-hidden rounded-xl2 border border-line bg-panel shadow-card md:grid-cols-4">{children}</div>;
}

const badgeTones: Record<string, string> = {
  gray: "badge-gray",
  green: "badge-green",
  amber: "badge-amber",
  red: "badge-red",
  blue: "badge-blue",
};
export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: keyof typeof badgeTones }) {
  return <span className={`badge ${badgeTones[tone]}`}>{children}</span>;
}

export function statusTone(status?: string | null): keyof typeof badgeTones {
  const s = (status ?? "").toLowerCase();
  if (/(new|draft)/.test(s)) return "gray";
  if (/(pending|sent|quoted|progress|assigned|in_transit)/.test(s)) return "amber";
  if (/(confirm|deliver|paid|accepted|approved|closed|completed)/.test(s)) return "green";
  if (/(reject|cancel|return|overdue|failed)/.test(s)) return "red";
  return "blue";
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <div className="text-[13px] font-medium text-ink">{title}</div>
      {hint && <div className="max-w-sm text-[12px] text-muted">{hint}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-16 text-[13px] text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label ?? "Loading…"}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

export function ComingSoon({ title, note }: { title: string; note?: string }) {
  return (
    <div className="card border-dashed p-0">
      <EmptyState
        title={`${title} — in progress`}
        hint={note ?? "This screen is scaffolded and will be wired to the API in an upcoming step."}
      />
    </div>
  );
}
