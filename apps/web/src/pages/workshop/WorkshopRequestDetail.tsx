import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Item { id: string; part_number: string | null; part_description: string | null; quantity: number }
interface Vendor { vendor: string; status: string; status_label: string; quoted_items: number }
interface Detail {
  order_number: string; plate_number: string | null; model: string | null; workspace: string; branch: string;
  status: string; status_label: string; items: Item[]; vendors: Vendor[];
}

export default function WorkshopRequestDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<Detail>(`/workshop/requests/${id}`).then(setD).catch((e) => setErr((e as Error).message));
  }, [id]);

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <Link to="/workshop/requests" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <ChevronLeft className="h-3.5 w-3.5" /> My requests
      </Link>
      <PageHeader
        title={`Request — ${d.order_number}`}
        subtitle={`${d.workspace} · ${d.branch}${d.plate_number ? ` · ${d.plate_number}` : ""}${d.model ? ` · ${d.model}` : ""}`}
        actions={<Badge tone={statusTone(d.status)}>{d.status_label}</Badge>}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card pad={false} className="lg:col-span-2">
          <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Parts</div>
          <table className="w-full">
            <thead>
              <tr><th className="th">Part number</th><th className="th">Description</th><th className="th">Qty</th></tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.id} className="trow">
                  <td className="td tnum text-muted">{i.part_number ?? "—"}</td>
                  <td className="td font-medium text-ink">{i.part_description ?? "—"}</td>
                  <td className="td tnum text-muted">{i.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card pad={false}>
          <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">
            Suppliers ({d.vendors.filter((v) => v.quoted_items > 0).length}/{d.vendors.length} responded)
          </div>
          {d.vendors.length === 0 ? (
            <EmptyState title="Not sent to suppliers yet" hint="The workspace team will invite suppliers to quote." />
          ) : (
            <div className="flex flex-col divide-y divide-line-2">
              {d.vendors.map((v, i) => (
                <div key={i} className="flex items-center justify-between px-5 py-3">
                  <span className="text-[13px] font-medium text-ink">{v.vendor}</span>
                  <Badge tone={v.quoted_items > 0 ? "green" : statusTone(v.status)}>
                    {v.quoted_items > 0 ? "Quoted" : v.status_label}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
