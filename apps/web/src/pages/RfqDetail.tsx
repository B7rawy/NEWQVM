import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card, Badge, statusTone, Spinner, EmptyState } from "../components/ui";

interface Detail {
  rfq: {
    id: string;
    order_number: string;
    plate_number: string | null;
    vin: string | null;
    model: string | null;
    order_type: string;
    delivery_type: string;
    payer_type: string;
    status: string | null;
    status_code: string | null;
    workshop: string | null;
    branch: string | null;
    created_at: string;
  };
  items: Array<{ id: string; part_number: string | null; part_description: string | null; quantity: number; status: string | null }>;
  vendors: Array<{ id: string; vendor: string; sent_at: string | null; status: string | null; quoted: number }>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{value || <span className="text-faint">—</span>}</dd>
    </div>
  );
}

export default function RfqDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { activeSlug, environment } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setD(await api.get<Detail>(`/rfqs/${id}`));
  }, [id]);
  useEffect(() => {
    setD(null);
    setErr("");
    load().catch((e) => setErr((e as Error).message));
  }, [id, activeSlug, environment, load]);

  if (err) return <EmptyState title="Couldn't load RFQ" hint={err} />;
  if (!d) return <Spinner />;

  const { rfq, items, vendors } = d;

  return (
    <>
      <button onClick={() => nav("/rfqs")} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Back to RFQs
      </button>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold tracking-tight text-ink tnum">{rfq.order_number}</h1>
        <Badge tone={statusTone(rfq.status)}>{rfq.status ?? "—"}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-5">
          <Card pad={false}>
            <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Items</div>
            {items.length === 0 ? (
              <EmptyState title="No items" />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Part number</th>
                    <th className="th">Description</th>
                    <th className="th">Qty</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => (
                    <tr key={it.id} className="trow">
                      <td className="td font-medium text-ink tnum">{it.part_number ?? "—"}</td>
                      <td className="td text-muted">{it.part_description ?? "—"}</td>
                      <td className="td tnum">{it.quantity}</td>
                      <td className="td">
                        <Badge tone={statusTone(it.status)}>{it.status ?? "—"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card pad={false}>
            <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Vendors invited</div>
            {vendors.length === 0 ? (
              <EmptyState title="Not sent to vendors yet" hint="Purchasing sends this RFQ out to selected vendors to collect quotes." />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Vendor</th>
                    <th className="th">Sent</th>
                    <th className="th">Quoted items</th>
                    <th className="th">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {vendors.map((v) => (
                    <tr key={v.id} className="trow">
                      <td className="td font-medium text-ink">{v.vendor}</td>
                      <td className="td text-muted">{v.sent_at ? new Date(v.sent_at).toLocaleDateString() : "—"}</td>
                      <td className="td tnum">{v.quoted}</td>
                      <td className="td">
                        <Badge tone={statusTone(v.status)}>{v.status ?? "—"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <Card>
          <h3 className="mb-3 text-[14px] font-semibold text-ink">Details</h3>
          <dl className="divide-y divide-line-2">
            <Row label="Workshop" value={rfq.workshop} />
            <Row label="Branch" value={rfq.branch} />
            <Row label="Plate" value={rfq.plate_number} />
            <Row label="Model" value={rfq.model} />
            <Row label="Order type" value={rfq.order_type} />
            <Row label="Delivery" value={rfq.delivery_type} />
            <Row label="Payer" value={rfq.payer_type?.replace(/_/g, " ")} />
            <Row label="Created" value={new Date(rfq.created_at).toLocaleDateString()} />
          </dl>
        </Card>
      </div>
    </>
  );
}
