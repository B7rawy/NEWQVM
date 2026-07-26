import { useState } from "react";
import { AlertTriangle, ArrowRight, Plus, Sparkles, Trash2, Users, X } from "lucide-react";

/**
 * PAGES — the primary way to build a workflow.
 *
 * The diagram answers "what may follow what", which is a question about a graph. The question people
 * running this business actually ask is "what does my pricing team see, and where does the order go
 * when they are done" — and that is the same data grouped by screen instead of by node.
 *
 * This view is DELIBERATELY self-sufficient: you can add a status, say who handles it, and define
 * where work goes next without ever opening the diagram. The diagram is for people who want to see
 * the shape; it is not a step you are forced through.
 *
 * Nothing here is a second source of truth — every edit goes through the same graph state the
 * diagram edits, so the two readings can never disagree.
 */

/** A station this step sits on, and what that station may do about it (QNEW-89 §3). */
export type PageMode = "action" | "watch" | "optional";
export interface Placement { page: string; mode: PageMode; afterHours?: number | null }
export interface PVStep {
  status: string; label: string; isEntry: boolean; isTerminal: boolean;
  pages: Placement[]; ownerRoles: string[];
}

/** What each mode means, in the words that go on the screen. */
export const MODES: Array<{ key: PageMode; label: string; hint: string }> = [
  { key: "action", label: "Works on it", hint: "This desk owns it — its buttons are live" },
  { key: "watch", label: "Watches only", hint: "Can see it and follow progress, cannot act" },
  { key: "optional", label: "Can step in", hint: "May take over from whoever owns it" },
];
export interface PVEdge {
  from: string; to: string; label?: string | null;
  requiresApproval: boolean; allowedRoles: string[]; handoff: string;
}
export interface PVPage {
  key: string; path: string; labelEn: string; labelAr: string;
  personas: string[]; wired: boolean;
}
export interface PVCatalog { code: string; label_en: string; label_ar: string }

/** Routing only actually filters where the endpoint asks for it. Saying so beats a silent placebo. */
const ROUTING_LIVE = new Set(["rfqs", "orders"]);
const PERSONA_GROUP: Record<string, string> = {
  internal: "Our team", workshop: "Workshop", vendor: "Vendor",
};
const role = (r: string) => r.replace(/_/g, " ");

