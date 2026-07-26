import { AlertTriangle, ArrowRight, Lock, Plus, Users, X } from "lucide-react";

/**
 * The SAME workflow you are drawing, read as screens.
 *
 * Not a separate page and not a second source of truth — it derives everything from the graph the
 * canvas already has in memory. Placing a status here is the same edit as ticking a chip in the
 * inspector, so the two views cannot disagree and there is nothing to keep in sync.
 *
 * Why it exists: a graph of statuses answers "what may follow what". It does not answer the question
 * someone running the business actually asks — "what does my pricing team see, and where does the
 * order go when they are done". That is the same data grouped by page instead of by node.
 */

export interface PVStep {
  status: string; label: string; isEntry: boolean; isTerminal: boolean;
  pages: string[]; ownerRoles: string[];
}
export interface PVEdge {
  from: string; to: string; label?: string | null;
  requiresApproval: boolean; allowedRoles: string[]; handoff: string;
}
export interface PVPage {
  key: string; path: string; labelEn: string; labelAr: string;
  personas: string[]; wired: boolean;
}

/** Routing only actually filters where the endpoint asks for it. Saying so beats a silent placebo. */
const ROUTING_LIVE = new Set(["rfqs", "orders"]);
const PERSONA_GROUP: Record<string, string> = {
  internal: "Our team", workshop: "Workshop", vendor: "Vendor",
};
const role = (r: string) => r.replace(/_/g, " ");

