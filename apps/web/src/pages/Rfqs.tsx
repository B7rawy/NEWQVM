import { useEffect, useState, useCallback } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

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
  const [rfqs, setRfqs] = useState<Rfq[]>([]);
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
    // branches come from a lightweight endpoint; fall back gracefully if none
    try {
      const b = await api.get<{ branches: Branch[] }>("/workspaces/branches");
      setBranches(b.branches);
      if (b.branches[0]) setBranchId((cur) => cur || b.branches[0].id);
    } catch {
      /* endpoint optional */
    }
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    setRfqs([]);
    setBranches([]);
    setBranchId("");
    setErr("");
    load().catch((e) => setErr((e as Error).message));
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
      <div className="page-head">
        <h1>RFQs</h1>
      </div>
      <div className="grid2">
        <div className="card">
          {rfqs.length === 0 ? (
            <div className="empty">No RFQs yet in this workspace.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Plate</th>
                  <th>Items</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rfqs.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.order_number}</strong></td>
                    <td>{r.plate_number ?? <span className="muted">—</span>}</td>
                    <td>{r.items}</td>
                    <td><span className="badge">{r.status ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <form className="card" onSubmit={create}>
          <h3 style={{ marginTop: 0 }}>New RFQ</h3>
          <div className="field">
            <label>Workshop branch</label>
            {branches.length ? (
              <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            ) : (
              <input value={branchId} onChange={(e) => setBranchId(e.target.value)} placeholder="branch id" />
            )}
          </div>
          <div className="field">
            <label>Plate number</label>
            <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="ABC-1234" />
          </div>
          <div className="field">
            <label>Part number</label>
            <input value={partNumber} onChange={(e) => setPartNumber(e.target.value)} placeholder="BRK-01" />
          </div>
          <div className="field">
            <label>Quantity</label>
            <input type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          </div>
          {err && <div className="err">{err}</div>}
          <button className="primary" style={{ width: "100%" }} disabled={busy || !branchId}>
            {busy ? "Creating…" : "Create RFQ"}
          </button>
        </form>
      </div>
    </>
  );
}
