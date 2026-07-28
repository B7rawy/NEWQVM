import { Filter, Plus, Trash2 } from "lucide-react";

/**
 * Choosing WHICH RECORDS a rule applies to — the condition picker (QNEW-89 §4.1).
 *
 * A PICKER OVER A CODE-DEFINED CATALOG, NEVER A FORMULA BOX, for exactly the reason GateEditor is
 * one: the fields come from CONDITION_FIELDS in conditions.ts, so an admin choosing "Who pays" from
 * a list cannot name a column that does not exist, one that would leak, or one the evaluator would
 * fail closed on. A free-text rule box would put all three back.
 *
 * ONE COMPONENT, TWO PLACES, because it is one question asked twice:
 *   • which records a FLOW takes  (workflow_flows.selection_condition — the routing panel)
 *   • when a MOVE may be taken    (workflow_transitions.condition — the canvas inspector)
 * Both are served by the same catalog and evaluated by the same code, so a second editor would be a
 * second set of operators and a second idea of what an empty rule means.
 *
 * THE OPERATOR WORDS ARE THE SERVER'S WORDS. "is", "is not", "is more than", "is one of" are exactly
 * what describe() in conditions.ts renders a stored clause as, so the sentence an admin reads back
 * on the Workflows screen is the sentence they built here. Two vocabularies for one rule is how a
 * screen ends up describing something the engine does not do.
 */

export type Op = "eq" | "ne" | "gt" | "lt" | "in";
export interface Clause { field: string; op: Op; value: unknown }
/** `{}` = no tests. `{all:[…]}` = every clause. `{any:[…]}` = at least one. No nesting, on purpose. */
export interface Condition { all?: Clause[]; any?: Clause[] }
export interface ConditionFieldDef {
  key: string;
  labelEn: string;
  labelAr: string;
  type: "enum" | "number" | "text";
  options?: string[];
  /** Which record kinds carry the fact. A condition on a vendor invitation's payer makes no sense. */
  entities: string[];
}

/** Which comparisons make sense for a fact of this kind, in the server's own words. */
const OPS: Record<ConditionFieldDef["type"], Array<[Op, string]>> = {
  enum: [["eq", "is"], ["ne", "is not"], ["in", "is one of"]],
  number: [["eq", "is"], ["ne", "is not"], ["gt", "is more than"], ["lt", "is less than"]],
  text: [["eq", "is"], ["ne", "is not"]],
};

/** A fresh clause for a field: the safest comparison, and a value that is actually one of the
 *  allowed ones rather than a blank that would silently match a record with nothing set. */
function freshClause(d: ConditionFieldDef): Clause {
  return {
    field: d.key,
    op: "eq",
    value: d.type === "enum" ? (d.options?.[0] ?? "") : d.type === "number" ? 0 : "",
  };
}

