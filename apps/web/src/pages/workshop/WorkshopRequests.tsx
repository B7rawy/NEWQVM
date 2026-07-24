import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FilePlus2 } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Req {
  id: string; order_number: string; plate_number: string | null; workspace: string; branch: string;
  status: string; status_label: string; item_count: number; vendor_count: number;
}

export default function WorkshopRequests() {
  const [rows, setRows] = useState<Req[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ requests: Req[] }>("/workshop/requests").then((r) => setRows(r.requests)).catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, []);

  return (
    <>
      <PageHeader
        title="My Requests"
        subtitle="Your parts requests across every workspace you work with."
        actions={
          <Link to="/workshop/requests/new" className="btn-primary rounded-md">
            <FilePlus2 className="h-4 w-4" /> New request
          </Link>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No requests yet" hint="Create a parts request to get quotes from suppliers." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Branch</th>
                  <th className="th">Vehicle</th>
                  <th className="th">Parts</th>
                  <th className="th">Vendors</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="trow">
                    <td className="td font-medium text-ink">
                      <Link to={`/workshop/requests/${r.id}`} className="hover:text-accent">{r.order_number}</Link>
                    </td>
                    <td className="td text-muted">{r.workspace}</td>
                    <td className="td text-muted">{r.branch}</td>
                    <td className="td tnum text-muted">{r.plate_number ?? "—"}</td>
                    <td className="td tnum text-muted">{r.item_count}</td>
                    <td className="td tnum text-muted">{r.vendor_count || "—"}</td>
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
