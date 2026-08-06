import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Order {
  id: string; order_number: string; workspace: string; branch: string; status: string; status_code: string;
  items: number; created_at: string;
}

export default function WorkshopOrders() {
  const [rows, setRows] = useState<Order[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.get<{ orders: Order[] }>("/workshop/orders").then((r) => setRows(r.orders)).catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, []);

  return (
    <>
      <PageHeader title="Orders Dashboard" subtitle="Your confirmed orders across every workspace you work with — open one for deliveries, invoices and your PO." />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No orders yet" hint="When a request is confirmed into an order, it appears here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Branch</th>
                  <th className="th">Items</th>
                  <th className="th">Status</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="trow">
                    <td className="td font-medium text-ink">{o.order_number}</td>
                    <td className="td text-muted">{o.workspace}</td>
                    <td className="td text-muted">{o.branch}</td>
                    <td className="td tnum text-muted">{o.items}</td>
                    <td className="td"><Badge tone={statusTone(o.status_code)}>{o.status}</Badge></td>
                    <td className="td text-right"><Link className="link" to={`/workshop/orders/${o.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
