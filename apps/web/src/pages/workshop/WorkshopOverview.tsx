import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FilePlus2 } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { PageHero, Card, StatStrip, StatCard, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Overview { total: number; open: number; ordered: number }
interface Req {
  id: string; order_number: string; plate_number: string | null; workspace: string; branch: string;
  status: string; status_label: string; item_count: number; vendor_count: number;
}

export default function WorkshopOverview() {
  const { me } = useAuth();
  const [ov, setOv] = useState<Overview | null>(null);
  const [recent, setRecent] = useState<Req[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    Promise.all([api.get<Overview>("/workshop/overview"), api.get<{ requests: Req[] }>("/workshop/requests")])
      .then(([o, r]) => {
        setOv(o);
        setRecent(r.requests.slice(0, 6));
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const first = me?.user?.full_name?.split(" ")[0] ?? "there";

  return (
    <>
      <PageHero
        breadcrumb={["Home", "Dashboard"]}
        title={`Welcome back, ${first} 👋`}
        badge={<span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">Workshop</span>}
        description="Request parts from any workspace you work with and track every request to delivery."
        actions={
          <Link to="/workshop/requests/new" className="btn-primary rounded-md">
            <FilePlus2 className="h-4 w-4" /> New request
          </Link>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}

      {ov === null ? (
        <Spinner />
      ) : (
        <StatStrip>
          <StatCard label="Total requests" value={ov.total} />
          <StatCard label="Open" value={ov.open} hint="in progress" tone={ov.open > 0 ? "accent" : "ink"} />
          <StatCard label="Ordered" value={ov.ordered} tone="green" />
          <StatCard label="—" value="" />
        </StatStrip>
      )}

      <Card pad={false}>
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Recent requests</div>
        {recent === null ? (
          <Spinner />
        ) : recent.length === 0 ? (
          <EmptyState title="No requests yet" hint="Create your first parts request to get quotes from suppliers." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Branch</th>
                  <th className="th">Parts</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="trow">
                    <td className="td font-medium text-ink">
                      <Link to={`/workshop/requests/${r.id}`} className="hover:text-accent">{r.order_number}</Link>
                    </td>
                    <td className="td text-muted">{r.workspace}</td>
                    <td className="td text-muted">{r.branch}</td>
                    <td className="td tnum text-muted">{r.item_count}</td>
                    <td className="td"><Badge tone={statusTone(r.status)}>{r.status_label}</Badge></td>
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
