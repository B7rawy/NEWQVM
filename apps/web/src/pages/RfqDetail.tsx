import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Send, Check } from "lucide-react";
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

interface VendorOpt {
  id: string;
  legal_name: string;
}
interface QuoteRow {
  item_id: string;
  part_number: string | null;
  part_description: string | null;
  winning_vendor_quote_item_id: string | null;
  quote_id: string | null;
  offered_cost: string | null;
  sla_hours: number | null;
  vendor: string | null;
}

export default function RfqDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { activeSlug, environment, me } = useAuth();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [vendorList, setVendorList] = useState<VendorOpt[]>([]);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [quotes, setQuotes] = useState<QuoteRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const isPlatform = me?.persona === "platform";

  const load = useCallback(async () => {
    const detail = await api.get<Detail>(`/rfqs/${id}`);
    setD(detail);
    if (me?.persona === "platform" && detail.vendors.length > 0) {
      const q = await api.get<{ rows: QuoteRow[] }>(`/rfqs/${id}/quotes`).catch(() => ({ rows: [] }));
      setQuotes(q.rows);
    } else {
      setQuotes(null);
    }
  }, [id, me?.persona]);
  useEffect(() => {
    setD(null);
    setErr("");
    setPicking(false);
    setSelected(new Set());
    load().catch((e) => setErr((e as Error).message));
  }, [id, activeSlug, environment, load]);

  async function pickWinner(itemId: string, quoteId: string) {
    setBusy(true);
    try {
      await api.post(`/rfqs/${id}/items/${itemId}/winning-quote`, { quoteItemId: quoteId });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    try {
      await api.post(`/rfqs/${id}/confirm`, {});
      nav("/orders");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function openPicker() {
    setPicking(true);
    if (!vendorList.length) {
      const r = await api.get<{ vendors: VendorOpt[] }>("/vendors").catch(() => ({ vendors: [] }));
      setVendorList(r.vendors);
    }
  }
  async function send() {
    setSending(true);
    setErr("");
    try {
      await api.post(`/rfqs/${id}/send`, { vendorIds: [...selected] });
      setPicking(false);
      setSelected(new Set());
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  if (err) return <EmptyState title="Couldn't load RFQ" hint={err} />;
  if (!d) return <Spinner />;

  const { rfq, items, vendors } = d;

  // group quote rows by item
  const quoteGroups = new Map<string, { part: string | null; winner: string | null; rows: QuoteRow[] }>();
  for (const r of quotes ?? []) {
    if (!quoteGroups.has(r.item_id))
      quoteGroups.set(r.item_id, { part: r.part_number, winner: r.winning_vendor_quote_item_id, rows: [] });
    if (r.quote_id) quoteGroups.get(r.item_id)!.rows.push(r);
  }
  const anyWinner = [...quoteGroups.values()].some((g) => g.winner);
  const isConfirmed = /confirm/i.test(rfq.status_code ?? rfq.status ?? "");

  return (
    <>
      <button onClick={() => nav("/rfqs")} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Back to RFQs
      </button>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-[20px] font-semibold tracking-tight text-ink tnum">{rfq.order_number}</h1>
        <Badge tone={statusTone(rfq.status)}>{rfq.status ?? "—"}</Badge>
        {anyWinner && !isConfirmed && (
          <button className="btn-primary ml-auto rounded-md" disabled={busy} onClick={confirm}>
            <Check className="h-4 w-4" /> Confirm order
          </button>
        )}
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
            <div className="flex items-center border-b border-line-2 px-5 py-3">
              <span className="text-[14px] font-semibold text-ink">Vendors invited</span>
              {me?.persona === "platform" && !picking && (
                <button className="btn-primary btn-sm ml-auto rounded-md" onClick={openPicker}>
                  <Send className="h-3.5 w-3.5" /> Send to vendors
                </button>
              )}
            </div>
            {picking && (
              <div className="border-b border-line-2 bg-surface px-5 py-4">
                <div className="mb-2 text-[13px] font-medium text-ink">Select vendors to invite</div>
                {vendorList.length === 0 ? (
                  <div className="text-[13px] text-muted">No vendors linked to this workspace. Add vendors first.</div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {vendorList.map((v) => (
                      <label key={v.id} className="flex items-center gap-2 text-[13px] text-ink">
                        <input
                          type="checkbox"
                          checked={selected.has(v.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            e.target.checked ? next.add(v.id) : next.delete(v.id);
                            setSelected(next);
                          }}
                        />
                        {v.legal_name}
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <button className="btn-primary btn-sm rounded-md" disabled={sending || selected.size === 0} onClick={send}>
                    {sending ? "Sending…" : `Send to ${selected.size || ""}`}
                  </button>
                  <button className="btn btn-sm rounded-md" onClick={() => setPicking(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {vendors.length === 0 ? (
              !picking && <EmptyState title="Not sent to vendors yet" hint="Purchasing sends this RFQ out to selected vendors to collect quotes." />
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

          {isPlatform && quotes && quotes.length > 0 && (
            <Card pad={false}>
              <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Quotes — pick a winner per item</div>
              <div className="flex flex-col divide-y divide-line-2">
                {[...quoteGroups.entries()].map(([itemId, g]) => (
                  <div key={itemId} className="px-5 py-3">
                    <div className="mb-2 text-[13px] font-medium text-ink tnum">{g.part ?? "—"}</div>
                    {g.rows.length === 0 ? (
                      <div className="text-[12px] text-muted">No quotes yet</div>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {g.rows.map((q) => {
                          const won = g.winner === q.quote_id;
                          return (
                            <div
                              key={q.quote_id}
                              className={`flex items-center gap-3 rounded-md border px-3 py-2 text-[13px] ${won ? "border-emerald-300 bg-emerald-50" : "border-line"}`}
                            >
                              <span className="font-medium text-ink">{q.vendor}</span>
                              <span className="tnum text-ink">SAR {q.offered_cost}</span>
                              {q.sla_hours != null && <span className="text-muted">· {q.sla_hours}h</span>}
                              {won ? (
                                <span className="ml-auto"><Badge tone="green">Winner</Badge></span>
                              ) : (
                                <button className="btn btn-sm ml-auto rounded-md" disabled={busy} onClick={() => pickWinner(itemId, q.quote_id!)}>
                                  Pick
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
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
