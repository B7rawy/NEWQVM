import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft, KeyRound, Plus, Building2, Users, Files, Upload, Eye } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";
import CreateAccountDialog from "../components/CreateAccountDialog";
import BulkAccountsDialog from "../components/BulkAccountsDialog";

/**
 * One workshop's own page — the full record behind a directory row: identity, branches, portal
 * accounts (create them here), the workspaces it's linked to, and its recent requests. A scoped
 * workspace user only ever sees its OWN link + requests (the API enforces it).
 */
interface Detail {
  workshop: {
    id: string; name: string; counterparty_type: "individual" | "company"; activation_status: string;
    tax_number: string | null; commercial_registration_number: string | null;
    primary_phone: string | null; primary_email: string | null; is_active: boolean; created_at: string;
  };
  branches: Array<{ id: string; name: string; region: string | null; city: string | null; order_category: string; is_active: boolean }>;
  accounts: Array<{ id: string; full_name: string; email: string; phone: string | null; is_active: boolean; is_workshop_admin: boolean }>;
  workspaces: Array<{ id: string; name: string; slug: string; status: string }>;
  requests: Array<{ id: string; order_number: string; plate_number: string | null; status: string | null; branch: string; workspace: string; ordered: boolean }>;
}
interface Region { id: string; name: string }

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line-2 py-2.5 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="text-[13px] font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