export default function PagesView({
  steps, edges, pages, holders, frozen, selected, onSelect, onPlace,
}: {
  steps: PVStep[];
  edges: PVEdge[];
  pages: PVPage[];
  holders: Record<string, number>;
  frozen: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onPlace: (status: string, pages: string[]) => void;
}) {
  const page = pages.find((p) => p.key === selected) ?? pages[0] ?? null;
  const unplaced = steps.filter((s) => s.pages.length === 0);
  const pagesOf = (code: string) =>
    pages.filter((p) => steps.find((s) => s.status === code)?.pages.includes(p.key));

  const here = page ? steps.filter((s) => s.pages.includes(page.key)) : [];
  const codes = new Set(here.map((s) => s.status));
  const exits = page ? edges.filter((e) => codes.has(e.from)) : [];

  const badge = (p: PVPage) =>
    !p.wired ? <span className="text-[11px] text-faint">Not built yet</span>
    : !ROUTING_LIVE.has(p.key) ? <span className="text-[11px] text-faint">No effect yet</span>
    : <span className="flex items-center gap-1 text-[11px] text-[var(--chip-green-fg)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--chip-green-fg)]" /> Live
      </span>;

  if (steps.length === 0)
    return (
      <div className="grid h-full place-items-center">
        <div className="max-w-sm text-center">
          <p className="text-[13.5px] font-medium text-sub">Nothing to lay out yet</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-faint">
            Add a step in the diagram — or describe the flow to the assistant — and it will appear
            here, ready to place on a screen.
          </p>
        </div>
      </div>
    );

  return (
    <div className="grid h-full grid-cols-[minmax(0,260px)_minmax(0,1fr)] overflow-hidden">
      {/* ── the screens ──────────────────────────────────────────────────────── */}
      <aside className="overflow-auto border-r border-line bg-panel p-2.5">
        {["internal", "workshop", "vendor"].map((persona) => {
          const rows = pages.filter((p) => p.personas.includes(persona));
          if (!rows.length) return null;
          return (
            <div key={persona} className="mb-3">
              <p className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
                {PERSONA_GROUP[persona]}
              </p>
              {rows.map((p) => {
                const n = steps.filter((s) => s.pages.includes(p.key)).length;
                return (
                  <button key={p.key} onClick={() => onSelect(p.key)}
                    className={`mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition ${
                      page?.key === p.key ? "bg-accent-50" : "hover:bg-surface"}`}>
                    <span className="text-[12.5px] font-medium text-ink">{p.labelEn}</span>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-[11px] text-muted">{n} placed</span>
                      {badge(p)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}

        {/* The safety rule as an object you can see. A status placed nowhere shows EVERYWHERE, and
            that is the most surprising behaviour in the whole engine. */}
        {unplaced.length > 0 && (
          <div className="rounded-md border border-[var(--chip-amber-bg)] bg-[var(--chip-amber-bg)]/20 p-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
              <AlertTriangle className="h-3.5 w-3.5 text-[var(--chip-amber-fg)]" />
              Not placed — {unplaced.length}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              These show on <b>every</b> screen until you place them.
            </p>
          </div>
        )}
      </aside>

      {/* ── the page ─────────────────────────────────────────────────────────── */}
      <div className="overflow-auto p-4">
        {page && (
          <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">
                {page.labelEn} <span className="text-[13px] font-normal text-muted">{page.labelAr}</span>
              </h2>
              <p className="mt-0.5 flex items-center gap-2 font-mono text-[11.5px] text-faint">
                {page.path} {badge(page)}
              </p>
              {page.wired && !ROUTING_LIVE.has(page.key) && (
                <p className="mt-2 rounded-md bg-surface px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                  This screen exists, but its list does not filter by the workflow yet — placing here
                  will not change what it shows until that is wired up.
                </p>
              )}
            </div>

            {/* what sits here */}
            <div className="rounded-lg border border-line bg-panel">
              <p className="border-b border-line px-3.5 py-2.5 text-[12.5px] font-semibold text-ink">
                What sits on this screen
              </p>
              {here.length === 0 ? (
                <p className="px-3.5 py-5 text-center text-[12px] text-faint">
                  Nothing placed here, so this screen shows everything by default.
                </p>
              ) : here.map((s) => (
                <div key={s.status} className="flex items-start justify-between gap-3 border-b border-line px-3.5 py-2.5 last:border-0">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-medium text-ink">
                      {s.label}
                      {s.isEntry && <span className="ml-1.5 rounded bg-[var(--chip-green-bg)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--chip-green-fg)]">START</span>}
                      {s.isTerminal && <span className="ml-1.5 rounded bg-[var(--chip-gray-bg)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--chip-gray-fg)]">END</span>}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                      <Users className="h-3 w-3" />
                      {s.ownerRoles.length
                        ? <>Handled by {s.ownerRoles.map(role).join(", ")}</>
                        : <span className="text-faint">Anyone who can open this screen</span>}
                      {s.ownerRoles.some((r) => !holders[r]) && (
                        <span className="text-accent">· nobody holds that role</span>
                      )}
                      {pagesOf(s.status).length > 1 && (
                        <span className="text-faint">
                          · also on {pagesOf(s.status).filter((p) => p.key !== page.key).map((p) => p.labelEn).join(", ")}
                        </span>
                      )}
                    </p>
                  </div>
                  <button
                    onClick={() => onPlace(s.status, s.pages.filter((k) => k !== page.key))}
                    title="Remove from this screen"
                    className="shrink-0 rounded p-1 text-faint hover:bg-surface hover:text-accent">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}

              {/* place something here */}
              {steps.some((s) => !s.pages.includes(page.key)) && (
                <div className="border-t border-line bg-surface p-2.5">
                  <p className="mb-1.5 flex items-center gap-1 text-[11px] text-muted">
                    <Plus className="h-3 w-3" /> Place a status on this screen
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {steps.filter((s) => !s.pages.includes(page.key)).map((s) => (
                      <button key={s.status}
                        onClick={() => onPlace(s.status, [...s.pages, page.key])}
                        className={`rounded-md border px-1.5 py-1 text-[11px] leading-none transition ${
                          s.pages.length === 0
                            ? "border-[var(--chip-amber-fg)]/40 bg-panel text-sub hover:border-navy"
                            : "border-line bg-panel text-muted hover:border-navy hover:text-ink"}`}
                        title={s.pages.length === 0 ? "Not placed anywhere — currently shows on every screen" : undefined}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* what happens next */}
            <div className="rounded-lg border border-line bg-panel">
              <p className="border-b border-line px-3.5 py-2.5 text-[12.5px] font-semibold text-ink">
                What can happen next
              </p>
              {exits.length === 0 ? (
                <p className="px-3.5 py-5 text-center text-[12px] text-faint">
                  Nothing placed here has anywhere to go yet.
                </p>
              ) : exits.map((e, i) => {
                const dest = pagesOf(e.to);
                const stays = dest.some((p) => p.key === page.key);
                const toLabel = steps.find((s) => s.status === e.to)?.label ?? e.to;
                return (
                  <div key={i} className="flex items-start gap-2.5 border-b border-line px-3.5 py-2.5 last:border-0">
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
                    <div className="min-w-0">
                      <p className="text-[12.5px] text-ink">
                        <b>{e.label || "Move"}</b>
                        {e.requiresApproval && (
                          <span className="ml-1.5 rounded bg-[var(--chip-amber-bg)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--chip-amber-fg)]">
                            APPROVAL
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">
                        {stays ? <>Stays here, becomes <b>{toLabel}</b></>
                          : dest.length ? <>Goes to <b>{dest.map((p) => p.labelEn).join(", ")}</b> — becomes {toLabel}</>
                          : <>Becomes <b>{toLabel}</b>, which is not on any screen, so it shows everywhere</>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-faint">
                        {e.allowedRoles.length ? `Only ${e.allowedRoles.map(role).join(" or ")}` : "Anyone who can reach it"}
                        {" · "}
                        {e.handoff === "keep" ? "same person keeps it"
                          : e.handoff === "actor" ? "whoever does it takes it on"
                          : "hands to the next desk"}
                      </p>
                    </div>
                  </div>
                );
              })}
              <p className="flex items-center gap-1.5 border-t border-line bg-surface px-3.5 py-2 text-[11px] text-faint">
                <Lock className="h-3 w-3" />
                {frozen
                  ? "This workflow is published — screens can still be changed, rules cannot."
                  : "Edit these in the diagram; they are rules, not layout."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
