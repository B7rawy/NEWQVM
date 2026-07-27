import { useState } from "react";
import { AlertTriangle, Bookmark, BookmarkPlus, Plus, Trash2, Wand2, Zap } from "lucide-react";

/**
 * When a move fires by itself, and what it does afterwards (QNEW-90 items 3, 4 and 5).
 *
 * A picker, never a formula editor — same reason as the gates: the catalog is code, so an admin
 * choosing "put it on hold" from a list cannot write something wrong, slow, or reaching into
 * another workspace's data.
 *
 * The two halves sit in one panel because they answer one question a person actually asks — "and
 * then what happens?" — but they are labelled apart, because one is about WHEN the move fires and
 * the other about what follows it. Merging the words would hide that an automatic move still has to
 * satisfy every rule above it; the engine gives automation no privilege a person would not have.
 */

export interface ActionCfg {
  action: string;
  params: Record<string, unknown>;
  /**
   * THE RECEIPT. Where this configuration was copied from, if it came from the saved-actions
   * library. It is a record of provenance and nothing more: the engine never follows it, which is
   * exactly why editing a saved action cannot change a flow that is already running.
   */
  ref?: { id: string; name: string } | null;
}

/** A named, reusable configuration. `used_by_flows` is how many flows carry a receipt for it. */
export interface LibraryEntry {
  id: string;
  name_en: string;
  name_ar: string;
  action: string;
  params: Record<string, unknown>;
  used_by_flows?: number;
}

/** Same params, ignoring key order — what "this copy has drifted from the saved action" means. */
function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => String(a[k] ?? "") === String(b[k] ?? ""));
}
export interface ActionDef {
  key: string; labelEn: string; labelAr: string; helpEn: string;
  params: Array<{ key: string; labelEn: string; type: string; options?: string[]; default?: unknown }>;
  entities: string[];
}

