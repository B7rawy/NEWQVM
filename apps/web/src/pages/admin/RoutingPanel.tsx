import { useState } from "react";
import { AlertTriangle, Lock, Save } from "lucide-react";
import { api } from "../../lib/api";
import ConditionEditor, { type Condition, type ConditionFieldDef } from "./ConditionEditor";

/**
 * HOW RECORDS GET INTO THIS WORKFLOW — the routing panel (0065 / 0066).
 *
 * WHY IT EXISTS. Everything underneath it already worked: a workspace can run several flows at once,
 * a record is matched to one at birth, and an arrow can hand it to another mid-life. None of it was
 * reachable. `is_default` and `entryMode` were settable only at creation, `selectionCondition` only
 * as a field of the whole-graph save that this canvas does not send — so a second workflow made in
 * the product had no routing at all, and Activate refused it with a message listing three things the
 * product offered no way to do. The crossing control on the inspector is gated on there being
 * another ACTIVE flow, so it could never appear either.
 *
 * ONE CHOICE, THREE ANSWERS — not three checkboxes. The API models it as a discriminated union for
 * the reason this panel models it as radio buttons: `is_default` together with
 * `entry_mode = 'handoff'` is the pair that produced "sub-flow captures newborn records", and two
 * controls that can both be on is how you get there. Here they cannot.
 *
 * DRAFT ONLY, and the panel says so rather than offering a control that throws. The database freezes
 * selection_condition and selection_priority on a live flow (workflow_flow_freeze), because routing
 * decides which rulebook a record picks up when it is born; entry_mode and is_default are the same
 * decision and follow the same rule.
 */

type Mode = "fallback" | "condition" | "handoff";

export interface RoutingFlow {
  id: string;
  status: "draft" | "active" | "retired";
  is_default: boolean;
  entry_mode: string;
  selection_condition: Condition | null;
  selection_priority: number;
  /**
   * Publishing this draft will make it the fallback WHATEVER this panel says, because activate()
   * hands the flag over from the live version it retires — without that, republishing a workspace's
   * own flow left it with no fallback and every record raised afterwards moved unchecked. So the
   * choice is genuinely not open on a new version of the fallback, and the panel locks rather than
   * pretending otherwise.
   */
  inherits_default: boolean;
  /** The server's own sentence for what is stored right now. Never re-derived here. */
  selection_summary: string;
}

const ANSWERS: Array<[Mode, string, string]> = [
  [
    "fallback",
    "Anything no other workflow claims",
    "The fallback. Exactly one workflow per kind of record can be it.",
  ],
  [
    "condition",
    "Records matching a test",
    "Checked before the fallback. The first workflow whose test passes takes the record.",
  ],
  [
    "handoff",
    "Only records handed to it",
    "A sub-flow. Nothing is born here — records arrive by an arrow in another workflow.",
  ],
];