export default function PagesView({
  steps, edges, pages, catalog, roles, holders, frozen, selected,
  onSelect, onPlace, onAddStatus, onPatchStep, onAddAction, onRemoveAction, onAskAssistant,
}: {
  steps: PVStep[];
  edges: PVEdge[];
  pages: PVPage[];
  catalog: PVCatalog[];
  roles: string[];
  holders: Record<string, number>;
  frozen: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  onPlace: (status: string, pages: Placement[]) => void;
  onAddStatus: (code: string, pageKey: string, mode?: PageMode) => void;
  onPatchStep: (code: string, patch: Partial<PVStep>) => void;
  onAddAction: (from: string, to: string, label: string) => void;
  onRemoveAction: (from: string, to: string) => void;
  onAskAssistant: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [actionFor, setActionFor] = useState<string | null>(null);
  const [openRoles, setOpenRoles] = useState<string | null>(null);

  const page = pages.find((p) => p.key === selected) ?? pages[0] ?? null;
  const unplaced = steps.filter((s) => s.pages.length === 0);
  const placementOn = (code: string, key: string) =>
    byCode.get(code)?.pages.find((p) => p.page === key) ?? null;
  const byCode = new Map(steps.map((s) => [s.status, s]));
  const pagesOf = (code: string) =>
    pages.filter((p) => byCode.get(code)?.pages.some((x) => x.page === p.key));

  const here = page ? steps.filter((s) => s.pages.some((p) => p.page === page.key)) : [];

  const badge = (p: PVPage) =>
    !p.wired ? <span className="text-[11px] text-faint">Not built yet</span>
    : !ROUTING_LIVE.has(p.key) ? <span className="text-[11px] text-faint">No effect yet</span>
    : <span className="flex items-center gap-1 text-[11px] text-[var(--chip-green-fg)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--chip-green-fg)]" /> Live
      </span>;

  // With no statuses there is nothing to arrange, and showing seven empty screens plus a technical
  // warning answers a question nobody asked. One instruction instead.
  if (steps.length === 0)
    return (
      <div className="grid h-full place-items-center overflow-auto bg-surface p-6">
        <div className="w-full max-w-lg text-center">
          <h2 className="text-[18px] font-semibold text-ink">Set up your order flow</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">
            Describe how an order moves through your business — in Arabic or English — and it will be
            laid out for you across your screens. You can change anything afterwards.
          </p>

          <button onClick={onAskAssistant}
            className="btn-primary mx-auto mt-4 rounded-md px-4 py-2 text-[13px]">
            <Sparkles className="h-4 w-4" /> Describe my flow
          </button>

          <div className="mt-6 rounded-lg border border-line bg-panel p-4 text-left">
            <p className="text-[12px] font-semibold text-ink">For example, you could say:</p>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-sub" dir="rtl">
              «لما يجي طلب جديد يروح لفريق التسعير، وبعد ما يتسعّر يتبعت للتأمين، ولما التأمين يوافق
              يتحوّل لأمر شراء»
            </p>
          </div>

          <details className="mt-5 text-left">
            <summary className="cursor-pointer text-[12.5px] text-muted hover:text-ink">
              Or set it up yourself, one status at a time
            </summary>
            <div className="mt-2.5 rounded-lg border border-line bg-panel p-3">
              <p className="mb-2 text-[11.5px] leading-relaxed text-muted">
                Pick the first thing that happens to a new order. You will then say where it goes next.
              </p>
              <div className="flex max-h-56 flex-wrap gap-1 overflow-auto">
                {catalog.map((c) => (
                  <button key={c.code}
                    onClick={() => onAddStatus(c.code, pages[0]?.key ?? "rfqs", "action")}
                    className="rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] leading-none text-sub transition hover:border-navy hover:text-ink">
                    {c.label_en}
                  </button>
                ))}
              </div>
            </div>
          </details>
        </div>
      </div>
    );

  return (
    <div className="grid h-full grid-cols-[minmax(0,250px)_minmax(0,1fr)] overflow-hidden">
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
                const n = steps.filter((s) => s.pages.some((x) => x.page === p.key)).length;
                return (
                  <button key={p.key} onClick={() => { onSelect(p.key); setAdding(false); setActionFor(null); }}
                    className={`mb-0.5 flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition ${
                      page?.key === p.key ? "bg-accent-50" : "hover:bg-surface"}`}>
                    <span className="text-[12.5px] font-medium text-ink">{p.labelEn}</span>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-[11px] text-muted">{n} here</span>
                      {badge(p)}
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}

        {/* The safety rule as something you can see. A status placed nowhere shows EVERYWHERE — the
            most surprising behaviour in the engine, and invisible until now. */}
        {unplaced.length > 0 && (
          <div className="rounded-md border border-[var(--chip-amber-bg)] bg-[var(--chip-amber-bg)]/20 p-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-ink">
              <AlertTriangle className="h-3.5 w-3.5 text-[var(--chip-amber-fg)]" />
              On no screen — {unplaced.length}
            </p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
              {unplaced.map((s) => s.label).join(", ")} — these show on <b>every</b> screen until you
              put them somewhere.
            </p>
          </div>
        )}
      </aside>

      {/* ── the page ─────────────────────────────────────────────────────────── */}
      <div className="overflow-auto bg-surface p-4">
        {page && (
          <div className="mx-auto flex max-w-2xl flex-col gap-3.5">
            <div>
              <h2 className="text-[16px] font-semibold text-ink">
                {page.labelEn} <span className="text-[13px] font-normal text-muted">{page.labelAr}</span>
              </h2>
              <p className="mt-0.5 flex items-center gap-2 font-mono text-[11.5px] text-faint">
                {page.path} {badge(page)}
              </p>

            </div>


            {/* what sits here */}
            <div className="rounded-lg border border-line bg-panel">
              <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
                <p className="text-[12.5px] font-semibold text-ink">What people see on this screen</p>
                <button onClick={() => setAdding((v) => !v)} className="btn btn-sm">
                  <Plus className="h-3.5 w-3.5" /> Add
                </button>
              </div>

              {adding && (
                <div className="border-b border-line bg-surface p-3">
                  <p className="mb-1.5 text-[11.5px] text-muted">
                    Pick a status to show on <b>{page.labelEn}</b>. A status can sit on more than one screen.
                  </p>
                  <div className="flex max-h-52 flex-wrap gap-1 overflow-auto">
                    {catalog
                      .filter((c) => !byCode.get(c.code)?.pages.some((p) => p.page === page.key))
                      .map((c) => {
                        const inFlow = byCode.has(c.code);
                        return (
                          <button key={c.code}
                            onClick={() => {
                              if (inFlow) onPlace(c.code, [...byCode.get(c.code)!.pages, { page: page.key, mode: "action" }]);
                              else onAddStatus(c.code, page.key);
                              setAdding(false);
                            }}
                            title={inFlow ? "Already in this workflow — also show it here" : "Add to this workflow and show it here"}
                            className={`rounded-md border px-2 py-1 text-[11.5px] leading-none transition ${
                              inFlow
                                ? "border-line bg-panel text-muted hover:border-navy hover:text-ink"
                                : "border-dashed border-line-2 bg-panel text-sub hover:border-navy hover:text-ink"}`}>
                            {c.label_en}
                          </button>
                        );
                      })}
                  </div>
                  <p className="mt-2 text-[10.5px] text-faint">
                    Dashed = not in this workflow yet; picking it adds it.
                  </p>
                </div>
              )}

              {here.length === 0 ? (
                <p className="px-3.5 py-5 text-center text-[12px] text-faint">
                  Nothing here yet, so this screen shows everything by default.
                </p>
              ) : here.map((s) => {
                const outs = edges.filter((e) => e.from === s.status);
                return (
                  <div key={s.status} className="border-b border-line px-3.5 py-3 last:border-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-ink">
                          {s.label}
                          {s.isEntry && <span className="ml-1.5 rounded bg-[var(--chip-green-bg)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--chip-green-fg)]">STARTS HERE</span>}
                          {s.isTerminal && <span className="ml-1.5 rounded bg-[var(--chip-gray-bg)] px-1.5 py-0.5 text-[9.5px] font-bold text-[var(--chip-gray-fg)]">FINISHED</span>}
                        </p>
                        {(() => {
                          const pl = placementOn(s.status, page.key);
                          const m = MODES.find((x) => x.key === (pl?.mode ?? "action"))!;
                          return (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {MODES.map((opt) => (
                                <button key={opt.key} disabled={frozen} title={opt.hint}
                                  onClick={() => onPlace(s.status, s.pages.map((p) =>
                                    p.page === page.key ? { ...p, mode: opt.key } : p))}
                                  className={`rounded-md border px-1.5 py-0.5 text-[10.5px] leading-none transition disabled:opacity-50 ${
                                    m.key === opt.key
                                      ? "border-navy bg-navy text-white"
                                      : "border-line bg-surface text-muted hover:border-line-2 hover:text-sub"}`}>
                                  {opt.label}
                                </button>
                              ))}
                              {m.key === "optional" && (
                                <label className="ml-1 flex items-center gap-1 text-[10.5px] text-faint">
                                  after
                                  <input type="number" min={1} disabled={frozen}
                                    value={pl?.afterHours ?? ""} placeholder="—"
                                    onChange={(e) => onPlace(s.status, s.pages.map((p) =>
                                      p.page === page.key
                                        ? { ...p, afterHours: e.target.value ? Number(e.target.value) : null }
                                        : p))}
                                    className="h-5 w-12 rounded border border-line bg-panel px-1 text-center text-[10.5px] text-ink outline-none" />
                                  h
                                </label>
                              )}
                            </div>
                          );
                        })()}

                        <button
                          onClick={() => setOpenRoles(openRoles === s.status ? null : s.status)}
                          disabled={frozen}
                          className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted hover:text-ink disabled:hover:text-muted">
                          <Users className="h-3 w-3" />
                          {s.ownerRoles.length
                            ? <>Handled by <b className="font-medium text-sub">{s.ownerRoles.map(role).join(", ")}</b></>
                            : <span className="text-faint">Anyone who can open this screen</span>}
                          {s.ownerRoles.some((r) => !holders[r]) && (
                            <span className="text-accent">· nobody holds that role</span>
                          )}
                        </button>
                        {pagesOf(s.status).length > 1 && (
                          <p className="mt-0.5 text-[11px] text-faint">
                            Also on {pagesOf(s.status).filter((p) => p.key !== page.key).map((p) => p.labelEn).join(", ")}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {!frozen && (
                          <>
                            <button onClick={() => onPatchStep(s.status, { isTerminal: !s.isTerminal })}
                              title={s.isTerminal ? "Not the end after all" : "The order is finished at this point"}
                              className="rounded px-1.5 py-1 text-[10.5px] text-faint hover:bg-surface hover:text-sub">
                              {s.isTerminal ? "not the end" : "ends here"}
                            </button>
                          </>
                        )}
                        <button onClick={() => onPlace(s.status, s.pages.filter((p) => p.page !== page.key))}
                          title="Take it off this screen"
                          className="rounded p-1 text-faint hover:bg-surface hover:text-accent">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {(() => {
                      const m = placementOn(s.status, page.key)?.mode ?? "action";
                      if (m === "action") return null;
                      const hrs = placementOn(s.status, page.key)?.afterHours;
                      return (
                        <p className="mt-1 text-[11px] leading-relaxed text-faint">
                          {m === "watch"
                            ? "People here see it and can follow who is holding it — they cannot move it."
                            : hrs
                              ? `People here may take over, but only after it has sat here for ${hrs}h.`
                              : "People here may take over from whoever owns it."}
                        </p>
                      );
                    })()}

                    {openRoles === s.status && !frozen && (
                      <div className="mt-2 rounded-md border border-line bg-surface p-2.5">
                        <p className="mb-1.5 text-[11px] text-muted">Who is responsible while it sits here?</p>
                        <div className="flex flex-wrap gap-1">
                          {roles.map((r) => {
                            const on = s.ownerRoles.includes(r);
                            return (
                              <button key={r}
                                onClick={() => onPatchStep(s.status, {
                                  ownerRoles: on ? s.ownerRoles.filter((x) => x !== r) : [...s.ownerRoles, r],
                                })}
                                title={holders[r] ? `${holders[r]} in this workspace` : "nobody holds this role — work would stall"}
                                className={`rounded-md border px-1.5 py-1 text-[11px] leading-none transition ${
                                  on ? "border-navy bg-navy text-white" : "border-line bg-panel text-sub hover:border-line-2"}`}>
                                {role(r)}{!holders[r] && on ? " ⚠" : ""}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-1.5 text-[10.5px] text-faint">
                          Leave it empty and anyone who can open the screen may act.
                        </p>
                      </div>
                    )}

                    {/* where it goes from here */}
                    <div className="mt-2 flex flex-col gap-1">
                      {outs.map((e) => {
                        const dest = pagesOf(e.to);
                        const stays = dest.some((p) => p.key === page.key);
                        const toLabel = byCode.get(e.to)?.label ?? e.to;
                        return (
                          <div key={e.to} className="group flex items-start gap-2 rounded-md bg-surface px-2.5 py-1.5">
                            <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
                            <div className="min-w-0 flex-1">
                              <p className="text-[12px] text-ink">
                                <b>{e.label || "Move"}</b>
                                {e.requiresApproval && (
                                  <span className="ml-1.5 rounded bg-[var(--chip-amber-bg)] px-1 py-0.5 text-[9.5px] font-bold text-[var(--chip-amber-fg)]">APPROVAL</span>
                                )}
                              </p>
                              <p className="text-[11px] leading-relaxed text-muted">
                                {stays ? <>stays on this screen, becomes {toLabel}</>
                                  : dest.length ? <>goes to <b>{dest.map((p) => p.labelEn).join(", ")}</b>, becomes {toLabel}</>
                                  : <>becomes {toLabel} — <span className="text-[var(--chip-amber-fg)]">not on any screen, so it shows everywhere</span></>}
                              </p>
                            </div>
                            {!frozen && (
                              <button onClick={() => onRemoveAction(e.from, e.to)}
                                className="shrink-0 rounded p-0.5 text-transparent group-hover:text-faint hover:!text-accent"
                                title="Remove this action">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        );
                      })}

                      {!frozen && (
                        actionFor === s.status ? (
                          <ActionBuilder
                            from={s}
                            steps={steps}
                            pages={pages}
                            catalog={catalog}
                            existing={outs.map((e) => e.to)}
                            onCancel={() => setActionFor(null)}
                            onCreate={(to, label, alsoPlaceOn) => {
                              if (!byCode.has(to)) onAddStatus(to, alsoPlaceOn ?? page.key);
                              else if (alsoPlaceOn && !byCode.get(to)!.pages.some((p) => p.page === alsoPlaceOn))
                                onPlace(to, [...byCode.get(to)!.pages, { page: alsoPlaceOn, mode: "action" }]);
                              onAddAction(s.status, to, label);
                              setActionFor(null);
                            }}
                          />
                        ) : (
                          <button onClick={() => setActionFor(s.status)}
                            className="self-start rounded-md px-2 py-1 text-[11.5px] text-muted hover:bg-surface hover:text-ink">
                            + What can happen from here?
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {page.wired && !ROUTING_LIVE.has(page.key) && (
              <p className="rounded-md border border-line bg-panel px-3 py-2 text-[11px] leading-relaxed text-faint">
                Note: this screen does not filter by the workflow yet, so what you set here will not
                change what it shows until that is wired up.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Creating an action, asked the way the owner thinks about it: WHERE does it go, then which status.
 *
 * The destination page is not stored anywhere — it follows where the destination status is placed.
 * Asking for it here and placing the status accordingly keeps one source of truth while still
 * letting someone answer in page terms.
 */
function ActionBuilder({
  from, steps, pages, catalog, existing, onCancel, onCreate,
}: {
  from: PVStep;
  steps: PVStep[];
  pages: PVPage[];
  catalog: PVCatalog[];
  existing: string[];
  onCancel: () => void;
  onCreate: (to: string, label: string, alsoPlaceOn: string | null) => void;
}) {
  const [dest, setDest] = useState<string>("__same__");
  const [to, setTo] = useState("");
  const [label, setLabel] = useState("");

  const byCode = new Map(steps.map((s) => [s.status, s]));
  const samePage = dest === "__same__";
  const targetPage = samePage ? (from.pages[0]?.page ?? null) : dest;

  // statuses already on the chosen screen come first — that is nearly always what is meant
  const onTarget = catalog.filter(
    (c) => targetPage && byCode.get(c.code)?.pages.some((p) => p.page === targetPage) && c.code !== from.status,
  );
  const others = catalog.filter(
    (c) => c.code !== from.status && !onTarget.some((o) => o.code === c.code),
  );

  return (
    <div className="rounded-md border border-navy/30 bg-panel p-2.5">
      <p className="mb-2 text-[11.5px] font-medium text-ink">What can happen from {from.label}?</p>

      <label className="mb-1.5 block">
        <span className="mb-0.5 block text-[11px] text-muted">Where does the order go?</span>
        <select className="input h-8 text-[12px]" value={dest} onChange={(e) => { setDest(e.target.value); setTo(""); }}>
          <option value="__same__">Stays on this screen</option>
          {pages.map((p) => <option key={p.key} value={p.key}>{p.labelEn}</option>)}
        </select>
      </label>

      <label className="mb-1.5 block">
        <span className="mb-0.5 block text-[11px] text-muted">What does it become?</span>
        <select className="input h-8 text-[12px]" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a status…</option>
          {onTarget.length > 0 && (
            <optgroup label="Already on that screen">
              {onTarget.filter((c) => !existing.includes(c.code)).map((c) => (
                <option key={c.code} value={c.code}>{c.label_en}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Other statuses">
            {others.filter((c) => !existing.includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.label_en}</option>
            ))}
          </optgroup>
        </select>
      </label>

      <label className="mb-2 block">
        <span className="mb-0.5 block text-[11px] text-muted">What do you call this action?</span>
        <input className="input h-8 text-[12px]" value={label} placeholder="e.g. Send to insurance"
          onChange={(e) => setLabel(e.target.value)} />
      </label>

      <div className="flex items-center gap-2">
        <button className="btn-primary rounded-md px-2.5 py-1 text-[12px]" disabled={!to}
          onClick={() => onCreate(to, label, samePage ? null : dest)}>
          Add
        </button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
