import { useEffect, useState, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";

interface Rfq {
  id: string;
  order_number: string;
  plate_number: string | null;
  status: string | null;
  items: number;
}
interface Branch {
  id: string;
  name: string;
}

export default function Rfqs() {
  const { activeSlug } = useAuth();
  const nav = useNavigate();
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [plate, setPlate] = useState("");
  const [partNumber, setPartNumber] = useState("");
  const [qty, setQty] = useState(1);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<{ rfqs: Rfq[] }>("/rfqs");
    setRfqs(res.rfqs);
    try {
      const b = await api.get<{ branches: Branch[] }>("/workspaces/branches");
      setBranches(b.branches);
      if (b.branches[0]) setBranchId((cur) => cur || b.branches[0].id);
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setRfqs(null);
    setBranches([]);
    setBranchId("");
    setErr("");
    load().catch((e) => {
      setErr((e as Error).message);
      setRfqs([]);
    });
  }, [activeSlug, load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/rfqs", {
        workshopBranchId: branchId,
        plateNumber: plate || undefined,
        items: [{ partNumber: partNumber || undefined, quantity: qty }],
      });
      setPlate("");
      setPartNumber("");
      setQty(1);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="RFQs" subtitle="Requests for quote in this workspace" />
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1fr_320px]">
        <Card pad={false}>
          {rfqs === null ? (
            <Spinner />
          ) : rfqs.length === 0 ? (
            <EmptyState title="No RFQs yet" hint="Create one from the form to get started." />
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Order</th>
                  <th className="th">Plate</th>
                  <th className="th">Items</th>
                  <th className="th">Status</th>
                  <th className="th w-4" />
                </tr>
              </thead>
              <tbody>
                {rfqs.map((r) => (
                  <tr key={r.id} className="trow cursor-pointer" onClick={() => nav(`/rfqs/${r.id}`)}>
                    <td className="td font-semibold text-accent tnum">{r.order_number}</td>
                    <td className="td tnum">{r.plate_number ?? <span className="text-faint">—</span>}</td>
                    <td className="td tnum">{r.items}</td>
                    <td className="td">
                      <Badge tone={statusTone(r.status)}>{r.status ?? "—"}</Badge>
                    </td>
                    <td className="td text-right">
                      <ChevronRight className="ml-auto h-4 w-4 text-line" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h3 className="mb-3 text-[14px] font-semibold text-ink">New RFQ</h3>
          <form onSubmit={create}>
            <Field label="Workshop branch">
              {branches.length ? (
                <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="branch id" />
              )}
            </Field>
            <Field label="Plate number">
              <input className="input" value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC-1234" />
            </Field>
            <Field label="Part number">
              <input className="input" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} placeholder="BRK-01" />
            </Field>
            <Field label="Quantity">
              <input className="input" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
            </Field>
            {err && <div className="mb-2 text-[13px] text-accent">{err}</div>}
            <button className="btn-primary w-full rounded-md" disabled={busy || !branchId}>
              {busy ? "Creating…" : "Create RFQ"}
            </button>
          </form>
        </Card>
      </div>
    </>
  );
}
