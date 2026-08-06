import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../../components/ui";

/** Every invoice issued against the workshop's orders, across its linked workspaces. */
interface Row {
  id: string;
  invoice_number: string | null;
  issued_at: string | null;
  total_before_vat: string | null;
  vat_amount: string | null;
  total_incl_vat: string | null;
  paid_at: string | null;
  order_id: string;
  order_number: string;
  workspace: string;
  branch: string;
}

export default function WorkshopInvoices() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ invoices: Row[] }>("/workshop/invoices")
      .then((r) => setRows(r.invoices))
      .catch((e) => { setErr((e as Error).message); setRows([]); });
  }, []);

  return (
    <>
      <PageHeader title="Invoices" subtitle="Purchase invoices issued on your orders" />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <Card pad={false}>
        {rows === null ? <Spinner /> : rows.length === 0 ? (
          <EmptyState title="No invoices yet" hint="Invoices appear here once Qparts issues them on delivered orders." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead><tr>
                <th className="th">Invoice</th><th className="th">Order</th><th className="th">Workspace</th>
                <th className="th">Issued</th><th className="th">Before VAT</th><th className="th">VAT</th>
                <th className="th">Total</th><th className="th">Paid</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="trow">
                    <td className="td tnum font-medium text-ink">{r.invoice_number ?? "—"}</td>
                    <td className="td tnum"><Link className="link" to={`/workshop/orders/${r.order_id}`}>{r.order_number}</Link></td>
                    <td className="td text-muted">{r.workspace} · {r.branch}</td>
                    <td className="td text-muted">{r.issued_at ? new Date(r.issued_at).toLocaleDateString() : "—"}</td>
                    <td className="td tnum">{r.total_before_vat ?? "—"}</td>
                    <td className="td tnum">{r.vat_amount ?? "—"}</td>
                    <td className="td tnum font-medium text-ink">{r.total_incl_vat ?? "—"}</td>
                    <td className="td">{r.paid_at ? <Badge tone="green">paid</Badge> : <Badge tone="amber">due</Badge>}</td>
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
