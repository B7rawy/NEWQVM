import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

interface Order {
  id: string;
  order_number: string;
  status: string | null;
  items: number;
}

export default function Orders() {
  const { activeSlug } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!activeSlug) return;
    setOrders([]);
    setErr("");
    api
      .get<{ orders: Order[] }>("/orders")
      .then((r) => setOrders(r.orders))
      .catch((e) => setErr((e as Error).message));
  }, [activeSlug]);

  return (
    <>
      <div className="page-head"><h1>Orders</h1></div>
      <div className="card">
        {err && <div className="err">{err}</div>}
        {orders.length === 0 ? (
          <div className="empty">No confirmed orders yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Order #</th>
                <th>Items</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td><strong>{o.order_number}</strong></td>
                  <td>{o.items}</td>
                  <td><span className="badge">{o.status ?? "—"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
