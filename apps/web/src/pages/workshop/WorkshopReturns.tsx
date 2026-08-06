import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../../components/ui";

/**
 * RETURNS & CANCELLATIONS, workshop-side. Not a black hole: every ask the workshop filed — return
 * or cancellation — with where it stands (under review / approved / refused) and Qparts's note
 * when there is one. The data is the workflow-exceptions ledger scoped to this workshop's records.
 */

interface Row {
  id: string;
  kind: "cancellation" | "return";
  status: "open" | "executed" | "rejected";
  reason: string;
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  order_number: string;
  part: string | null;
}

const STATUS_LABEL: Record<Row["status"], { label: string; tone: "amber" | "green" | "red" }> = {
  open: { label: "Under review", tone: "amber" },
  executed: { label: "Approved", tone: "green" },
  rejected: { label: "Refused", tone: "red" },
};

export default function WorkshopReturns() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState<"all" | "return" | "cancellation">("all");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ requests: Row[] }>("/workshop/exceptions")
      .then((r) => setRows(r.requests))
      .catch((e) => { setErr((e as Error).message); setRows([]); });
  }, []);

  const visible = (rows ?? []).filter((r) => filter === "all" || r.kind === filter);

  return (
    <>
      <PageHeader title="Returns & Exchanges" subtitle="Your return and cancellation requests, and what Qparts decided" />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <div className="mb-3 flex gap-1.5">
        {(["all", "return", "cancellation"] as const).map((f) => (
          <button key={f} className={`btn btn-sm rounded-md ${filter === f ? "btn-primary" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "return" ? "Returns" : "Cancellations"}
          </button>
        ))}
      </div>
      <Card pad={false}>
        {rows === null ? <Spinner /> : visible.length === 0 ? (
          <EmptyState title="No requests yet" hint="Ask for a return from a delivered order, or a cancellation from an open request." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr>
                <th className="th">Order</th><th className="th">Part</th><th className="th">Type</th>
                <th className="th">Reason</th><th className="th">Status</th><th className="th">Decision note</th>
              </tr></thead>
              <tbody>
                {visible.map((r) => {
                  const st = STATUS_LABEL[r.status];
                  return (
                    <tr key={r.id} className="trow">
                      <td className="td tnum">{r.order_number}</td>
                      <td className="td">{r.part ?? "—"}</td>
                      <td className="td"><Badge tone={r.kind === "return" ? "blue" : "gray"}>{r.kind === "return" ? "Return" : "Cancellation"}</Badge></td>
                      <td className="td text-sub">{r.reason}</td>
                      <td className="td"><Badge tone={st.tone}>{st.label}</Badge></td>
                      <td className="td text-[12px] text-muted">{r.resolution_note ?? (r.status === "open" ? "…" : "—")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
