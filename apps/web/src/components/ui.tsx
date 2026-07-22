import type { ReactNode } from "react";

/** Stripe-language UI primitives, QVM red accent. */

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
    green: "text-emerald-600",
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
  return <div className="mb-5 grid grid-cols-2 divide-x divide-line-2 overflow-hidden rounded-xl2 border border-line bg-white shadow-card md:grid-cols-4">{children}</div>;
}

const badgeTones: Record<string, string> = {
  gray: "bg-[#e3e8ee] text-sub",
  green: "bg-[#cbf4c9] text-[#0e6245]",
  amber: "bg-[#fcedb9] text-[#8a6d00]",
  red: "bg-accent-50 text-accent",
  blue: "bg-[#d6ecff] text-[#3d4eac]",
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
