import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Undo2, XCircle, Printer, Pencil, Check } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../../components/ui";

/**
 * ONE ORDER, workshop-side — the post-confirmation chain the workshop watches
 * (docs/legacy/workshop-logic.md §5): lines with delivery progress, the workshop's own PO number
 * (client_po — plain data, editable inline), deliveries, invoices and credit notes, and the two
 * governed asks: RETURN on a delivered line (with quantity), CANCELLATION on an undelivered one.
 * Both file exceptions and say so — the line's status is Qparts's to move, not this page's.
 */

interface Line {
  id: string;
  final_part_number: string | null;
  part_description: string | null;
  approved_qty: number;
  delivered_qty: number;
  status: string | null;
  status_label: string | null;
  selling_price: string | null;
  has_open_request: boolean;
}
interface Detail {
  id: string;
  order_number: string;
  client_po: string | null;
  status: string | null;
  status_label: string | null;
  workspace: string;
  branch: string;
  created_at: string;
  lines: Line[];
  deliveries: Array<{ id: string; delivered_at: string | null; created_at: string; qty: number }>;
  invoices: Array<{ id: string; invoice_number: string | null; issued_at: string | null; total_incl_vat: string | null }>;
  creditNotes: Array<{ id: string; credit_note_number: string | null; issued_at: string | null; total: string | null }>;
}
interface Lists {
  cancellationReasons: Array<{ id: string; label_en: string }>;
  returnReasons: Array<{ id: string; label_en: string }>;
}

