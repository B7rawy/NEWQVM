import { useEffect, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, StatStrip, StatCard, Badge, statusTone, Spinner, EmptyState } from "../components/ui";

interface Rfq {
  id: string;
  order_number: string;
  plate_number: string | null;
  status: string | null;
  items: number;
}
interface Order {
  id: string;
  order_number: string;
}

export default function Overview() {
  const { activeSlug } = useAuth();
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  const load = useCallback(async () => {
    const [r, o] = await Promise.all([
      api.get<{ rfqs: Rfq[] }>("/rfqs"),
      api.get<{ orders: Order[] }>("/orders").catch(() => ({ orders: [] })),
    ]);
    setRfqs(r.rfqs);
    setOrders(o.orders);
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setRfqs(null);
    load().catch(() => setRfqs([]));
  }, [activeSlug, load]);

  const open = rfqs?.filter((r) => !/deliver|closed|cancel/i.test(r.status ?? "")).length ?? 0;
  const awaiting = rfqs?.filter((r) => /sent|quoted/i.test(r.status ?? "")).length ?? 0;

  return (
    <>
      <PageHeader title="Overview" subtitle="Here's what's moving in your workspace today" />
      <StatStrip>
        <StatCard label="Open RFQs" value={open} hint={`${awaiting} awaiting quotes`} />
        <StatCard label="Confirmed orders" value={orders.length} tone="ink" />
        <StatCard label="RFQs total" value={rfqs?.length ?? "—"} />
        <StatCard label="Needs attention" value={awaiting} tone="accent" hint="quotes to review" />
      </StatStrip>

      <Card pad={false}>
        <div className="flex items-center border-b border-line-2 px-5 py-3.5">
          <b className="text-[14px] font-semibold text-ink">Recent RFQs</b>
          <span className="ml-auto cursor-pointer text-[12.5px] font-medium text-accent">View all</span>
        </div>
        {rfqs === null ? (
          <Spinner />
        ) : rfqs.length === 0 ? (
          <EmptyState title="No RFQs yet" hint="Create your first request for quote to get started." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Order</th>
                <th className="th">Plate</th>
                <th className="th">Items</th>
                <th className="th">Status</th>
                <th className="th w-4" />
              </tr>
            </thead>
            <tbody>
              {rfqs.slice(0, 6).map((r) => (
                <tr key={r.id} className="trow cursor-pointer">
                  <td className="td font-semibold text-accent tnum">{r.order_number}</td>
                  <td className="td tnum">{r.plate_number ?? <span className="text-faint">—</span>}</td>
                  <td className="td tnum">{r.items}</td>
                  <td className="td">
                    <Badge tone={statusTone(r.status)}>{r.status ?? "—"}</Badge>
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
