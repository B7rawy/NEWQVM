import { useState } from "react";
import { AlertTriangle, Plus, ShieldCheck, Trash2 } from "lucide-react";

/**
 * Choosing the rules that must hold before a move is allowed (QNEW-89 §4).
 *
 * The rules come from a code-defined catalog, so this is a picker and never a formula editor. An
 * admin choosing "every line must be priced" from a list cannot write something wrong, slow, or
 * dangerous — which is the whole reason the catalog is code.
 *
 * Two enforcement levels, and the difference is stated in the words on screen rather than left to a
 * dropdown label: `Stop it` refuses, `Warn and let them decide` refuses unless someone types a
 * reason, which is then recorded. Margin and quorum rules default to the second on purpose — the
 * first time a rule blocks an urgent order over a 4.8% margin, people stop trusting the engine.
 */

export interface GateCfg { gate: string; params: Record<string, unknown>; enforcement: "block" | "warn_override" }
export interface GateDef {
  key: string; labelEn: string; labelAr: string; helpEn: string;
  params: Array<{ key: string; labelEn: string; type: string; options?: string[]; default?: unknown }>;
  entities: string[]; defaultEnforcement: "block" | "warn_override";
}

export default function GateEditor({
  gates, defs, statuses, disabled, onChange,
}: {
  gates: GateCfg[];
  defs: GateDef[];
  /** The flow's own statuses, so a `status` parameter offers what this workflow actually contains. */
  statuses: Array<{ code: string; label: string }>;
  disabled?: boolean;
  onChange: (next: GateCfg[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const defOf = (k: string) => defs.find((d) => d.key === k);

  const setParam = (i: number, key: string, v: unknown) =>
    onChange(gates.map((g, n) => (n === i ? { ...g, params: { ...g.params, [key]: v } } : g)));

  return (
    <div className="rounded-md border border-line bg-panel p-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink">
        <ShieldCheck className="h-3.5 w-3.5 text-muted" />
        Rules before this can happen
      </p>

      {gates.length === 0 && !adding && (
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          None — anyone allowed to do this can do it at any time.
        </p>
      )}

      {gates.map((g, i) => {
        const d = defOf(g.gate);
        return (
          <div key={i} className="mt-2 rounded-md border border-line bg-surface p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-ink">{d?.labelEn ?? g.gate}</p>
                {d && <p className="mt-0.5 text-[10.5px] leading-relaxed text-faint">{d.helpEn}</p>}
                {!d && (
                  <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-accent">
                    <AlertTriangle className="h-3 w-3" />
                    This server does not know this rule — it will refuse every move until it is removed.
                  </p>
                )}
              </div>
              {!disabled && (
                <button onClick={() => onChange(gates.filter((_, n) => n !== i))}
                  className="shrink-0 rounded p-0.5 text-faint hover:text-accent" title="Remove this rule">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* parameters */}
            {d?.params.map((p) => (
              <label key={p.key} className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
                <span className="min-w-[9rem]">{p.labelEn}</span>
                {p.type === "status" ? (
                  <select disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                    value={String(g.params[p.key] ?? "")}
                    onChange={(e) => setParam(i, p.key, e.target.value)}>
                    <option value="">Choose…</option>
                    {statuses.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                  </select>
                ) : p.type === "enum" ? (
                  <select disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                    value={String(g.params[p.key] ?? p.default ?? "")}
                    onChange={(e) => setParam(i, p.key, e.target.value)}>
                    {(p.options ?? []).map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}
                  </select>
                ) : (
                  <input type="number" disabled={disabled} className="input h-7 w-24 text-[11.5px]"
                    value={String(g.params[p.key] ?? p.default ?? "")}
                    onChange={(e) => setParam(i, p.key, e.target.value ? Number(e.target.value) : null)} />
                )}
              </label>
            ))}

            {/* enforcement — the words matter more than the value */}
            <div className="mt-2 flex flex-wrap gap-1">
              {([
                ["block", "Stop it", "The move is refused. No reason gets around it."],
                ["warn_override", "Warn, but allow with a reason", "Refused unless someone types why — and that is recorded."],
              ] as const).map(([k, label, hint]) => (
                <button key={k} disabled={disabled} title={hint}
                  onClick={() => onChange(gates.map((x, n) => (n === i ? { ...x, enforcement: k } : x)))}
                  className={`rounded-md border px-1.5 py-1 text-[10.5px] leading-none transition disabled:opacity-50 ${
                    g.enforcement === k
                      ? "border-navy bg-navy text-white"
                      : "border-line bg-panel text-muted hover:border-line-2"}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {!disabled && (
        adding ? (
          <div className="mt-2 rounded-md border border-navy/30 bg-surface p-2">
            <p className="mb-1.5 text-[11px] text-muted">What has to be true first?</p>
            <div className="flex flex-col gap-1">
              {defs.filter((d) => !gates.some((g) => g.gate === d.key)).map((d) => (
                <button key={d.key}
                  onClick={() => {
                    onChange([...gates, {
                      gate: d.key,
                      params: Object.fromEntries(d.params.filter((p) => p.default !== undefined).map((p) => [p.key, p.default])),
                      enforcement: d.defaultEnforcement,
                    }]);
                    setAdding(false);
                  }}
                  className="rounded-md border border-line bg-panel px-2 py-1.5 text-left transition hover:border-navy">
                  <span className="block text-[11.5px] font-medium text-ink">{d.labelEn}</span>
                  <span className="block text-[10.5px] leading-relaxed text-faint">{d.helpEn}</span>
                </button>
              ))}
              {defs.every((d) => gates.some((g) => g.gate === d.key)) && (
                <p className="text-[11px] text-faint">Every available rule is already on this move.</p>
              )}
            </div>
            <button onClick={() => setAdding(false)} className="btn btn-sm mt-1.5">Cancel</button>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface hover:text-ink">
            <Plus className="h-3 w-3" /> Add a rule
          </button>
        )
      )}
    </div>
  );
}