export default function WorkshopDetail() {
  const { id } = useParams();
  const { me, impersonate } = useAuth();
  const isPlatform = me?.persona === "platform";
  const [d, setD] = useState<Detail | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [err, setErr] = useState("");
  const [acct, setAcct] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [addBranch, setAddBranch] = useState(false);
  const [bName, setBName] = useState("");
  const [bRegion, setBRegion] = useState("");

  const load = useCallback(async () => {
    const r = await api.get<Detail>(`/org/workshops/${id}`);
    setD(r);
  }, [id]);
  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
    api.get<{ regions: Region[] }>("/org/regions").then((r) => setRegions(r.regions)).catch(() => {});
  }, [load]);

  async function submitBranch(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/org/branches", { workshopId: id, name: bName.trim(), regionId: bRegion || undefined });
      setBName(""); setBRegion(""); setAddBranch(false);
      await load();
    } catch (e) { setErr((e as Error).message); }
  }

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;
  const w = d.workshop;
  const ready = d.branches.length > 0 && d.accounts.length > 0;
  const admin = d.accounts.find((a) => a.is_workshop_admin) ?? d.accounts[0];

  return (
    <>
      <Link to="/org/workshops" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <ChevronLeft className="h-3.5 w-3.5" /> Workshops
      </Link>
      <PageHeader
        title={w.name}
        subtitle={`${w.counterparty_type === "company" ? "Company" : "Individual"} customer · added ${new Date(w.created_at).toLocaleDateString()}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(w.activation_status)}>{w.activation_status}</Badge>
            {ready ? <Badge tone="green">ready</Badge> : <Badge tone="amber">setup incomplete</Badge>}
            {isPlatform && admin && (
              <button className="btn btn-sm rounded-md" onClick={() => impersonate(admin.id)}>
                <Eye className="h-3.5 w-3.5" /> View as
              </button>
            )}
          </div>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      {acct && (
        <CreateAccountDialog kind="workshop" entityId={w.id} entityName={w.name}
          onClose={(created) => { setAcct(false); if (created) load(); }} />
      )}
      {bulk && (
        <BulkAccountsDialog kind="workshop" entityId={w.id} entityName={w.name}
          onClose={(imported) => { setBulk(false); if (imported) load(); }} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* identity */}
        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Identity</h3>
          <Row label="Legal form" value={<Badge tone={w.counterparty_type === "company" ? "gray" : "amber"}>{w.counterparty_type}</Badge>} />
          <Row label={w.counterparty_type === "company" ? "Tax number" : "Mobile (identifier)"}
            value={w.counterparty_type === "company" ? w.tax_number : w.primary_phone} />
          <Row label="Commercial reg." value={w.commercial_registration_number} />
          <Row label="Phone" value={w.primary_phone} />
          <Row label="Email" value={w.primary_email} />
        </Card>

        {/* portal accounts */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink">
              <Users className="mr-1.5 inline h-4 w-4 text-faint" /> Portal users
            </h3>
            {isPlatform && (
              <div className="flex items-center gap-1.5">
                <button className="btn btn-sm rounded-md" onClick={() => setAcct(true)}>
                  <KeyRound className="h-3.5 w-3.5" /> Add user
                </button>
                <button className="btn btn-sm rounded-md" onClick={() => setBulk(true)}>
                  <Upload className="h-3.5 w-3.5" /> Import users
                </button>
              </div>
            )}
          </div>
          {d.accounts.length === 0 ? (
            <p className="text-[12.5px] text-muted">No users yet — nobody can sign in as this workshop. Add one so the owner can raise their own requests.</p>
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Status</th></tr></thead>
              <tbody>
                {d.accounts.map((a) => (
                  <tr key={a.id} className="trow">
                    <td className="td font-medium text-ink">{a.full_name}</td>
                    <td className="td text-muted">{a.email}</td>
                    <td className="td">{a.is_workshop_admin ? <Badge tone="blue">admin</Badge> : <Badge tone="gray">staff</Badge>}</td>
                    <td className="td"><Badge tone={a.is_active ? "green" : "gray"}>{a.is_active ? "active" : "inactive"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* branches */}
        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink">
              <Building2 className="mr-1.5 inline h-4 w-4 text-faint" /> Branches
            </h3>
            {isPlatform && !addBranch && (
              <button className="btn btn-sm rounded-md" onClick={() => setAddBranch(true)}><Plus className="h-3.5 w-3.5" /> Add branch</button>
            )}
          </div>
          {addBranch && (
            <form onSubmit={submitBranch} className="mb-3 flex flex-wrap items-end gap-2">
              <Field label="Branch name">
                <input className="input h-8 w-48 py-1" value={bName} onChange={(e) => setBName(e.target.value)} placeholder="North branch" />
              </Field>
              <Field label="Region">
                <select className="input h-8 w-40 py-1" value={bRegion} onChange={(e) => setBRegion(e.target.value)}>
                  <option value="">—</option>
                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </Field>
              <button className="btn-primary mb-3 rounded-md" disabled={!bName.trim()}>Add</button>
              <button type="button" className="btn btn-sm mb-3 rounded-md" onClick={() => setAddBranch(false)}>Cancel</button>
            </form>
          )}
          {d.branches.length === 0 ? (
            <p className="text-[12.5px] text-muted">No branches — a request is always raised for a branch, so this workshop cannot be ordered for yet.</p>
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Branch</th><th className="th">Region</th><th className="th">City</th><th className="th">Type</th></tr></thead>
              <tbody>
                {d.branches.map((b) => (
                  <tr key={b.id} className="trow">
                    <td className="td font-medium text-ink">{b.name}</td>
                    <td className="td text-muted">{b.region ?? "—"}</td>
                    <td className="td text-muted">{b.city ?? "—"}</td>
                    <td className="td"><Badge tone="gray">{b.order_category}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* workspaces */}
        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Workspaces</h3>
          {d.workspaces.length === 0 ? (
            <p className="text-[12.5px] text-muted">Not linked to any workspace.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {d.workspaces.map((x) => (
                <div key={x.id} className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-ink">{x.name}</span>
                  <Badge tone={statusTone(x.status)}>{x.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* recent requests */}
      <Card pad={false} className="mt-5">
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">
          <Files className="mr-1.5 inline h-4 w-4 text-faint" /> Recent requests
        </div>
        {d.requests.length === 0 ? (
          <EmptyState title="No requests yet" hint="Requests raised for this workshop's branches will appear here." />
        ) : (
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Plate</th><th className="th">Branch</th><th className="th">Workspace</th><th className="th">Status</th></tr></thead>
            <tbody>
              {d.requests.map((r) => (
                <tr key={r.id} className="trow">
                  <td className="td font-medium text-ink">{r.order_number}</td>
                  <td className="td text-muted">{r.plate_number ?? "—"}</td>
                  <td className="td text-muted">{r.branch}</td>
                  <td className="td text-muted">{r.workspace}</td>
                  <td className="td">
                    <div className="flex items-center gap-1.5">
                      <Badge tone="gray">{r.status ?? "—"}</Badge>
                      {r.ordered && <Badge tone="green">ordered</Badge>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
