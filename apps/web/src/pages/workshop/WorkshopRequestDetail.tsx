import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Plus, ShoppingCart, XCircle, MessageSquare, Send } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../../components/ui";

/**
 * THE REQUEST, workshop-side — the legacy V3 dashboard's item workflow, ported whole
 * (docs/legacy/workshop-logic.md §4):
 *
 *  - the CART: only 'priced' lines are cartable; each carries an approved qty of 1..requested;
 *    confirming makes an order of exactly those lines and leaves the rest tendering. A later
 *    batch is a NEW order — by design, and the confirmation message says so.
 *  - CANCEL is a request, not an act: it files a governed exception with a catalog reason and the
 *    line keeps its status until Qparts approves. The button says "Request cancellation" because
 *    pretending it is immediate is exactly the lie the legacy UI told.
 *  - ADD ITEM enters at 'new_rfq' and returns its estimated (guide) price when history exists.
 *  - NOTES are the external thread; internal notes never reach this endpoint at all.
 */

interface Item {
  id: string;
  part_number: string | null;
  part_description: string | null;
  quantity: number;
  status: string | null;
  status_label: string | null;
  estimated_price: string | null;
  selling_price: string | null;
  ordered: boolean;
}
interface Detail {
  id: string;
  order_number: string;
  plate_number: string | null;
  vin: string | null;
  model: string | null;
  status: string | null;
  status_label: string | null;
  workspace: string;
  branch: string;
  items: Item[];
  vendors: Array<{ vendor: string; status: string; status_label: string; quoted_items: number }>;
}
interface Lists {
  brandClasses: Array<{ id: string; label_en: string }>;
  cancellationReasons: Array<{ id: string; label_en: string }>;
}
interface Note { id: string; body: string; author: string; created_at: string }

const CANCELLABLE = new Set(["new_rfq", "ready_for_quotation", "extract_pn", "sent_to_vendor", "tendering", "priced"]);

