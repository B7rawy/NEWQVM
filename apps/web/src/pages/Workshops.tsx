import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, Spinner, EmptyState, Field } from "../components/ui";

interface Workshop {
  id: string;
  name: string;
  tax_number: string | null;
  branches: number;
  is_active: boolean;
}
interface Branch {
  id: string;
  name: string;
  workshop: string;
  region: string | null;
  order_category: string;
}
interface Region {
  id: string;
  name: string;
}

export default function Workshops() {
  const { activeSlug, me } = useAuth();
  const isPlatform = me?.persona === "platform"; // only platform staff write the global workshop directory
  const canRequest = me?.role === "company_admin"; // a workspace onboards via the submission flow
  const [workshops, setWorkshops] = useState<Workshop[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [wName, setWName] = useState("");
  const [wTax, setWTax] = useState("");
  const [bWorkshop, setBWorkshop] = useState("");
  const [bName, setBName] = useState("");
  const [bRegion, setBRegion] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [w, b, r] = await Promise.all([
      api.get<{ workshops: Workshop[] }>("/org/workshops"),
      api.get<{ branches: Branch[] }>("/org/branches"),
      api.get<{ regions: Region[] }>("/org/regions"),
    ]);
    setWorkshops(w.workshops);
    setBranches(b.branches);
    setRegions(r.regions);
  }, []);
  useEffect(() => {
    // Scoped to the active workspace, or global when platform staff are unscoped.
    setWorkshops(null);
    load().catch((e) => {
      setErr((e as Error).message);
      setWorkshops([]);
    });
  }, [activeSlug, load]);

  async function addWorkshop(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/org/workshops", { name: wName, taxNumber: wTax || undefined });
      setWName("");
      setWTax("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function addBranch(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/org/branches", { workshopId: bWorkshop, name: bName, regionId: bRegion || undefined });
      setBName("");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader title="Workshops & Branches" subtitle="The client company's workshops and their branches" />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Workshops */}
        <div>
          <Card pad={false} className="mb-4">
            <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Workshops</div>
            {workshops === null ? (
              <Spinner />
            ) : workshops.length === 0 ? (
              <EmptyState title="No workshops yet" />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Name</th>
                    <th className="th">Tax no.</th>
                    <th className="th">Branches</th>
                  </tr>
                </thead>
                <tbody>
                  {workshops.map((w) => (
                    <tr key={w.id} className="trow">
                      <td className="td font-medium text-ink">{w.name}</td>
                      <td className="td tnum text-muted">{w.tax_number ?? "—"}</td>
                      <td className="td tnum">{w.branches}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          {isPlatform ? (
            <Card>
              <h3 className="mb-3 text-[14px] font-semibold text-ink">New workshop</h3>
              <form onSubmit={addWorkshop}>
                <Field label="Name">
                  <input className="input" value={wName} onChange={(e) => setWName(e.target.value)} placeholder="Al-Salam Motors" />
                </Field>
                <Field label="Tax number (optional)">
                  <input className="input" value={wTax} onChange={(e) => setWTax(e.target.value)} placeholder="3001234" />
                </Field>
                <button className="btn-primary w-full rounded-md" disabled={!wName}>
                  Add workshop
                </button>
              </form>
            </Card>
          ) : canRequest ? (
            <Card>
              <h3 className="mb-2 text-[14px] font-semibold text-ink">Add a workshop</h3>
              <p className="mb-3 text-[12.5px] text-muted">Workshops are verified centrally to avoid duplicates. Submit one for review and we'll link it to your workspace.</p>
              <Link to="/onboarding" className="btn-primary rounded-md">
                <Plus className="h-4 w-4" /> Request a workshop
              </Link>
            </Card>
          ) : null}
        </div>
        {/* Branches */}
        <div>
          <Card pad={false} className="mb-4">
            <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Branches</div>
            {branches.length === 0 ? (
              <EmptyState title="No branches yet" hint="Add a workshop first, then its branches." />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Branch</th>
                    <th className="th">Workshop</th>
                    <th className="th">Region</th>
                    <th className="th">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {branches.map((b) => (
                    <tr key={b.id} className="trow">
                      <td className="td font-medium text-ink">{b.name}</td>
                      <td className="td text-muted">{b.workshop}</td>
                      <td className="td text-muted">{b.region ?? "—"}</td>
                      <td className="td">
                        <Badge tone="gray">{b.order_category}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card>
            <h3 className="mb-3 text-[14px] font-semibold text-ink">New branch</h3>
            <form onSubmit={addBranch}>
              <Field label="Workshop">
                <select className="input" value={bWorkshop} onChange={(e) => setBWorkshop(e.target.value)}>
                  <option value="">Select workshop…</option>
                  {workshops?.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Branch name">
                <input className="input" value={bName} onChange={(e) => setBName(e.target.value)} placeholder="North branch" />
              </Field>
              <Field label="Region">
                <select className="input" value={bRegion} onChange={(e) => setBRegion(e.target.value)}>
                  <option value="">Select region…</option>
                  {regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <button className="btn-primary w-full rounded-md" disabled={!bWorkshop || !bName}>
                Add branch
              </button>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
