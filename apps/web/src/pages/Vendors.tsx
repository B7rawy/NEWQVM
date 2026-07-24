import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { Plus, Eye } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";

interface Vendor {
  id: string;
  legal_name: string;
  vendor_type: string;
  counterparty_type: "individual" | "company";
  activation_status: string;
  tax_number: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  status: string;
  classification: string | null;
  branches: number;
  user_id: string | null;
}

interface Ws {
  id: string;
  slug: string;
  name: string;
}

export default function Vendors() {
  const { activeSlug, me, impersonate } = useAuth();
  const isPlatform = me?.persona === "platform";
  const canManage = isPlatform; // only platform staff write the global vendor directory
  const canViewAs = isPlatform;
  const canRequest = me?.role === "company_admin"; // a workspace onboards via the submission flow
  const [rows, setRows] = useState<Vendor[] | null>(null);
  const [show, setShow] = useState(false);
  const [workspaces, setWorkspaces] = useState<Ws[]>([]);
  const [targetWs, setTargetWs] = useState("");
  const [f, setF] = useState({ counterpartyType: "company", legalName: "", taxNumber: "", vendorType: "commercial", primaryEmail: "", primaryPhone: "", classification: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const isCompany = f.counterpartyType === "company";

  const load = useCallback(async () => {
    const r = await api.get<{ vendors: Vendor[] }>("/vendors");
    setRows(r.vendors);
  }, []);
  useEffect(() => {
    // Loads scoped to the active workspace, OR globally when platform staff are unscoped.
    setRows(null);
    load().catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
    if (isPlatform) api.get<{ workspaces: Ws[] }>("/admin/workspaces").then((r) => setWorkspaces(r.workspaces)).catch(() => {});
  }, [activeSlug, load, isPlatform]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/vendors", {
        counterpartyType: f.counterpartyType,
        legalName: f.legalName,
        taxNumber: isCompany ? f.taxNumber || undefined : undefined,
        vendorType: f.vendorType,
        primaryEmail: f.primaryEmail || undefined,
        primaryPhone: f.primaryPhone || undefined,
        classification: f.classification || undefined,
        tenantId: targetWs || undefined,
      });
      setF({ counterpartyType: "company", legalName: "", taxNumber: "", vendorType: "commercial", primaryEmail: "", primaryPhone: "", classification: "" });
      setShow(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function setStatus(id: string, status: string) {
    setErr("");
    try {
      await api.post(`/vendors/${id}/status`, { status });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Vendors"
        subtitle="Suppliers linked to this workspace"
        actions={
          canManage ? (
            <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
              <Plus className="h-4 w-4" /> New vendor
            </button>
          ) : canRequest ? (
            <Link to="/onboarding" className="btn-primary rounded-md">
              <Plus className="h-4 w-4" /> Request a vendor
            </Link>
          ) : undefined
        }
      />
      {show && (
        <Card className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {/* QNEW-71: legal form is the FIRST decision and drives the required identifier below. */}
            <Field label="Type">
              <div className="flex gap-2">
                {(["company", "individual"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setF({ ...f, counterpartyType: t })}
                    className={`btn btn-sm flex-1 rounded-md ${f.counterpartyType === t ? "btn-primary" : ""}`}
                  >
                    {t === "company" ? "Company" : "Individual"}
                  </button>
                ))}
              </div>
            </Field>
            {isPlatform && (
              <Field label="Workspace">
                <select className="input" value={targetWs} onChange={(e) => setTargetWs(e.target.value)}>
                  <option value="">Active ({activeSlug})</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={isCompany ? "Legal name" : "Full name"}>
              <input className="input" value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} placeholder={isCompany ? "Gulf Auto Parts Co." : "Ahmed Al-Otaibi"} />
            </Field>
            {isCompany ? (
              <Field label="Tax number (required)">
                <input className="input" value={f.taxNumber} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} placeholder="3xxxxxxxxxxxxx3" />
              </Field>
            ) : (
              <Field label="Mobile (required)">
                <input className="input" value={f.primaryPhone} onChange={(e) => setF({ ...f, primaryPhone: e.target.value })} placeholder="05xxxxxxxx" />
              </Field>
            )}
            <Field label="Category">
              <select className="input" value={f.vendorType} onChange={(e) => setF({ ...f, vendorType: e.target.value })}>
                <option value="commercial">Commercial</option>
                <option value="agency">Agency</option>
                <option value="external">External</option>
              </select>
            </Field>
            <Field label="Classification">
              <input className="input" value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })} placeholder="A / B / C" />
            </Field>
            <Field label="Email">
              <input className="input" value={f.primaryEmail} onChange={(e) => setF({ ...f, primaryEmail: e.target.value })} placeholder="sales@gulf.sa" />
            </Field>
            {isCompany && (
              <Field label="Phone">
                <input className="input" value={f.primaryPhone} onChange={(e) => setF({ ...f, primaryPhone: e.target.value })} placeholder="+9665…" />
              </Field>
            )}
            <div className="flex items-end">
              <button
                className="btn-primary mb-3 w-full rounded-md"
                disabled={busy || f.legalName.trim().length < 2 || (isCompany ? !f.taxNumber : !f.primaryPhone)}
              >
                {busy ? "Creating…" : "Create vendor"}
              </button>
            </div>
          </form>
          {err && <div className="text-[13px] text-accent">{err}</div>}
        </Card>
      )}

      {rows && rows.some((v) => v.activation_status === "pending") && (
        <div className="mb-3 flex items-center gap-2">
          <button
            className={`btn btn-sm rounded-md ${pendingOnly ? "btn-primary" : ""}`}
            onClick={() => setPendingOnly((v) => !v)}
          >
            Pending activation ({rows.filter((v) => v.activation_status === "pending").length})
          </button>
          {pendingOnly && <span className="text-[12.5px] text-muted">showing accounts awaiting activation</span>}
        </div>
      )}
      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : (pendingOnly ? rows.filter((v) => v.activation_status === "pending") : rows).length === 0 ? (
          <EmptyState title="No vendors yet" hint={me?.isInternal ? "Add your first vendor." : "No suppliers linked to this workspace."} />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Vendor</th>
                <th className="th">Type</th>
                <th className="th">Category</th>
                <th className="th">Class</th>
                <th className="th">Contact</th>
                <th className="th">Branches</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {(pendingOnly ? rows.filter((v) => v.activation_status === "pending") : rows).map((v) => (
                <tr key={v.id} className="trow">
                  <td className="td font-medium text-ink">{v.legal_name}</td>
                  <td className="td">
                    <Badge tone={v.counterparty_type === "company" ? "gray" : "amber"}>{v.counterparty_type}</Badge>
                  </td>
                  <td className="td text-muted">{v.vendor_type}</td>
                  <td className="td tnum">{v.classification ?? "—"}</td>
                  <td className="td text-muted">{v.primary_email ?? v.primary_phone ?? "—"}</td>
                  <td className="td tnum">{v.branches}</td>
                  <td className="td">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={statusTone(v.status)}>{v.status}</Badge>
                      {v.activation_status === "pending" && <Badge tone="amber">pending activation</Badge>}
                    </div>
                  </td>
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {isPlatform &&
                        (v.status === "active" ? (
                          <button className="btn btn-sm rounded-md text-accent" onClick={() => setStatus(v.id, "suspended")}>Suspend</button>
                        ) : (
                          <button className="btn btn-sm rounded-md" onClick={() => setStatus(v.id, "active")}>Reactivate</button>
                        ))}
                      {canViewAs && v.user_id && (
                        <button className="btn btn-sm rounded-md" onClick={() => impersonate(v.user_id!)}>
                          <Eye className="h-3.5 w-3.5" /> View as
                        </button>
                      )}
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
