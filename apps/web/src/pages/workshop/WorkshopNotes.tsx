import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../../components/ui";

/**
 * NOTES ARCHIVE — every external note across the workshop's requests and orders, newest first.
 * Composing happens on the record's own page (request/order), where the context is; this page is
 * the searchable memory. Internal Qparts notes are filtered out server-side, not here.
 */
interface Row {
  id: string;
  entity_type: "rfq" | "order";
  entity_id: string;
  body: string;
  author: string;
  created_at: string;
  order_number: string | null;
}

export default function WorkshopNotes() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ notes: Row[] }>("/workshop/notes")
      .then((r) => setRows(r.notes))
      .catch((e) => { setErr((e as Error).message); setRows([]); });
  }, []);

  const visible = (rows ?? []).filter(
    (r) => !q || r.body.toLowerCase().includes(q.toLowerCase()) || (r.order_number ?? "").toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        title="Notes Archive"
        subtitle="Every note exchanged with Qparts on your requests and orders"
        actions={<input className="input w-56" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? <Spinner /> : visible.length === 0 ? (
          <EmptyState title={q ? "No matches" : "No notes yet"} hint="Write notes from a request or order page — they land here." />
        ) : (
          <div className="divide-y divide-line-2">
            {visible.map((n) => (
              <div key={n.id} className="px-5 py-3">
                <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
                  <Badge tone={n.entity_type === "rfq" ? "blue" : "green"}>{n.entity_type === "rfq" ? "Request" : "Order"}</Badge>
                  <span className="tnum">{n.order_number ?? ""}</span>
                  <span>· {n.author}</span>
                  <span>· {new Date(n.created_at).toLocaleString()}</span>
                </div>
                <div className="text-[13px] text-ink">{n.body}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