export default function ConditionEditor({
  value, defs, domainEntities, disabled, title, empty, onChange,
}: {
  value: Condition;
  defs: ConditionFieldDef[];
  /** The record types this flow's domain governs — mirrors DOMAIN_ENTITIES in WorkflowCanvas. */
  domainEntities: string[];
  disabled?: boolean;
  title: string;
  /** What "no tests" means HERE. The two callers mean genuinely different things by it. */
  empty: string;
  onChange: (next: Condition) => void;
}) {
  /**
   * A field whose entities miss this domain entirely can never be read. gatherFacts() resolves an
   * rfq_item, an order and an order_item back to the REQUEST that owns them, which is why every
   * item-domain flow can test all of them — and why a vendor-domain flow can test none: nothing
   * resolves an rfq_vendor to a set of facts, so any clause on one fails closed for ever. Offering
   * the picker there would be a control that quietly guarantees the rule never matches.
   */
  const applicable = defs.filter((d) => d.entities.some((e) => domainEntities.includes(e)));
  const defOf = (k: string) => defs.find((d) => d.key === k);

  const all = value.all ?? [];
  const any = value.any ?? [];
  /**
   * The builder writes ONE group. `{all:[…]}` and `{any:[…]}` together is a legal stored shape — the
   * API accepts it — and it means "every one of these AND at least one of those", which no two
   * controls on this panel can honestly represent. Rather than silently drop half of it on the next
   * edit, it is shown as read-only with the way out named.
   */
  const twoGroups = all.length > 0 && any.length > 0;
  const join: "all" | "any" = any.length && !all.length ? "any" : "all";
  const clauses = join === "any" ? any : all;
  const put = (next: Clause[]) => onChange(next.length ? { [join]: next } : {});

  return (
    <div className="rounded-md border border-line bg-panel p-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] font-semibold text-ink">
        <Filter className="h-3.5 w-3.5 text-muted" />
        {title}
      </p>

      {applicable.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          Nothing about this kind of record can be tested, so this always applies.
        </p>
      ) : twoGroups ? (
        <>
          <p className="mt-1 text-[11px] leading-relaxed text-[var(--chip-amber-fg)]">
            This rule combines two groups — every one of {all.length} test
            {all.length === 1 ? "" : "s"} and at least one of {any.length}. It was not built here and
            cannot be shown as one list without changing what it means.
          </p>
          {!disabled && (
            <button onClick={() => onChange({})}
              className="btn btn-sm mt-1.5">
              Clear it and start again
            </button>
          )}
        </>
      ) : (
        <>
          {clauses.length === 0 && (
            <p className="mt-1 text-[11px] leading-relaxed text-faint">{empty}</p>
          )}

          {/* The join, offered only once there are two tests to join. With one test "all of these"
              and "at least one of these" are the same sentence, and a control whose two answers do
              not differ is a control that teaches the wrong thing. */}
          {clauses.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {([
                ["all", "Every one of these", "The record must satisfy all of the tests below."],
                ["any", "At least one of these", "The record only has to satisfy one of them."],
              ] as const).map(([k, label, hint]) => (
                <button key={k} disabled={disabled} title={hint}
                  onClick={() => onChange({ [k]: clauses })}
                  className={`rounded-md border px-1.5 py-1 text-[10.5px] leading-none transition disabled:opacity-50 ${
                    join === k
                      ? "border-navy bg-navy text-white"
                      : "border-line bg-panel text-muted hover:border-line-2"}`}>
                  {label}
                </button>
              ))}
            </div>
          )}

          {clauses.map((c, i) => {
            const d = defOf(c.field);
            const ops = OPS[d?.type ?? "text"];
            const set = (p: Partial<Clause>) =>
              put(clauses.map((x, n) => (n === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="mt-2 rounded-md border border-line bg-surface p-2">
                <div className="flex items-start justify-between gap-2">
                  <select disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                    value={c.field}
                    onChange={(e) => {
                      // Changing the fact RESETS the comparison and the value. Carrying them over
                      // produces "is more than" on a dropdown, or a payer_type clause still holding
                      // 'pickup' — both of which save, and neither of which ever matches.
                      const nd = defOf(e.target.value);
                      set(nd ? freshClause(nd) : { field: e.target.value });
                    }}>
                    {/* A field the server no longer publishes must stay selectable, or opening an
                        old rule would silently rewrite it to whatever happened to be first. */}
                    {!d && <option value={c.field}>{c.field} — this server does not know it</option>}
                    {applicable.map((x) => (
                      <option key={x.key} value={x.key}>{x.labelEn}</option>
                    ))}
                  </select>
                  {!disabled && (
                    <button onClick={() => put(clauses.filter((_, n) => n !== i))}
                      className="mt-1 shrink-0 rounded p-0.5 text-faint hover:text-accent"
                      title="Remove this test">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                <div className="mt-1.5 flex items-center gap-2">
                  <select disabled={disabled} className="input h-7 w-28 shrink-0 text-[11.5px]"
                    value={c.op}
                    onChange={(e) => {
                      const op = e.target.value as Op;
                      // "is one of" holds a LIST and every other operator holds a single value, so
                      // the value has to change shape with the operator rather than after it.
                      const cur = Array.isArray(c.value) ? c.value[0] : c.value;
                      set({ op, value: op === "in" ? (cur === undefined ? [] : [cur]) : (cur ?? "") });
                    }}>
                    {ops.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </select>

                  {d?.type === "enum" && c.op === "in" ? (
                    <div className="flex flex-wrap gap-1">
                      {(d.options ?? []).map((o) => {
                        const list = Array.isArray(c.value) ? (c.value as unknown[]).map(String) : [];
                        const on = list.includes(o);
                        return (
                          <button key={o} type="button" disabled={disabled}
                            onClick={() => set({ value: on ? list.filter((v) => v !== o) : [...list, o] })}
                            className={`rounded-md border px-1.5 py-1 text-[10.5px] leading-none transition disabled:opacity-50 ${
                              on ? "border-navy bg-navy text-white" : "border-line bg-panel text-muted hover:border-line-2"
                            }`}>
                            {o.replace(/_/g, " ")}
                          </button>
                        );
                      })}
                    </div>
                  ) : d?.type === "enum" ? (
                    <select disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                      value={String(c.value ?? "")}
                      onChange={(e) => set({ value: e.target.value })}>
                      {(d.options ?? []).map((o) => (
                        <option key={o} value={o}>{o.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  ) : d?.type === "number" ? (
                    <input type="number" disabled={disabled} className="input h-7 w-28 text-[11.5px]"
                      value={String(c.value ?? "")}
                      onChange={(e) => set({ value: e.target.value ? Number(e.target.value) : 0 })} />
                  ) : (
                    <input disabled={disabled} className="input h-7 flex-1 text-[11.5px]"
                      value={String(c.value ?? "")}
                      onChange={(e) => set({ value: e.target.value })} />
                  )}
                </div>
              </div>
            );
          })}

          {!disabled && (
            <button
              onClick={() => put([...clauses, freshClause(applicable[0])])}
              className="mt-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted hover:bg-surface hover:text-ink">
              <Plus className="h-3 w-3" /> Add a test
            </button>
          )}
        </>
      )}
    </div>
  );
}
