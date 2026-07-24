import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Order {
  id: string; order_number: string; workspace: string; status: string; status_code: string;
  items: number; total: string; created_at: string;
}

export default function VendorConfirmedOrders() {
  const [rows, setRows] = useState<Order[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.get<{ orders: Order[] }>("/vendor/orders").then((r) => setRows(r.orders)).catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, []);

  return (
    <>
      <PageHeader title="Confirmed Orders" subtitle="Orders you won — across every workspace you supply." />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No confirmed orders yet" hint="When a buyer confirms an order on your winning quote, it appears here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Items</th>
                  <th className="th">Total (SAR)</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className="trow">
                    <td className="td font-medium text-ink">{o.order_number}</td>
                    <td className="td text-muted">{o.workspace}</td>
                    <td className="td tnum text-muted">{o.items}</td>
                    <td className="td tnum font-medium text-ink">{Number(o.total).toFixed(2)}</td>
                    <td className="td"><Badge tone={statusTone(o.status_code)}>{o.status}</Badge></td>
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