export default function WorkshopOrderDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingPo, setEditingPo] = useState(false);
  const [po, setPo] = useState("");
  const [returnFor, setReturnFor] = useState<Line | null>(null);
  const [returnQty, setReturnQty] = useState(1);
  const [returnReason, setReturnReason] = useState("");

  const load = useCallback(async () => {
    const r = await api.get<Detail>(`/workshop/orders/${id}`);
    setD(r);
    setPo(r.client_po ?? "");
  }, [id]);

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
    api.get<Lists>("/workshop/lists").then(setLists).catch(() => setLists(null));
  }, [load]);

  async function savePo() {
    setBusy(true); setErr("");
    try {
      await api.post(`/workshop/orders/${id}/client-po`, { clientPo: po.trim() || null });
      setEditingPo(false);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function sendReturn() {
    if (!returnFor) return;
    setBusy(true); setErr(""); setOk("");
    try {
      await api.post(`/workshop/orders/${id}/items/${returnFor.id}/return`, {
        qty: returnQty, reasonId: returnReason || undefined,
      });
      setReturnFor(null);
      setOk("Return requested — Qparts will review it and arrange collection.");
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <button onClick={() => nav("/workshop/orders")} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink print:hidden">
        <ArrowLeft className="h-4 w-4" /> All orders
      </button>
      <PageHeader
        title={d.order_number}
        subtitle={`${d.workspace} · ${d.branch} · ${new Date(d.created_at).toLocaleDateString()}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(d.status ?? "")}>{d.status_label ?? "—"}</Badge>
            <button className="btn btn-sm rounded-md print:hidden" onClick={() => window.print()}>
              <Printer className="h-3.5 w-3.5" /> Print
            </button>
          </div>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      {ok && <div className="mb-3 rounded-md border border-line bg-[var(--chip-green-bg)] px-3 py-2 text-[13px] text-[var(--chip-green-fg)]">{ok}</div>}

      {/* ── the workshop's own PO ── */}
      <Card className="mb-4">
        <div className="flex items-center gap-3">
          <span className="text-[13px] font-medium text-ink">Your PO number:</span>
          {editingPo ? (
            <>
              <input className="input w-48 py-1" value={po} onChange={(e) => setPo(e.target.value)} placeholder="PO-…" />
              <button className="btn btn-sm rounded-md" disabled={busy} onClick={savePo}><Check className="h-3.5 w-3.5" /> Save</button>
            </>
          ) : (
            <>
              <span className="tnum text-[13px] text-sub">{d.client_po ?? "—"}</span>
              <button className="btn btn-sm rounded-md print:hidden" onClick={() => setEditingPo(true)}>
                <Pencil className="h-3.5 w-3.5" /> {d.client_po ? "Edit" : "Add"}
              </button>
            </>
          )}
        </div>
      </Card>

      {/* ── lines ── */}
      <Card pad={false} className="mb-4">
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Lines</div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr>
              <th className="th">Part</th><th className="th">Approved</th><th className="th">Delivered</th>
              <th className="th">Status</th><th className="th">Price</th><th className="th" />
            </tr></thead>
            <tbody>
              {d.lines.map((l) => {
                const delivered = ["delivered", "invoice_issued", "settled", "dn_sign_pending", "pending_invoice"].includes(l.status ?? "");
                return (
                  <tr key={l.id} className="trow">
                    <td className="td">
                      <div className="font-medium text-ink">{l.final_part_number ?? "—"}</div>
                      <div className="text-[12px] text-muted">{l.part_description ?? ""}</div>
                    </td>
                    <td className="td tnum">{l.approved_qty}</td>
                    <td className="td tnum">{l.delivered_qty}</td>
                    <td className="td"><Badge tone={statusTone(l.status ?? "")}>{l.status_label ?? "—"}</Badge></td>
                    <td className="td tnum">{l.selling_price ?? "—"}</td>
                    <td className="td text-right print:hidden">
                      {l.has_open_request ? (
                        <Badge tone="amber">request under review</Badge>
                      ) : delivered ? (
                        <button className="btn btn-sm rounded-md" onClick={() => { setReturnFor(l); setReturnQty(1); setReturnReason(""); }}>
                          <Undo2 className="h-3.5 w-3.5" /> Request return
                        </button>
                      ) : (
                        <span className="text-[11.5px] text-faint" title="Not delivered yet — ask from the request page">
                          <XCircle className="mr-1 inline h-3.5 w-3.5" />cancel from the request
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ── deliveries / invoices / credit notes ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card pad={false}>
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Deliveries</div>
          {d.deliveries.length === 0 ? <EmptyState title="Nothing delivered yet" /> : (
            <div className="divide-y divide-line-2">
              {d.deliveries.map((x) => (
                <div key={x.id} className="flex justify-between px-4 py-2.5 text-[13px]">
                  <span className="text-sub">{new Date(x.delivered_at ?? x.created_at).toLocaleDateString()}</span>
                  <span className="tnum text-ink">{x.qty} pc</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card pad={false}>
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Invoices</div>
          {d.invoices.length === 0 ? <EmptyState title="No invoice yet" /> : (
            <div className="divide-y divide-line-2">
              {d.invoices.map((x) => (
                <div key={x.id} className="flex justify-between px-4 py-2.5 text-[13px]">
                  <span className="text-sub">{x.invoice_number ?? "—"}</span>
                  <span className="tnum text-ink">{x.total_incl_vat ?? "—"} SAR</span>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card pad={false}>
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Credit notes</div>
          {d.creditNotes.length === 0 ? <EmptyState title="None" /> : (
            <div className="divide-y divide-line-2">
              {d.creditNotes.map((x) => (
                <div key={x.id} className="flex justify-between px-4 py-2.5 text-[13px]">
                  <span className="text-sub">{x.credit_note_number ?? "—"}</span>
                  <span className="tnum text-ink">{x.total ?? "—"} SAR</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ── return modal ── */}
      {returnFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setReturnFor(null)}>
          <div className="w-full max-w-md rounded-xl2 border border-line bg-panel p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-[15px] font-semibold text-ink">Request a return</h3>
            <p className="mb-3 text-[12.5px] text-sub">{returnFor.final_part_number} — approved {returnFor.approved_qty} pc.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={`Quantity (1–${returnFor.approved_qty})`}>
                <input type="number" min={1} max={returnFor.approved_qty} className="input"
                  value={returnQty}
                  onChange={(e) => setReturnQty(Math.min(returnFor.approved_qty, Math.max(1, Number(e.target.value) || 1)))} />
              </Field>
              <Field label="Reason">
                <select className="input" value={returnReason} onChange={(e) => setReturnReason(e.target.value)}>
                  <option value="">Choose…</option>
                  {lists?.returnReasons.map((r) => <option key={r.id} value={r.id}>{r.label_en}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn rounded-md" onClick={() => setReturnFor(null)}>Never mind</button>
              <button className="btn-primary rounded-md" disabled={busy || !returnReason} onClick={sendReturn}>Send request</button>
            </div>
          </div>
        </div>
      )}

      {/* No cancel modal here on purpose: undelivered lines are cancelled from the REQUEST page,
          where the item lives — one door per action, mirroring the legacy flow. */}
    </>
  );
}