export default function ActionEditor({
  actions, defs, domainEntities, autoAdvance, autoOnce, disabled, onChange,
  library, onSaveToLibrary, frozen,
}: {
  actions: ActionCfg[];
  defs: ActionDef[];
  /** Saved actions this workspace has named. Picking one COPIES it and stamps a receipt. */
  library?: LibraryEntry[];
  /** Name the configuration in front of you so it can be reused. Absent = no library plumbing. */
  onSaveToLibrary?: (a: ActionCfg) => void;
  /** An ACTIVE flow. Drift exists but must never be offered for update — that is the freeze. */
  frozen?: boolean;
  /** The entity types this flow's own domain governs, so the picker offers only what can ever run. */
  domainEntities: string[];
  autoAdvance: boolean;
  autoOnce: boolean;
  disabled?: boolean;
  onChange: (next: { actions: ActionCfg[]; autoAdvance: boolean; autoOnce: boolean }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const defOf = (k: string) => defs.find((d) => d.key === k);
  const patch = (p: Partial<{ actions: ActionCfg[]; autoAdvance: boolean; autoOnce: boolean }>) =>
    onChange({ actions, autoAdvance, autoOnce, ...p });

  /** An action whose entities miss this flow's domain entirely would only ever log "skipped". */
  const applicable = defs.filter((d) => d.entities.some((e) => domainEntities.includes(e)));

  return (
    <div className="rounded-md border border-line bg-panel p-2.5">
      {/* ── WHEN ─────────────────────────────────────────────────────────────────────────── */}
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink">
        <Zap className="h-3.5 w-3.5 text-muted" />
        Does this move need a person?
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {([
          [false, "Somebody does it", "A person presses the button. Nothing happens on its own."],
          [true, "It happens by itself", "The moment the rules above are satisfied, the record moves — no button."],
        ] as const).map(([k, label, hint]) => (
          <button key={String(k)} disabled={disabled} title={hint}
            onClick={() => patch({ autoAdvance: k })}
            className={`rounded-md border px-1.5 py-1 text-[10.5px] leading-none transition disabled:opacity-50 ${
              autoAdvance === k
                ? "border-navy bg-navy text-white"
                : "border-line bg-panel text-muted hover:border-line-2"}`}>
            {label}
          </button>
        ))}
      </div>
      {autoAdvance && (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {([
              [true, "Once per order", "If the order comes back here later, it will not fire again."],
              [false, "Every time it gets here", "Fires again each time the record returns to this status."],
            ] as const).map(([k, label, hint]) => (
              <button key={String(k)} disabled={disabled} title={hint}
                onClick={() => patch({ autoOnce: k })}
                className={`rounded-md border px-1.5 py-1 text-[10.5px] leading-none transition disabled:opacity-50 ${
                  autoOnce === k
                    ? "border-navy bg-navy text-white"
                    : "border-line bg-panel text-muted hover:border-line-2"}`}>
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-faint">
            It still has to pass every rule above — the workflow gets no shortcut a person would not
            get. A chain of automatic moves stops after three, so a mistake cannot run an order to
            the end of the flow.
          </p>
        </>
      )}

      {/* ── WHAT ─────────────────────────────────────────────────────────────────────────── */}
      <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11.5px] font-semibold text-ink">
        <Wand2 className="h-3.5 w-3.5 text-muted" />
        Then do this, without anyone asking
      </p>

      {actions.length === 0 && !adding && (
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          Nothing — the record just moves.
        </p>
      )}

      {actions.map((a, i) => {
        const d = defOf(a.action);
        return (
          <div key={i} className="mt-2 rounded-md border border-line bg-surface p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink">{d?.labelEn ?? a.action}</p>
                {d && <p className="mt-0.5 text-[10.5px] leading-relaxed text-faint">{d.helpEn}</p>}
                {!d && (
                  <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-accent">
                    <AlertTriangle className="h-3 w-3" />
                    This server does not know this action — saving will be refused until it is removed.
                  </p>
                )}
                {/* An action that cannot apply here is not an error, but it will never do anything,
                    and finding that out from a run log weeks later is nobody's idea of a good time. */}
                {d && !d.entities.some((e) => domainEntities.includes(e)) && (
                  <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-[var(--chip-amber-fg)]">
                    <AlertTriangle className="h-3 w-3" />
                    Does not apply to anything in this workflow — it will be skipped every time.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!disabled && !a.ref && onSaveToLibrary && (
                  <button onClick={() => onSaveToLibrary(a)}
                    className="rounded p-0.5 text-faint hover:text-ink"
                    title="Save this configuration under a name so other moves can use it">
                    <BookmarkPlus className="h-3.5 w-3.5" />
                  </button>
                )}
                {!disabled && (
                  <button onClick={() => patch({ actions: actions.filter((_, n) => n !== i) })}
                    className="rounded p-0.5 text-faint hover:text-accent" title="Remove this">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Provenance, and the drift offer. A copy that no longer matches its saved action is
                NOT a problem to be fixed automatically — this flow is running what it was built
                with, on purpose. On a draft you may pull the change in; on an active flow the
                button is absent rather than disabled, because an offer you cannot accept is worse
                than no offer. */}
            {a.ref && (() => {
              const entry = (library ?? []).find((l) => l.id === a.ref!.id);
              const drifted = entry && !sameParams(entry.params, a.params);
              return (
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-faint">
                  <Bookmark className="h-3 w-3" />
                  from <b className="font-medium text-muted">{a.ref.name}</b>
                  {!entry && <span className="text-[var(--chip-amber-fg)]">· that saved action has since been deleted</span>}
                  {drifted && (
                    <>
                      <span className="text-[var(--chip-amber-fg)]">· the saved action has changed since</span>
                      {!disabled && !frozen && (
                        <button
                          onClick={() => patch({
                            actions: actions.map((x, n) => (n === i ? { ...x, params: { ...entry!.params } } : x)),
                          })}
                          className="rounded border border-line px-1 py-0.5 text-[10px] text-muted hover:border-navy hover:text-ink">
                          use the new version
                        </button>
                      )}
                    </>
                  )}
                </p>
              );
            })()}

            {d?.params.map((p) => (
              <label key={p.key} className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="min-w-[9rem]">{p.labelEn}</span>
                {p.type === "enum" ? (
                  <select disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                    value={String(a.params[p.key] ?? p.default ?? "")}
                    onChange={(e) => patch({
                      actions: actions.map((x, n) => (n === i ? { ...x, params: { ...x.params, [p.key]: e.target.value } } : x)),
                    })}>
                    <option value="">Choose…</option>
                    {(p.options ?? []).map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
                  </select>
                ) : p.type === "number" ? (
                  <input type="number" disabled={disabled} className="input h-7 w-24 text-[11.5px]"
                    value={String(a.params[p.key] ?? p.default ?? "")}
                    onChange={(e) => patch({
                      actions: actions.map((x, n) => (n === i ? { ...x, params: { ...x.params, [p.key]: e.target.value ? Number(e.target.value) : null } } : x)),
                    })} />
                ) : (
                  <input disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                    value={String(a.params[p.key] ?? p.default ?? "")}
                    onChange={(e) => patch({
                      actions: actions.map((x, n) => (n === i ? { ...x, params: { ...x.params, [p.key]: e.target.value } } : x)),
                    })} />
                )}
              </label>
            ))}
          </div>
        );
      })}

      {!disabled && (
        adding ? (
          <div className="mt-2 rounded-md border border-navy/30 bg-surface p-2">
            <p className="mb-1.5 text-[11px] text-muted">What should happen the moment it lands here?</p>

            {(library ?? []).filter((l) => applicable.some((d) => d.key === l.action)).length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Saved actions</p>
                <div className="flex flex-col gap-1">
                  {(library ?? [])
                    .filter((l) => applicable.some((d) => d.key === l.action))
                    .map((l) => (
                      <button key={l.id}
                        onClick={() => {
                          // COPY, not a pointer. The receipt records where it came from; the copy is
                          // what runs, which is what keeps an active flow doing what it froze.
                          patch({
                            actions: [...actions, {
                              action: l.action,
                              params: { ...l.params },
                              ref: { id: l.id, name: l.name_en },
                            }],
                          });
                          setAdding(false);
                        }}
                        className="rounded-md border border-line bg-panel px-2 py-1.5 text-left transition hover:border-navy">
                        <span className="flex items-center gap-1.5">
                          <Bookmark className="h-3 w-3 shrink-0 text-faint" />
                          <span className="text-[11.5px] font-medium text-ink">{l.name_en}</span>
                          <span className="text-[10.5px] text-faint">{l.name_ar}</span>
                        </span>
                        <span className="block text-[10.5px] leading-relaxed text-faint">
                          {defOf(l.action)?.labelEn ?? l.action}
                          {l.used_by_flows ? ` · used by ${l.used_by_flows} ${l.used_by_flows === 1 ? "flow" : "flows"}` : ""}
                        </span>
                      </button>
                    ))}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                  Picking one copies its settings here. Editing the saved action later will not change
                  this move, or any other that already uses it.
                </p>
                <p className="mb-1 mt-2 text-[10.5px] font-semibold uppercase tracking-wide text-faint">Or start from scratch</p>
              </div>
            )}

            <div className="flex flex-col gap-1">
              {applicable.map((d) => (
                <button key={d.key}
                  onClick={() => {
                    patch({
                      actions: [...actions, {
                        action: d.key,
                        params: Object.fromEntries(
                          d.params.filter((p) => p.default !== undefined).map((p) => [p.key, p.default]),
                        ),
                      }],
                    });
                    setAdding(false);
                  }}
                  className="rounded-md border border-line bg-panel px-2 py-1.5 text-left transition hover:border-navy">
                  <span className="block text-[11.5px] font-medium text-ink">{d.labelEn}</span>
                  <span className="block text-[10.5px] leading-relaxed text-faint">{d.helpEn}</span>
                </button>
              ))}
              {applicable.length === 0 && (
                <p className="text-[11px] text-faint">
                  Nothing in the catalogue applies to this kind of record.
                </p>
              )}
            </div>
            <button onClick={() => setAdding(false)} className="btn btn-sm mt-1.5">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface hover:text-ink">
            <Plus className="h-3 w-3" /> Add something
          </button>
        )
      )}
    </div>
  );
}
