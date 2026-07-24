import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Quote {
  id: string; order_number: string; plate_number: string | null; workspace: string;
  status: string; status_label: string; item_count: number; quoted_count: number; sent_at: string | null;
}

export default function VendorQuotations() {
  const [rows, setRows] = useState<Quote[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ quotations: Quote[] }>("/vendor/quotations").then((r) => setRows(r.quotations)).catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, []);

  return (
    <>
      <PageHeader title="Quotation Requests" subtitle="RFQs you've been invited to quote — across every workspace you supply." />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No quotation requests" hint="When a workspace invites you to quote an RFQ, it shows up here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Workspace</th>
                  <th className="th">Vehicle</th>
                  <th className="th">Parts (quoted/total)</th>
                  <th className="th">Status</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {rows.map((q) => (
                  <tr key={q.id} className="trow">
                    <td className="td font-medium text-ink">{q.order_number}</td>
                    <td className="td text-muted">{q.workspace}</td>
                    <td className="td tnum text-muted">{q.plate_number ?? "—"}</td>
                    <td className="td tnum text-muted">{q.quoted_count}/{q.item_count}</td>
                    <td className="td"><Badge tone={statusTone(q.status)}>{q.status_label}</Badge></td>
                    <td className="td text-right">
                      <Link to={`/vendor/quotations/${q.id}`} className="btn btn-sm rounded-md">
                        {q.status === "rfq" ? "Submit quote" : "View"}
                      </Link>
                    </td>
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
