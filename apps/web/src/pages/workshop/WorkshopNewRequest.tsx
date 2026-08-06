import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Field, Spinner } from "../../components/ui";

interface Ctx { workspaces: { id: string; name: string }[]; branches: { id: string; name: string; workshop: string }[] }
interface Lists { brandClasses: Array<{ id: string; label_en: string }> }
interface PartRow { partNumber: string; partDescription: string; quantity: string; brandClassId: string }

const emptyRow = (): PartRow => ({ partNumber: "", partDescription: "", quantity: "1", brandClassId: "" });

export default function WorkshopNewRequest() {
  const nav = useNavigate();
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [lists, setLists] = useState<Lists | null>(null);
  const [vin, setVin] = useState("");
  const [orderType, setOrderType] = useState<"regular" | "bulk">("regular");
  const [tenantId, setTenantId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [plate, setPlate] = useState("");
  const [model, setModel] = useState("");
  const [parts, setParts] = useState<PartRow[]>([emptyRow()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<Ctx>("/workshop/context").then((c) => {
      setCtx(c);
      if (c.workspaces[0]) setTenantId(c.workspaces[0].id);
      if (c.branches[0]) setBranchId(c.branches[0].id);
    }).catch((e) => setErr((e as Error).message));
    api.get<Lists>("/workshop/lists").then(setLists).catch(() => setLists(null));
  }, []);

  function setPart(i: number, field: keyof PartRow, value: string) {
    setParts((p) => p.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const items = parts
      .filter((p) => (p.partNumber || p.partDescription) && Number(p.quantity) > 0)
      .map((p) => ({ partNumber: p.partNumber || undefined, partDescription: p.partDescription || undefined, quantity: Number(p.quantity), brandClassId: p.brandClassId || undefined }));
    if (!tenantId || !branchId) return setErr("Choose a workspace and a branch.");
    if (items.length === 0) return setErr("Add at least one part (number or description).");
    setBusy(true);
    try {
      const res = await api.post<{ id: string }>("/workshop/requests", {
        tenantId, workshopBranchId: branchId, plateNumber: plate || undefined, vin: vin || undefined, model: model || undefined, orderType, items,
      });
      nav(`/workshop/requests/${res.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!ctx) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <PageHeader title="New parts request" subtitle="Choose the workspace and branch, then list the parts you need — suppliers will quote." />
      <form onSubmit={submit}>
        <Card className="mb-5">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Workspace">
              <select className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {ctx.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </Field>
            <Field label="Branch">
              <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {ctx.branches.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.workshop}</option>)}
              </select>
            </Field>
            <Field label="Plate number (optional)">
              <input className="input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC-1234" />
            </Field>
            <Field label="Vehicle model (optional)">
              <input className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Camry 2021" />
            </Field>
            <Field label="VIN (optional)">
              <input className="input" value={vin} onChange={(e) => setVin(e.target.value)} placeholder="JTDBT923771012345" />
            </Field>
            <Field label="Order type">
              {/* the legacy pair: a Service Order fixes one car, Stock replenishes the shelf */}
              <select className="input" value={orderType} onChange={(e) => setOrderType(e.target.value as "regular" | "bulk")}>
                <option value="regular">Service order (one vehicle)</option>
                <option value="bulk">Stock (bulk replenishment)</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card pad={false} className="mb-5">
          <div className="flex items-center justify-between border-b border-line-2 px-5 py-3">
            <span className="text-[14px] font-semibold text-ink">Required parts</span>
            <button type="button" className="btn btn-sm rounded-md" onClick={() => setParts((p) => [...p, emptyRow()])}>
              <Plus className="h-3.5 w-3.5" /> Add part
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Part number</th>
                  <th className="th">Description</th>
                  <th className="th">Qty</th>
                  <th className="th">Brand class</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={i} className="trow">
                    <td className="td"><input className="input h-8 py-1" value={p.partNumber} onChange={(e) => setPart(i, "partNumber", e.target.value)} placeholder="12345-67890" /></td>
                    <td className="td"><input className="input h-8 py-1" value={p.partDescription} onChange={(e) => setPart(i, "partDescription", e.target.value)} placeholder="Brake Pad Set" /></td>
                    <td className="td"><input className="input h-8 w-20 py-1 tnum" type="number" min="1" value={p.quantity} onChange={(e) => setPart(i, "quantity", e.target.value)} /></td>
                    <td className="td">
                      <select className="input h-8 py-1" value={p.brandClassId} onChange={(e) => setPart(i, "brandClassId", e.target.value)}>
                        <option value="">Any</option>
                        {lists?.brandClasses.map((b) => <option key={b.id} value={b.id}>{b.label_en}</option>)}
                      </select>
                    </td>
                    <td className="td text-right">
                      {parts.length > 1 && (
                        <button type="button" className="text-faint hover:text-accent" onClick={() => setParts((pp) => pp.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
        <button className="btn-primary rounded-md" disabled={busy}>{busy ? "Submitting…" : "Submit request"}</button>
      </form>
    </>
  );
}
