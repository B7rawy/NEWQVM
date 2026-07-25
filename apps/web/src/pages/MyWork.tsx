import { useCallback, useEffect, useState } from "react";
import { CheckCheck, Clock, Inbox, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";

/**
 * MY WORK — what is resting on you, and what your team has not picked up yet.
 *
 * The two lists are deliberately separate rather than one sorted list. "Yours" and "available" are
 * different prompts: the first is an obligation, the second is an offer, and merging them makes the
 * obligations easy to miss. Overdue rows are called out in both.
 *
 * This screen is empty until a workspace activates a flow that assigns ownership — custody only
 * exists where the workflow says who owns what. The empty state says so rather than implying you
 * have nothing to do.
 */

interface WorkRow {
  entity_type: string;
  entity_id: string;
  assignee_role: string | null;
  step_entered_at: string;
  due_at: string | null;
  claimed: boolean;
  overdue: boolean;
  reference: string | null;
  status: string | null;
  part: string | null;
  flow: string | null;
}

const ENTITY_LABEL: Record<string, string> = {
  rfq: "Request",
  rfq_item: "Request line",
  order: "Order",
  order_item: "Order line",
};

function since(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function due(iso: string | null): { text: string; late: boolean } | null {
  if (!iso) return null;
  const h = (new Date(iso).getTime() - Date.now()) / 36e5;
  if (h < 0) return { text: `${Math.round(-h)}h late`, late: true };
  return { text: `${Math.max(1, Math.round(h))}h left`, late: false };
}

function Row({ r, onClaim }: { r: WorkRow; onClaim?: () => void }) {
  const d = due(r.due_at);
  return (
    <div className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 ${r.overdue ? "bg-[var(--chip-red-bg)]/30" : ""}`}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">
          {r.reference ?? "—"}
          {r.part && <span className="ml-2 text-[12px] font-normal text-muted">{r.part}</span>}
        </p>
        <p className="mt-0.5 text-[11.5px] text-faint">
          {ENTITY_LABEL[r.entity_type] ?? r.entity_type}
          {r.status && <> · {r.status}</>}
          {r.assignee_role && <> · {r.assignee_role.replace(/_/g, " ")}</>}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {d ? (
          <p className={`flex items-center gap-1 text-[11.5px] ${d.late ? "font-medium text-accent" : "text-muted"}`}>
            {d.late ? <TriangleAlert className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
            {d.text}
          </p>
        ) : (
          <p className="text-[11.5px] text-faint">no target</p>
        )}
        <p className="mt-0.5 text-[11px] text-faint">here {since(r.step_entered_at)}</p>
      </div>
      {onClaim && (
        <button onClick={onClaim} className="btn btn-sm shrink-0">Take it</button>
      )}
    </div>
  );
}

export default function MyWork() {
  const [data, setData] = useState<{ mine: WorkRow[]; pool: WorkRow[]; overdue: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.get<{ mine: WorkRow[]; pool: WorkRow[]; overdue: number }>("/admin/workflows/my-work"));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function claim(r: WorkRow) {
    try {
      await api.post(`/admin/workflows/records/${r.entity_type}/${r.entity_id}/claim`, {});
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (err) return <div className="card p-4 text-[13px] text-accent">{err}</div>;
  if (!data) return <div className="card p-4 text-[13px] text-muted">Loading…</div>;

  const nothing = data.mine.length === 0 && data.pool.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[19px] font-semibold text-ink">My work</h1>
          <p className="text-[12.5px] text-muted">Everything the workflow has put in your hands.</p>
        </div>
        {data.overdue > 0 && (
          <span className="rounded-md bg-[var(--chip-red-bg)] px-2 py-1 text-[12px] font-medium text-[var(--chip-red-fg)]">
            {data.overdue} past its target
          </span>
        )}
      </div>

      {nothing ? (
        <div className="card p-8 text-center">
          <CheckCheck className="mx-auto h-7 w-7 text-faint" />
          <p className="mt-2 text-[13.5px] font-medium text-sub">Nothing is waiting on you</p>
          <p className="mt-1 text-[12.5px] text-faint">
            This fills up once a workflow is active and its steps say who handles them.
          </p>
        </div>
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold text-ink">
              Yours · {data.mine.length}
            </div>
            {data.mine.length === 0
              ? <p className="px-4 py-6 text-center text-[12.5px] text-faint">Nothing assigned to you right now.</p>
              : data.mine.map((r) => <Row key={r.entity_id} r={r} />)}
          </div>

          {data.pool.length > 0 && (
            <div className="card overflow-hidden">
              <div className="flex items-center gap-1.5 border-b border-line px-4 py-2.5 text-[12.5px] font-semibold text-ink">
                <Inbox className="h-4 w-4 text-muted" /> Unclaimed · your team can take these
              </div>
              {data.pool.map((r) => <Row key={r.entity_id} r={r} onClaim={() => claim(r)} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