export default function RoutingPanel({
  flow, tenant, conditionFields, domainEntities, onSaved,
}: {
  flow: RoutingFlow;
  tenant: string | null;
  conditionFields: ConditionFieldDef[];
  domainEntities: string[];
  onSaved: () => void;
}) {
  const frozen = flow.status !== "draft";
  /**
   * What is stored, read as one of the three answers. `inherits_default` outranks the columns
   * because it outranks them at activation too — see the field's own note.
   *
   * `null` is a real fourth state and not a default to be papered over: a flow created by the
   * product carries no routing at all, and that is exactly why Activate refuses it. Showing no
   * answer selected, with the refusal in words above the buttons, puts the fix where the problem is.
   */
  const stored: Mode | null =
    flow.is_default || flow.inherits_default ? "fallback"
    : flow.entry_mode === "handoff" ? "handoff"
    : flow.selection_condition ? "condition"
    : null;

  const [mode, setMode] = useState<Mode | null>(stored);
  const [cond, setCond] = useState<Condition>(flow.selection_condition ?? {});
  const [priority, setPriority] = useState<number>(flow.selection_priority ?? 0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);

  const tests = (cond.all?.length ?? 0) + (cond.any?.length ?? 0);
  const unchanged =
    mode === stored &&
    (mode !== "condition" ||
      (priority === (flow.selection_priority ?? 0) &&
        JSON.stringify(cond) === JSON.stringify(flow.selection_condition ?? {})));

  async function save() {
    if (!mode) return;
    setBusy(true);
    setMsg(null);
    try {
      const body =
        mode === "condition" ? { mode, condition: cond, priority } : { mode };
      const r = await api.put<{ selectionSummary: string; fallbackHeldBy: string | null }>(
        `/admin/workflows/${flow.id}/routing`, body, { tenant },
      );
      // The refusal for two fallbacks lives at activation, which is a long way from here. The
      // server names the flow already holding the slot so this can say it while it is still cheap
      // to pick something else.
      setMsg({
        kind: "ok",
        text: r.fallbackHeldBy
          ? `Saved — but ${r.fallbackHeldBy} is already the fallback, and publishing will be refused until one of them gives it up.`
          : `Saved — this workflow takes ${r.selectionSummary}.`,
      });
      onSaved();
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-[14px] font-semibold text-ink">Which records this workflow takes</h3>
        {/* A draft cloned from the live fallback inherits the fallback on publish, and the stored
            columns say "every record" because the clone carries {} with is_default off. Printing
            that here contradicted the lock message directly underneath and the checked radio beside
            it — three answers on one panel, two of them wrong — and "every record" is the phrase
            this codebase reserves for a NON-default flow that outranks the fallback and captures
            everything, so an admin read it as "my draft will beat the live one". */}
        <p className="mt-0.5 text-[11.5px] text-faint">
          Right now:{" "}
          {flow.inherits_default && !flow.is_default
            ? "any record no other workflow claims — it takes over as the fallback when you publish it"
            : flow.selection_summary}
        </p>
      </div>

      {frozen ? (
        <p className="flex items-start gap-1.5 rounded-md border border-line bg-surface p-2 text-[11.5px] leading-relaxed text-sub">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
          This workflow is {flow.status} — routing decides which rulebook a record picks up when it
          is raised, so it is frozen while records are running on it. Use <b>New version</b> to
          change it.
        </p>
      ) : flow.inherits_default ? (
        <p className="flex items-start gap-1.5 rounded-md border border-line bg-surface p-2 text-[11.5px] leading-relaxed text-sub">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
          This is a new version of the workflow that is currently the fallback, so publishing it
          makes it the fallback again — that is what stops the workspace being left without one.
          Give another workflow the fallback first, or retire the live version, to change this.
        </p>
      ) : stored === null ? (
        <p className="flex items-start gap-1.5 rounded-md border border-line bg-surface p-2 text-[11.5px] leading-relaxed text-[var(--chip-amber-fg)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Not answered yet. This workflow cannot be published until it is — a record has to be able
          to tell whether this workflow is for it.
        </p>
      ) : null}

      <div className="flex flex-col gap-1">
        {ANSWERS.map(([k, label, hint]) => (
          <label key={k} className={`flex items-start gap-2 rounded-md border p-2 text-[12px] ${
            frozen || flow.inherits_default ? "cursor-default opacity-60" : "cursor-pointer"
          } ${mode === k ? "border-navy bg-surface" : "border-line"}`}>
            <input type="radio" className="mt-0.5" disabled={frozen || flow.inherits_default}
              checked={mode === k} onChange={() => { setMode(k); setMsg(null); }} />
            <span>
              <b className="text-ink">{label}</b>
              <span className="block text-[11px] leading-relaxed text-faint">{hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === "condition" && (
        <>
          <ConditionEditor
            value={cond}
            defs={conditionFields}
            domainEntities={domainEntities}
            disabled={frozen || flow.inherits_default}
            title="It takes a record when…"
            empty="No tests yet. A workflow with no tests takes EVERY record, which is what the fallback above is for — so add at least one."
            onChange={(c) => { setCond(c); setMsg(null); }}
          />
          <div>
            <label className="label">If another workflow also matches</label>
            <input className="input" type="number" disabled={frozen || flow.inherits_default}
              value={priority}
              onChange={(e) => { setPriority(Number(e.target.value) || 0); setMsg(null); }} />
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              Higher goes first, then the older workflow. It only ever decides a tie — leave it at 0
              unless two workflows can genuinely claim the same record.
            </p>
          </div>
        </>
      )}

      {!frozen && !flow.inherits_default && (
        <button className="btn btn-sm justify-center" onClick={save}
          disabled={busy || !mode || unchanged || (mode === "condition" && tests === 0)}
          title={
            mode === "condition" && tests === 0
              ? "Add at least one test, or pick the fallback"
              : unchanged ? "Nothing to save" : "Save the routing"
          }>
          <Save className="h-4 w-4" /> {busy ? "…" : "Save routing"}
        </button>
      )}

      {msg && (
        <p className={`text-[11.5px] leading-relaxed ${msg.kind === "err" ? "text-accent" : "text-muted"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
