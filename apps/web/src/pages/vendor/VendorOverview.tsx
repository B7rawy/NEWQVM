import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Files } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { PageHero, Card, StatStrip, StatCard, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Overview { open: number; priced: number; won: number; total: number; responseRate: number }
interface Quote {
  id: string; order_number: string; plate_number: string | null; workspace: string;
  status: string; status_label: string; item_count: number; quoted_count: number; sent_at: string | null;
}

export default function VendorOverview() {
  const { me } = useAuth();
  const [ov, setOv] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<Quote[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    Promise.all([api.get<Overview>("/vendor/overview"), api.get<{ quotations: Quote[] }>("/vendor/quotations")])
      .then(([o, q]) => {
        setOv(o);
        setRecent(q.quotations.slice(0, 6));
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const first = me?.user?.full_name?.split(" ")[0] ?? "there";

  return (
    <>
      <PageHero
        breadcrumb={["Home", "Overview"]}
        title={`Welcome back, ${first} 👋`}
        badge={<span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">Vendor</span>}
        description="Your quotation requests across every workspace you supply — price them fast to win more orders."
        actions={
          <Link to="/vendor/quotations" className="btn-primary rounded-md">
            <Files className="h-4 w-4" /> View quotation requests
          </Link>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}

      {ov === null ? (
        <Spinner />
      ) : (
        <StatStrip>
          <StatCard label="Open RFQs" value={ov.open} hint="awaiting your quote" tone={ov.open > 0 ? "accent" : "ink"} />
          <StatCard label="Active quotes" value={ov.priced} hint="priced, in review" />
          <StatCard label="Won" value={ov.won} tone="green" />
          <StatCard label="Response rate" value={`${ov.responseRate}%`} hint={`${ov.total} total`} />
        </StatStrip>
      )}

      <Card pad={false}>
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Recent quotation requests</div>
        {recent === null ? (
          <Spinner />
        ) : recent.length === 0 ? (
          <EmptyState title="No quotation requests yet" hint="When a workspace invites you to quote, it appears here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Vehicle</th>
                  <th className="th">Parts</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((q) => (
                  <tr key={q.id} className="trow">
                    <td className="td font-medium text-ink">
                      <Link to={`/vendor/quotations/${q.id}`} className="hover:text-accent">{q.order_number}</Link>
                    </td>
                    <td className="td text-muted">{q.workspace}</td>
                    <td className="td tnum text-muted">{q.plate_number ?? "—"}</td>
                    <td className="td tnum text-muted">{q.quoted_count}/{q.item_count}</td>
                    <td className="td"><Badge tone={statusTone(q.status)}>{q.status_label}</Badge></td>
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
