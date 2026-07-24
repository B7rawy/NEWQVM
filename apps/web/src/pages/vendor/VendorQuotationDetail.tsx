import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft, CheckCircle2 } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner } from "../../components/ui";

interface Item {
  rfq_item_id: string;
  part_number: string | null;
  part_description: string | null;
  quantity: number;
  offered_cost: string | null;
  sla_hours: number | null;
  available_qty: number | null;
  alternative_part_number: string | null;
}
interface Detail {
  order_number: string; plate_number: string | null; workspace: string;
  status: string; status_label: string; items: Item[];
}
interface Row { price: string; qty: string; alt: string; sla: string }

export default function VendorQuotationDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  function load() {
    api.get<Detail>(`/vendor/quotations/${id}`).then((r) => {
      setD(r);
      const init: Record<string, Row> = {};
      r.items.forEach((i) => {
        init[i.rfq_item_id] = {
          price: i.offered_cost ?? "",
          qty: i.available_qty != null ? String(i.available_qty) : String(i.quantity),
          alt: i.alternative_part_number ?? "",
          sla: i.sla_hours != null ? String(i.sla_hours) : "",
        };
      });
      setRows(init);
    }).catch((e) => setErr((e as Error).message));
  }
  useEffect(load, [id]);

  function set(itemId: string, field: keyof Row, value: string) {
    setRows((r) => ({ ...r, [itemId]: { ...r[itemId], [field]: value } }));
  }

  async function save() {
    setErr("");
    setBusy(true);
    try {
      const items = Object.entries(rows)
        .filter(([, r]) => r.price !== "" && Number(r.price) >= 0)
        .map(([rfqItemId, r]) => ({
          rfqItemId,
          offeredCost: Number(r.price),
          availableQty: r.qty ? Number(r.qty) : undefined,
          alternativePartNumber: r.alt || undefined,
          slaHours: Number(r.sla) > 0 ? Number(r.sla) : undefined, // API requires positive int; blank/0 → unset
        }));
      if (items.length === 0) {
        setErr("Enter a unit price for at least one part.");
        return;
      }
      await api.post(`/vendor/quotations/${id}/quote`, { items });
      setSaved(true);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  const locked = d.status !== "rfq" && d.status !== "priced";

  return (
    <>
      <Link to="/vendor/quotations" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <ChevronLeft className="h-3.5 w-3.5" /> Quotation requests
      </Link>
      <PageHeader
        title={`Quote — ${d.order_number}`}
        subtitle={`${d.workspace}${d.plate_number ? ` · Vehicle ${d.plate_number}` : ""}`}
        actions={<Badge tone={statusTone(d.status)}>{d.status_label}</Badge>}
      />
      {saved && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-[13px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-4 w-4" /> Quote submitted — the buyer can now review your prices.
        </div>
      )}
      <Card pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Part</th>
                <th className="th">Req qty</th>
                <th className="th">Unit price (SAR)</th>
                <th className="th">Offer qty</th>
                <th className="th">Alt part #</th>
                <th className="th">SLA (hrs)</th>
                <th className="th">Line total</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => {
                const r = rows[i.rfq_item_id] ?? { price: "", qty: "", alt: "", sla: "" };
                const lineTotal = r.price && r.qty ? (Number(r.price) * Number(r.qty)).toFixed(2) : "—";
                return (
                  <tr key={i.rfq_item_id} className="trow align-top">
                    <td className="td">
                      <div className="font-medium text-ink">{i.part_description ?? "—"}</div>
                      <div className="tnum text-[11.5px] text-faint">{i.part_number ?? ""}</div>
                    </td>
                    <td className="td tnum text-muted">{i.quantity}</td>
                    <td className="td">
                      <input className="input h-8 w-28 py-1 tnum" type="number" min="0" step="0.01" disabled={locked} value={r.price} onChange={(e) => set(i.rfq_item_id, "price", e.target.value)} placeholder="0.00" />
                    </td>
                    <td className="td">
                      <input className="input h-8 w-20 py-1 tnum" type="number" min="0" disabled={locked} value={r.qty} onChange={(e) => set(i.rfq_item_id, "qty", e.target.value)} />
                    </td>
                    <td className="td">
                      <input className="input h-8 w-32 py-1" disabled={locked} value={r.alt} onChange={(e) => set(i.rfq_item_id, "alt", e.target.value)} placeholder="—" />
                    </td>
                    <td className="td">
                      <input className="input h-8 w-20 py-1 tnum" type="number" min="1" disabled={locked} value={r.sla} onChange={(e) => set(i.rfq_item_id, "sla", e.target.value)} placeholder="—" />
                    </td>
                    <td className="td tnum font-medium text-ink">{lineTotal}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!locked && (
          <div className="flex items-center gap-3 border-t border-line-2 px-5 py-3">
            <button className="btn-primary rounded-md" disabled={busy} onClick={save}>
              {busy ? "Submitting…" : "Submit quote"}
            </button>
            {err && <span className="text-[13px] text-accent">{err}</span>}
          </div>
        )}
      </Card>
    </>
  );
}