export default function WorkshopRequestDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Detail | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const [cart, setCart] = useState<Record<string, number>>({});
  const [cancelFor, setCancelFor] = useState<Item | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState({ partNumber: "", partDescription: "", quantity: 1, brandClassId: "" });
  const [noteBody, setNoteBody] = useState("");

  const load = useCallback(async () => {
    setD(await api.get<Detail>(`/workshop/requests/${id}`));
    setNotes((await api.get<{ notes: Note[] }>(`/workshop/notes?entityType=rfq&entityId=${id}`)).notes);
  }, [id]);

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
    api.get<Lists>("/workshop/lists").then(setLists).catch(() => setLists(null));
  }, [load]);

  const cartable = useMemo(() => (d?.items ?? []).filter((i) => i.status === "priced" && !i.ordered), [d]);
  const cartCount = Object.keys(cart).length;

  function toggleCart(it: Item) {
    setCart((c) => {
      const n = { ...c };
      if (n[it.id] !== undefined) delete n[it.id];
      else n[it.id] = it.quantity;
      return n;
    });
  }

  async function confirmCart() {
    setErr(""); setOk(""); setBusy(true);
    try {
      const items = Object.entries(cart).map(([rfqItemId, approvedQty]) => ({ rfqItemId, approvedQty }));
      const r = await api.post<{ orderNumber: string; confirmedItems: number }>(`/workshop/requests/${id}/confirm`, { items });
      setCart({});
      await load();
      setOk(`Order ${r.orderNumber} created with ${r.confirmedItems} item(s). Anything unticked stays open for a later batch.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function requestCancel() {
    if (!cancelFor) return;
    setErr(""); setOk(""); setBusy(true);
    try {
      await api.post(`/workshop/requests/${id}/items/${cancelFor.id}/cancel`, { reasonId: cancelReason || undefined });
      setCancelFor(null); setCancelReason("");
      setOk("Cancellation requested — Qparts will review it; the item keeps its status until then.");
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setOk(""); setBusy(true);
    try {
      const r = await api.post<{ estimatedPrice: string | null }>(`/workshop/requests/${id}/items`, {
        partNumber: add.partNumber || undefined,
        partDescription: add.partDescription || undefined,
        quantity: add.quantity,
        brandClassId: add.brandClassId || undefined,
      });
      setAdding(false);
      setAdd({ partNumber: "", partDescription: "", quantity: 1, brandClassId: "" });
      await load();
      setOk(r.estimatedPrice
        ? `Item added — estimated at ${r.estimatedPrice} SAR (guide price from history).`
        : "Item added — no price history, Qparts will estimate it manually.");
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function postNote(e: React.FormEvent) {
    e.preventDefault();
    if (!noteBody.trim()) return;
    setBusy(true);
    try {
      await api.post("/workshop/notes", { entityType: "rfq", entityId: id, body: noteBody.trim() });
      setNoteBody("");
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <button onClick={() => nav("/workshop/requests")} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> All requests
      </button>
      <PageHeader
        title={d.order_number}
        subtitle={`${d.workspace} · ${d.branch}${d.plate_number ? ` · plate ${d.plate_number}` : ""}${d.model ? ` · ${d.model}` : ""}`}
        actions={<Badge tone={statusTone(d.status ?? "")}>{d.status_label ?? "—"}</Badge>}
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      {ok && <div className="mb-3 rounded-md border border-line bg-[var(--chip-green-bg)] px-3 py-2 text-[13px] text-[var(--chip-green-fg)]">{ok}</div>}

      {/* ── items + the cart ── */}
      <Card pad={false} className="mb-4">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="text-[13px] font-semibold text-ink">Items</span>
          <button className="btn btn-sm rounded-md" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> Add item
          </button>
        </div>
        {adding && (
          <form onSubmit={addItem} className="grid grid-cols-1 gap-3 border-b border-line bg-surface px-4 py-3 md:grid-cols-5">
            <Field label="Part number"><input className="input" value={add.partNumber} onChange={(e) => setAdd({ ...add, partNumber: e.target.value })} /></Field>
            <Field label="Description"><input className="input" value={add.partDescription} onChange={(e) => setAdd({ ...add, partDescription: e.target.value })} /></Field>
            <Field label="Qty"><input type="number" min={1} className="input" value={add.quantity} onChange={(e) => setAdd({ ...add, quantity: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            <Field label="Brand class">
              <select className="input" value={add.brandClassId} onChange={(e) => setAdd({ ...add, brandClassId: e.target.value })}>
                <option value="">—</option>
                {lists?.brandClasses.map((b) => <option key={b.id} value={b.id}>{b.label_en}</option>)}
              </select>
            </Field>
            <div className="flex items-end">
              <button className="btn-primary mb-3 w-full rounded-md" disabled={busy || (!add.partNumber && !add.partDescription)}>Add</button>
            </div>
          </form>
        )}
        {d.items.length === 0 ? (
          <EmptyState title="No items" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px]">
              <thead><tr>
                <th className="th w-8"></th><th className="th">Part</th><th className="th">Qty</th>
                <th className="th">Status</th><th className="th">Estimated</th><th className="th">Price</th><th className="th" />
              </tr></thead>
              <tbody>
                {d.items.map((it) => {
                  const inCart = cart[it.id] !== undefined;
                  const isCartable = it.status === "priced" && !it.ordered;
                  return (
                    <tr key={it.id} className={`trow ${inCart ? "bg-[var(--chip-green-bg)]" : ""}`}>
                      <td className="td">
                        {isCartable && (
                          <input type="checkbox" checked={inCart} onChange={() => toggleCart(it)} aria-label="Add to cart" />
                        )}
                      </td>
                      <td className="td">
                        <div className="font-medium text-ink">{it.part_number ?? "—"}</div>
                        <div className="text-[12px] text-muted">{it.part_description ?? ""}</div>
                      </td>
                      <td className="td tnum">
                        {inCart ? (
                          <input
                            type="number" min={1} max={it.quantity}
                            className="input w-20 py-1"
                            value={cart[it.id]}
                            onChange={(e) => setCart({ ...cart, [it.id]: Math.min(it.quantity, Math.max(1, Number(e.target.value) || 1)) })}
                            title={`Approve 1..${it.quantity}`}
                          />
                        ) : it.quantity}
                      </td>
                      <td className="td"><Badge tone={statusTone(it.status ?? "")}>{it.status_label ?? "—"}</Badge></td>
                      <td className="td tnum text-muted">
                        {it.estimated_price ?? <span className="text-faint" title="No price history — Qparts reviews it manually">manual review</span>}
                      </td>
                      <td className="td tnum">{it.selling_price ?? "—"}</td>
                      <td className="td text-right">
                        {CANCELLABLE.has(it.status ?? "") && !it.ordered && (
                          <button className="btn btn-sm rounded-md text-accent" onClick={() => setCancelFor(it)}>
                            <XCircle className="h-3.5 w-3.5" /> Request cancellation
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {cartable.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface px-4 py-2.5">
            <span className="text-[12.5px] text-sub">
              <ShoppingCart className="mr-1 inline h-4 w-4" />
              {cartCount ? `${cartCount} item(s) in the cart — quantities editable above` : "Tick priced items to build your order"}
            </span>
            <button className="btn-primary rounded-md" disabled={!cartCount || busy} onClick={confirmCart}>
              Confirm {cartCount || ""} item(s)
            </button>
          </div>
        )}
      </Card>

      {/* ── sourcing progress: names and counts only, never supplier prices ── */}
      <Card pad={false} className="mb-4">
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">
          Sourcing progress ({d.vendors.filter((v) => v.quoted_items > 0).length}/{d.vendors.length} responded)
        </div>
        {d.vendors.length === 0 ? (
          <EmptyState title="Not sent to suppliers yet" hint="Qparts sends your request out after review." />
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

      {/* ── notes thread ── */}
      <Card pad={false}>
        <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">
          <MessageSquare className="mr-1 inline h-4 w-4" /> Notes
        </div>
        <div className="max-h-64 overflow-y-auto">
          {notes.length === 0 ? (
            <div className="px-4 py-3 text-[12.5px] text-faint">No notes yet.</div>
          ) : notes.map((n) => (
            <div key={n.id} className="border-b border-line-2 px-4 py-2.5">
              <div className="text-[12px] text-muted">{n.author} · {new Date(n.created_at).toLocaleString()}</div>
              <div className="text-[13px] text-ink">{n.body}</div>
            </div>
          ))}
        </div>
        <form onSubmit={postNote} className="flex gap-2 border-t border-line px-4 py-2.5">
          <input className="input flex-1" placeholder="Write a note to Qparts…" value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
          <button className="btn-primary rounded-md" disabled={busy || !noteBody.trim()} aria-label="Send note"><Send className="h-4 w-4" /></button>
        </form>
      </Card>

      {/* ── cancel modal ── */}
      {cancelFor && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setCancelFor(null)}>
          <div className="w-full max-w-md rounded-xl2 border border-line bg-panel p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-[15px] font-semibold text-ink">Request cancellation</h3>
            <p className="mb-3 text-[12.5px] text-sub">
              {cancelFor.part_number ?? cancelFor.part_description} — the item keeps its status until Qparts approves.
            </p>
            <Field label="Reason">
              <select className="input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)}>
                <option value="">Choose a reason…</option>
                {lists?.cancellationReasons.map((r) => <option key={r.id} value={r.id}>{r.label_en}</option>)}
              </select>
            </Field>
            <div className="mt-3 flex justify-end gap-2">
              <button className="btn rounded-md" onClick={() => setCancelFor(null)}>Keep it</button>
              <button className="btn-primary rounded-md" disabled={busy || !cancelReason} onClick={requestCancel}>Send request</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
