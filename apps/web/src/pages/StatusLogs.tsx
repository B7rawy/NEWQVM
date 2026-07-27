import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Bot, Download, History, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * STATUS LOGS — QNEW-90 item 6. What moved, and what the engine did about it.
 *
 * ONE TIMELINE, two kinds of row. A `move` is a record changing status; an `action` is something a
 * workflow rule ran afterwards. They are shown interleaved rather than in two tables because that
 * is the order they happened in, and an action only makes sense next to the move that fired it —
 * "put it on hold" is unreadable without the arrival that triggered it.
 *
 * A FAILED ACTION IS THE REASON THIS SCREEN EXISTS. runActions() may never throw: the move has
 * already happened and been judged legitimate, so a follow-up that breaks must not fail the click.
 * The cost of that rule is that failures are silent everywhere else in the product — the flow looks
 * configured and quietly is not. This page is where they stop being silent, which is why a failed
 * row is coloured, badged and counted at the top rather than left to be spotted.
 *
 * AND SOMETHING NOW TELLS YOU TO COME HERE. Once a day, a workspace's managers get one in-app
 * notification summarising the failures of the previous day, grouped by which action broke — a
 * digest, never one message per failure, because a rule wired onto an arrow every order crosses
 * would otherwise bury the rule that broke once. It links straight to this screen, which stays the
 * place the actual detail lives. Email is still not it: nothing in this system can send one. See
 * apps/api/src/modules/workflow/digest.service.ts.
 */

interface Row {
  kind: "move" | "action";
  occurred_at: string;
  entity_type: string;
  entity_id: string;
  transition_key: string | null;
  action: string | null;
  outcome: "ok" | "failed" | "skipped" | "capped" | null;
  /** Whether a person is recorded at all, as opposed to whether this reader may see who. */
  has_actor: boolean;
  detail: string | null;
  auto_advanced: boolean | null;
  override_reason: string | null;
  from_status: string | null;
  to_status: string | null;
  actor_name: string | null;
  reference: string | null;
  part: string | null;
}

const ENTITY: Record<string, string> = {
  rfq: "Request", rfq_item: "Request line", rfq_vendor: "Vendor quote",
  order: "Order", order_item: "Order line", purchase_order: "Purchase order",
  delivery: "Delivery", return: "Return", return_issue: "Return issue",
  invoice: "Invoice", credit_note: "Credit note",
};

/** The engine stores action keys; these are the names the catalog shows an admin (actions.ts). */
const ACTION: Record<string, string> = {
  set_field: "Fill in a field",
  lock_record: "Put it on hold",
  unlock_record: "Take it off hold",
  notify: "Tell somebody",
};

/**
 * Four outcomes, and `capped` is amber rather than grey on purpose. Grey says "nothing to see here",
 * which is true of `skipped` — that action never applied to that record — and false of `capped`: the
 * action applied, it would have changed the record, and the workspace's daily allowance for that kind
 * of action ran out (see actions.ts). Somebody has to decide whether the flow is misconfigured or the
 * day was genuinely that busy, so the row must not read as routine.
 */
const OUTCOME: Record<string, { label: string; badge: string }> = {
  ok: { label: "Worked", badge: "badge-green" },
  failed: { label: "Failed", badge: "badge-red" },
  skipped: { label: "Skipped", badge: "badge-gray" },
  capped: { label: "Daily limit", badge: "badge-amber" },
};

