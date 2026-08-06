import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

/**
 * DELIVERED ORDERS — the workshop's receiving desk: orders whose goods have arrived (or been
 * invoiced/settled since). The list is the same portal orders feed filtered to the
 * delivered-onwards statuses; the detail page carries the deliveries and the print view.
 */
interface Row {
  id: string;
  order_number: string;
  created_at: string;
  status: string | null;
  status_code: string | null;
  workspace: string;
  branch: string;
  items: number;
}

const DELIVERED_ONWARDS = new Set(["delivered", "dn_sign_pending", "pending_invoice", "invoice_issued", "claim_sent", "settled"]);

export default function WorkshopDelivered() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ orders: Row[] }>("/workshop/orders")
      .then((r) => setRows(r.orders))
      .catch((e) => { setErr((e as Error).message); setRows([]); });
  }, []);

  const visible = useMemo(() => (rows ?? []).filter((r) => DELIVERED_ONWARDS.has(r.status_code ?? "")), [rows]);

  return (
    <>
      <PageHeader title="Delivered Orders" subtitle="Orders whose goods have arrived — open one for its delivery notes and print view" />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? <Spinner /> : visible.length === 0 ? (
          <EmptyState title="Nothing delivered yet" hint="Orders land here the moment their goods arrive." />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Order</th><th className="th">Workspace</th><th className="th">Branch</th>
              <th className="th">Items</th><th className="th">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id} className="trow">
                  <td className="td tnum font-medium text-ink">{r.order_number}</td>
                  <td className="td text-muted">{r.workspace}</td>
                  <td className="td text-muted">{r.branch}</td>
                  <td className="td tnum">{r.items}</td>
                  <td className="td"><Badge tone={statusTone(r.status_code ?? "")}>{r.status ?? "—"}</Badge></td>
                  <td className="td text-right"><Link className="link" to={`/workshop/orders/${r.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
