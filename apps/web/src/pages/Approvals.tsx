import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Ban, Check, CheckCheck, Clock, PauseCircle, PlayCircle, RotateCcw, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { api } from "../lib/api";

/**
 * APPROVALS — the screen without which the approval engine must not exist.
 *
 * A chain creates records that are waiting BY DESIGN. This repo has no scheduler, no queue worker
 * and no notification dispatcher, so nothing tells an approver that a decision is sitting on them.
 * This page is that telling. Shipping the engine without it would mean orders quietly stopping with
 * nobody able to see why.
 *
 * Three lists, and the middle one is the safety net: "Approved — did not go through" should always
 * be empty, because granting the last level performs the move. A row appearing there means an
 * approval was given and something stopped the move afterwards, and an approval that silently
 * changed nothing is the worst failure this feature can have.
 */

interface Row {
  id: string;
  entity_type: string;
  entity_id: string;
  transition_key: string | null;
  overall_status: string;
  current_level: number;
  levels: number;
  created_at: string;
  consumed_at: string | null;
  requested_by_name: string | null;
  current_approver_name: string | null;
  policy: string;
  reference: string | null;
  part: string | null;
}

/** A cancellation or return waiting on a decision. Same question as an approval — different shape. */
interface Exc {
  id: string; entity_type: string; entity_id: string;
  kind: "cancellation" | "return" | "hold";
  status: string; reason: string;
  requested_by_name: string | null;
  resolved_by_name: string | null; resolved_at: string | null; resolution_note: string | null;
  created_at: string; frozen_at: string | null;
  reference: string | null; part: string | null;
}

const ENTITY: Record<string, string> = {
  rfq: "Request", rfq_item: "Request line", order: "Order", order_item: "Order line",
};

/** "new_rfq>priced" is storage, not language. */
function moveLabel(key: string | null): string {
  if (!key) return "a change";
  const [from, to] = key.split(">");
  const pretty = (c: string) => c.replace(/_/g, " ");
  return `${pretty(from)} → ${pretty(to)}`;
}