function ago(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** A field containing a comma, a quote or a newline breaks the row it sits in unless it is quoted. */
function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** What the row says happened, in one line — the same text the table and the CSV both use. */
function whatHappened(r: Row): string {
  if (r.kind === "move") return `${r.from_status ?? "nowhere"} → ${r.to_status ?? "nowhere"}`;
  return ACTION[r.action ?? ""] ?? (r.action ?? "").replace(/_/g, " ");
}

/**
 * Who did it — shared by the table and the CSV so the export cannot drift from the screen.
 *
 * FOUR CASES, and the fourth is why this function was wrong. No actor is not missing data:
 * StatusService records none when the engine advanced a record itself (auto_advanced) and none when
 * a move arrived with no session at all, which is how a vendor answering a quote link reaches the
 * system — the link is the credential, and the log says so rather than inventing a user.
 *
 * But a row can also HAVE an actor the reader may not resolve to a name. 0045 closed blanket read on
 * `users`, so before 0059 that came back null and fell through to "no signed-in user" — the screen
 * telling a workspace manager that an unauthenticated vendor had done work their own colleague did.
 * `has_actor` separates the two, and an unresolved actor says exactly that.
 */
function actorLabel(r: Row): string {
  if (r.actor_name) return r.actor_name;
  if (r.has_actor) return "someone signed in";
  return r.auto_advanced ? "the workflow" : "no signed-in user";
}

/** A move has no outcome: one that failed was rolled back and never written. It only ever "moved". */
function resultLabel(r: Row): string {
  if (r.kind === "move") return "moved";
  return OUTCOME[r.outcome ?? ""]?.label ?? r.outcome ?? "";
}

export default function StatusLogs() {
  const { activeSlug, me } = useAuth();
  const [data, setData] = useState<{ rows: Row[]; failed: number; failedWindowDays: number; limit: number } | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [limit, setLimit] = useState(200);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const q = `?limit=${limit}${onlyFailed ? "&outcome=failed" : ""}`;
      setData(await api.get<{ rows: Row[]; failed: number; failedWindowDays: number; limit: number }>(`/workflow/run-log${q}`));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [limit, onlyFailed]);
  useEffect(() => { load(); }, [load]);

  /** CSV of exactly what is on screen — same rows, same order, same wording as the table. */
  function exportCsv() {
    const head = ["Happened at", "Kind", "Reference", "Part", "Record", "What happened", "Detail", "Result", "By"];
    const body = (data?.rows ?? []).map((r) => [
      r.occurred_at,
      r.kind,
      r.reference ?? "",
      r.part ?? "",
      ENTITY[r.entity_type] ?? r.entity_type,
      whatHappened(r),
      r.detail ?? (r.override_reason ? `let through: ${r.override_reason}` : ""),
      resultLabel(r),
      actorLabel(r),
    ]);
    const csv = [head, ...body].map((line) => line.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `status-log-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  // Platform staff can be signed in with no workspace chosen, and this log is per workspace. Say
  // that plainly instead of letting the server's "no workspace resolved (subdomain / X-Tenant)"
  // through, which reads as a fault rather than as a thing the reader can fix in one click.
  if (me?.isInternal && !activeSlug)
    return (
      <div className="card p-8 text-center">
        <History className="mx-auto h-7 w-7 text-faint" />
        <p className="mt-2 text-[13.5px] font-medium text-sub">Choose a workspace first</p>
        <p className="mt-1 text-[12.5px] text-faint">
          This log belongs to one workspace — it lists that workspace's records and the rules its
          flow ran on them. Pick one from the switcher at the top to see it.
        </p>
      </div>
    );
  if (err) return <div className="card p-4 text-[13px] text-accent">{err}</div>;
  if (!data) return <div className="card p-4 text-[13px] text-muted">Loading…</div>;

  const rows = data.rows;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[19px] font-semibold text-ink">Status logs</h1>
          <p className="text-[12.5px] text-muted">
            Every move the workflow recorded, and what the engine did about it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setOnlyFailed(false)}
            className={`btn btn-sm whitespace-nowrap ${onlyFailed ? "text-muted" : "border-accent text-accent"}`}>
            Everything
          </button>
          <button
            onClick={() => setOnlyFailed(true)}
            className={`btn btn-sm whitespace-nowrap ${onlyFailed ? "border-accent text-accent" : "text-muted"}`}>
            <TriangleAlert className="h-3.5 w-3.5" /> Failures only
          </button>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="input h-[30px] w-auto py-0 text-[12px]">
            <option value={100}>newest 100</option>
            <option value={200}>newest 200</option>
            <option value={500}>newest 500</option>
            <option value={1000}>newest 1000</option>
          </select>
          {/* .btn has no :disabled rule, so say it in the token vocabulary rather than leaving a
              button that looks live and does nothing when there is nothing to export. */}
          <button onClick={exportCsv} disabled={rows.length === 0}
            className="btn btn-sm whitespace-nowrap disabled:text-faint">
            <Download className="h-3.5 w-3.5" /> Export CSV
          </button>
        </div>
      </div>

      {/* The alarm. Counted across the whole log rather than the page, so shortening the window
          cannot make a broken rule look healthy — but bounded to a week, because unbounded, one
          failure a workspace had once lit this banner for good with no way to clear it, and a
          warning that is always on is one nobody reads. */}
      {data.failed > 0 && !onlyFailed && (
        <div className="card flex items-center gap-2.5 border-[var(--chip-red-bg)] p-3">
          <TriangleAlert className="h-4 w-4 shrink-0 text-accent" />
          <p className="text-[12.5px] text-sub">
            <b className="font-medium text-ink">{data.failed}</b>{" "}
            {data.failed === 1 ? "action has" : "actions have"} failed in the last{" "}
            {data.failedWindowDays} days. The records still moved — an action that breaks never blocks
            the move — so nothing else will tell you.
          </p>
          <button onClick={() => setOnlyFailed(true)} className="btn btn-sm ml-auto shrink-0">Show them</button>
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <History className="h-4 w-4 text-muted" />
          <p className="text-[12.5px] font-semibold text-ink">
            {onlyFailed ? "Failed actions" : "Timeline"} · {rows.length}
          </p>
          <span className="ml-auto text-[11px] text-faint">newest first</span>
        </div>

        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <History className="mx-auto h-7 w-7 text-faint" />
            {onlyFailed ? (
              <>
                <p className="mt-2 text-[13.5px] font-medium text-sub">Nothing has failed</p>
                <p className="mt-1 text-[12.5px] text-faint">
                  No action the engine ran in this workspace has broken. This is the state you want —
                  switch back to Everything to read the timeline.
                </p>
              </>
            ) : (
              <>
                <p className="mt-2 text-[13.5px] font-medium text-sub">Nothing has moved yet</p>
                <p className="mt-1 text-[12.5px] text-faint">
                  A line lands here the moment any record changes status, and another for each rule
                  the flow runs afterwards. An empty log means nothing has moved in this workspace and
                  environment — not that recording is switched off.
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse">
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">Record</th>
                  <th className="th">What happened</th>
                  <th className="th">Result</th>
                  <th className="th">By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const failed = r.outcome === "failed";
                  const o = r.outcome ? OUTCOME[r.outcome] : null;
                  return (
                    <tr
                      key={`${r.kind}-${r.entity_id}-${r.occurred_at}-${i}`}
                      className={`trow ${failed ? "bg-[var(--chip-red-bg)]" : ""}`}>
                      <td className="td whitespace-nowrap">
                        <span className="text-[12.5px] text-sub" title={r.occurred_at}>{ago(r.occurred_at)}</span>
                      </td>
                      <td className="td">
                        <p className="text-[12.5px] font-medium text-ink">
                          {r.reference ?? "—"}
                          {r.part && <span className="ml-2 text-[12px] font-normal text-muted">{r.part}</span>}
                        </p>
                        <p className="text-[11px] text-faint">{ENTITY[r.entity_type] ?? r.entity_type}</p>
                      </td>
                      <td className="td">
                        {r.kind === "move" ? (
                          <p className="flex items-center gap-1.5 text-[12.5px] text-sub">
                            {r.from_status ?? "—"}
                            <ArrowRight className="h-3.5 w-3.5 text-faint" />
                            <span className="font-medium text-ink">{r.to_status ?? "—"}</span>
                          </p>
                        ) : (
                          <p className="text-[12.5px] text-sub">
                            <span className="font-medium text-ink">{whatHappened(r)}</span>
                            {r.transition_key && (
                              <span className="ml-2 text-[11px] text-faint">
                                on {r.transition_key.replace(">", " → ").replace(/_/g, " ")}
                              </span>
                            )}
                          </p>
                        )}
                        {(r.detail || r.override_reason) && (
                          <p className={`text-[11.5px] ${failed ? "text-accent" : "text-faint"}`}>
                            {r.detail ?? `let through: ${r.override_reason}`}
                          </p>
                        )}
                      </td>
                      <td className="td whitespace-nowrap">
                        {o ? (
                          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${o.badge}`}>
                            {failed && <TriangleAlert className="mr-1 inline h-3 w-3 align-[-2px]" />}
                            {o.label}
                          </span>
                        ) : (
                          <span className="text-[11px] text-faint">{resultLabel(r)}</span>
                        )}
                      </td>
                      <td className="td whitespace-nowrap">
                        {r.actor_name ? (
                          <span className="text-[12px] text-sub">{r.actor_name}</span>
                        ) : (
                          <span className="flex items-center gap-1 text-[11.5px] text-faint">
                            {r.auto_advanced && <Bot className="h-3.5 w-3.5" />}
                            {actorLabel(r)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] text-faint">
        Showing the {onlyFailed ? "failures" : "events"} recorded in this workspace and environment.
        Older entries are not deleted — raise the count above to reach further back.
      </p>
    </div>
  );
}
