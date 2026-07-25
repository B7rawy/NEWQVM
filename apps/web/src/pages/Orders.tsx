import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../components/ui";

interface Order {
  id: string;
  order_number: string;
  status: string | null;
  items: number;
}

export default function Orders() {
  const { activeSlug } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!activeSlug) return;
    setOrders(null);
    setErr("");
    api
      .get<{ orders: Order[] }>("/orders?queue=orders")
      .then((r) => setOrders(r.orders))
      .catch((e) => {
        setErr((e as Error).message);
        setOrders([]);
      });
  }, [activeSlug]);

  return (
    <>
      <PageHeader title="Orders" subtitle="Confirmed orders in this workspace" />
      <Card pad={false}>
        {err && <div className="px-5 py-3 text-[13px] text-accent">{err}</div>}
        {orders === null ? (
          <Spinner />
        ) : orders.length === 0 ? (
          <EmptyState title="No confirmed orders yet" hint="Orders appear here once an RFQ is confirmed." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Order</th>
                <th className="th">Items</th>
                <th className="th">Status</th>
                <th className="th w-4" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="trow cursor-pointer">
                  <td className="td font-semibold text-accent tnum">{o.order_number}</td>
                  <td className="td tnum">{o.items}</td>
                  <td className="td">
                    <Badge tone={statusTone(o.status)}>{o.status ?? "—"}</Badge>
                  </td>
                  <td className="td text-right">
                    <ChevronRight className="ml-auto h-4 w-4 text-line" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