function ago(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function RowCard({
  r, actionable, onAct, busy,
}: {
  r: Row; actionable: boolean; busy: boolean;
  onAct?: (id: string, action: "approve" | "reject", comment: string) => void;
}) {
  const [comment, setComment] = useState("");
  const [rejecting, setRejecting] = useState(false);

  return (
    <div className="border-b border-line px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">
            {r.reference ?? ENTITY[r.entity_type] ?? r.entity_type}
            {r.part && <span className="ml-2 text-[12px] font-normal text-muted">{r.part}</span>}
          </p>
          <p className="mt-0.5 text-[12px] text-sub">{moveLabel(r.transition_key)}</p>
          <p className="mt-0.5 text-[11px] text-faint">
            {ENTITY[r.entity_type] ?? r.entity_type} · asked by {r.requested_by_name ?? "someone"} · {ago(r.created_at)}
            {r.levels > 1 && <> · step {r.current_level} of {r.levels}</>}
            {" · "}{r.policy}
          </p>
        </div>
        {!actionable && r.current_approver_name && (
          <span className="shrink-0 text-[11.5px] text-muted">with {r.current_approver_name}</span>
        )}
      </div>

      {actionable && (
        <div className="mt-2.5">
          {rejecting ? (
            <div className="rounded-md border border-line bg-surface p-2.5">
              <p className="mb-1.5 text-[11.5px] text-muted">
                Why are you turning this down? The person who asked will see it.
              </p>
              <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                className="w-full resize-none rounded-md border border-line bg-panel px-2 py-1.5 text-[12.5px] text-ink outline-none"
                placeholder="e.g. margin too low on line 3" />
              <div className="mt-1.5 flex gap-2">
                <button disabled={busy} onClick={() => onAct?.(r.id, "reject", comment)}
                  className="btn btn-sm text-accent">
                  <ThumbsDown className="h-3.5 w-3.5" /> Turn it down
                </button>
                <button onClick={() => setRejecting(false)} className="btn btn-sm">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button disabled={busy} onClick={() => onAct?.(r.id, "approve", comment)}
                className="btn-primary rounded-md px-3 py-1.5 text-[12.5px]">
                <ThumbsUp className="h-3.5 w-3.5" /> Approve
              </button>
              <button disabled={busy} onClick={() => setRejecting(true)} className="btn btn-sm">
                <X className="h-3.5 w-3.5" /> Turn it down
              </button>
              <span className="text-[11px] text-faint">Approving carries the order forward straight away.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const [data, setData] = useState<{ waitingOnMe: Row[]; readyToContinue: Row[]; mine: Row[] } | null>(null);
  const [excs, setExcs] = useState<{ open: Exc[]; held: Exc[]; all: Exc[] } | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, e] = await Promise.all([
        api.get<{ waitingOnMe: Row[]; readyToContinue: Row[]; mine: Row[] }>("/approvals"),
        api.get<{ open: Exc[]; held: Exc[]; all: Exc[] }>("/workflow/exceptions"),
      ]);
      setData(a);
      setExcs(e);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  /**
   * Decide a cancellation or return. Approving executes it; refusing puts the record back exactly
   * where it was frozen — which is the whole reason an exception is not a status in the main chain.
   */
  async function decide(id: string, decision: "approve" | "reject") {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<{ decision: string; movedTo?: string; restoredTo?: string }>(
        `/workflow/exceptions/${id}/resolve`, { decision, note: note[id] || undefined },
      );
      setMsg(
        r.decision === "approved"
          ? `Done — the record is now ${r.movedTo}.`
          : `Turned down — the record went back to ${r.restoredTo ?? "where it was"}.`,
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }
  /**
   * Take a record off hold. Not `decide` with a third option: a hold is not a request, so there is
   * nothing to approve or refuse, and giving it the same two buttons is what made an engine hold
   * look like a cancellation somebody had asked for.
   */
  async function release(id: string) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.post(`/workflow/exceptions/${id}/release`, { note: note[id] || undefined });
      setMsg("Off hold — it can move again.");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [load]);

  async function act(id: string, action: "approve" | "reject", comment: string) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post<{ status: string; moved?: boolean }>(
        `/approvals/requests/${id}/act`, { action, comment: comment || undefined },
      );
      setMsg(
        r.status === "approved"
          ? r.moved ? "Approved — the order moved forward." : "Approved."
          : r.status === "rejected" ? "Turned down." : "Approved — it now goes to the next approver.",
      );
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  if (err && !data) return <div className="card p-4 text-[13px] text-accent">{err}</div>;
  if (!data) return <div className="card p-4 text-[13px] text-muted">Loading…</div>;

  const openExcs = excs?.open ?? [];
  const heldExcs = excs?.held ?? [];
  const nothing =
    !data.waitingOnMe.length && !data.readyToContinue.length && !data.mine.length && !openExcs.length
    && !heldExcs.length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[19px] font-semibold text-ink">Approvals</h1>
        <p className="text-[12.5px] text-muted">Decisions waiting on you, and what you have asked others to sign.</p>
      </div>

      {err && <div className="card border-accent p-3 text-[12.5px] text-accent">{err}</div>}
      {msg && <div className="card p-3 text-[12.5px] text-[var(--chip-green-fg)]">{msg}</div>}

      {/* ON HOLD — deliberately not in the block below. The workflow parked these itself; nobody is
          asking for a decision, so there is nothing to approve and no "Cancel it" button. Before
          0057 a hold was filed as a cancellation and rendered right there with the rest. */}
      {heldExcs.length > 0 && (
        <div className="card overflow-hidden border-[var(--chip-amber-bg)]">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <PauseCircle className="h-4 w-4 text-[var(--chip-amber-fg)]" />
            <p className="text-[12.5px] font-semibold text-ink">On hold by the workflow · {heldExcs.length}</p>
          </div>
          <p className="border-b border-line px-4 py-2 text-[11.5px] leading-relaxed text-muted">
            A rule stopped these on their way through. They keep their status and will not move until
            somebody releases them. Nobody is being asked to approve anything here.
          </p>
          {heldExcs.map((e) => (
            <div key={e.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-start gap-2.5">
                <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--chip-amber-fg)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">
                    {e.reference ?? ENTITY[e.entity_type] ?? e.entity_type}
                    {e.part && <span className="ml-2 text-[12px] font-normal text-muted">{e.part}</span>}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-sub">“{e.reason}”</p>
                  <p className="mt-0.5 text-[11px] text-faint">
                    held {ago(e.created_at)}
                    {e.frozen_at && <> · sitting at <b className="font-medium">{e.frozen_at}</b></>}
                  </p>

                  <textarea rows={1} value={note[e.id] ?? ""} placeholder="Why you are releasing it (optional)"
                    onChange={(ev) => setNote((n) => ({ ...n, [e.id]: ev.target.value }))}
                    className="mt-2 w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none" />

                  <div className="mt-1.5 flex items-center gap-2">
                    <button disabled={busy} onClick={() => release(e.id)} className="btn btn-sm">
                      <PlayCircle className="h-3.5 w-3.5" /> Release it
                    </button>
                    <span className="text-[11px] text-faint">It carries on from where it stopped.</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cancellations and returns are the same question as an approval — a decision someone is
          waiting on — so they belong in the same inbox rather than a second place to check. */}
      {openExcs.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Ban className="h-4 w-4 text-muted" />
            <p className="text-[12.5px] font-semibold text-ink">
              Cancellations &amp; returns waiting · {openExcs.length}
            </p>
          </div>
          <p className="border-b border-line px-4 py-2 text-[11.5px] leading-relaxed text-muted">
            While one of these is open the record is frozen — it keeps its real status and cannot
            move until you decide. Turning it down puts it straight back.
          </p>
          {openExcs.map((e) => (
            <div key={e.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-start gap-2.5">
                {e.kind === "cancellation"
                  ? <Ban className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  : <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-[var(--chip-amber-fg)]" />}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">
                    {e.kind === "cancellation" ? "Cancel" : "Return"} {e.reference ?? ENTITY[e.entity_type] ?? e.entity_type}
                    {e.part && <span className="ml-2 text-[12px] font-normal text-muted">{e.part}</span>}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-sub">“{e.reason}”</p>
                  <p className="mt-0.5 text-[11px] text-faint">
                    asked by {e.requested_by_name ?? "someone"} · {ago(e.created_at)}
                    {e.frozen_at && <> · frozen at <b className="font-medium">{e.frozen_at}</b></>}
                  </p>

                  <textarea rows={1} value={note[e.id] ?? ""} placeholder="A note on your decision (optional)"
                    onChange={(ev) => setNote((n) => ({ ...n, [e.id]: ev.target.value }))}
                    className="mt-2 w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-[12px] text-ink outline-none" />

                  <div className="mt-1.5 flex items-center gap-2">
                    <button disabled={busy} onClick={() => decide(e.id, "approve")}
                      className="btn btn-sm text-accent">
                      <Check className="h-3.5 w-3.5" />
                      {e.kind === "cancellation" ? "Cancel it" : "Accept the return"}
                    </button>
                    <button disabled={busy} onClick={() => decide(e.id, "reject")} className="btn btn-sm">
                      <X className="h-3.5 w-3.5" /> Keep it going
                    </button>
                    <span className="text-[11px] text-faint">
                      Keeping it going unfreezes the record where it stands.
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {nothing ? (
        <div className="card p-8 text-center">
          <CheckCheck className="mx-auto h-7 w-7 text-faint" />
          <p className="mt-2 text-[13.5px] font-medium text-sub">Nothing needs a signature</p>
          <p className="mt-1 text-[12.5px] text-faint">
            This fills up when a step needs sign-off, when somebody asks to cancel or return something, \n            or when a rule puts an order on hold.
          </p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <Clock className="h-4 w-4 text-muted" />
              <p className="text-[12.5px] font-semibold text-ink">Waiting on you · {data.waitingOnMe.length}</p>
            </div>
            {data.waitingOnMe.length === 0
              ? <p className="px-4 py-5 text-center text-[12.5px] text-faint">Nothing is waiting on your decision.</p>
              : data.waitingOnMe.map((r) => (
                  <RowCard key={r.id} r={r} actionable busy={busy} onAct={act} />
                ))}
          </div>

          {/* The safety net. Empty is the healthy state. */}
          {data.readyToContinue.length > 0 && (
            <div className="card overflow-hidden border-[var(--chip-amber-bg)]">
              <div className="flex items-center gap-2 border-b border-line bg-[var(--chip-amber-bg)]/20 px-4 py-2.5">
                <AlertTriangle className="h-4 w-4 text-[var(--chip-amber-fg)]" />
                <p className="text-[12.5px] font-semibold text-ink">
                  Approved, but did not go through · {data.readyToContinue.length}
                </p>
              </div>
              <p className="border-b border-line px-4 py-2 text-[11.5px] leading-relaxed text-muted">
                These were signed off and the order did not move. Something blocked it afterwards —
                open the record and try the action again to see what.
              </p>
              {data.readyToContinue.map((r) => <RowCard key={r.id} r={r} actionable={false} busy={busy} />)}
            </div>
          )}

          {data.mine.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <Check className="h-4 w-4 text-muted" />
                <p className="text-[12.5px] font-semibold text-ink">You asked for · {data.mine.length}</p>
              </div>
              {data.mine.map((r) => <RowCard key={r.id} r={r} actionable={false} busy={busy} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
