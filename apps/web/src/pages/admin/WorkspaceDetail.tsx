import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, Power, Link2, Plus, ClipboardCheck, Unlink } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";
import LinkCounterpartyDialog from "../../components/LinkCounterpartyDialog";
import { Link as RouterLink } from "react-router-dom";

interface WsDetail {
  workspace: { id: string; slug: string; name: string; is_sandbox: boolean; is_active: boolean; created_at: string; plan: string | null; plan_code: string | null; logo_url: string | null; settings: Record<string, unknown> };
  environment: "live" | "sandbox";
  users: Array<{ id: string; full_name: string; email: string; role: string; branch: string | null; is_active: boolean }>;
  workshops: Array<{ id: string; name: string; tax_number: string | null; branches: number }>;
  vendors: Array<{ id: string; legal_name: string; vendor_type: string; status: string; classification: string | null; user_id: string | null }>;
  submissions: Array<{ id: string; kind: string; counterparty_type: string; legal_name: string; tax_number: string | null; mobile: string | null; candidates: number }>;
  rfqs: Array<{ id: string; order_number: string; plate_number: string | null; status: string | null; items: number }>;
  orders: Array<{ id: string; order_number: string; status: string | null; items: number }>;
  invoices: Array<{ id: string; invoice_number: string | null; total_incl_vat: string | null; status: string | null; order_number: string }>;
}

const roleLabel: Record<string, string> = {
  company_admin: "Company admin",
  branch_manager: "Branch manager",
  service_advisor: "Service advisor",
};
type Tab = "overview" | "users" | "vendors" | "workshops" | "rfqs" | "orders" | "invoices";

export default function WorkspaceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { impersonate, environment } = useAuth();
  const [d, setD] = useState<WsDetail | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [linking, setLinking] = useState<"vendor" | "workshop" | null>(null);
  const [busy, setBusy] = useState(false);

  async function toggleActive(active: boolean) {
    setErr(""); setBusy(true);
    try { await api.patch(`/admin/workspaces/${id}`, { isActive: active }); await load(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function unlink(kind: "vendor" | "workshop", entityId: string) {
    setErr("");
    try { await api.post(`/admin/workspaces/${id}/unlink/${kind}/${entityId}`, {}); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  const load = useCallback(async () => {
    setD(await api.get<WsDetail>(`/admin/workspaces/${id}/detail`));
  }, [id]);
  // re-fetch when the workspace OR the Live/Sandbox environment changes (operational data switches)
  useEffect(() => {
    setD(null);
    load().catch((e) => setErr((e as Error).message));
  }, [id, environment, load]);

  if (err) return <EmptyState title="Couldn't load workspace" hint={err} />;
  if (!d) return <Spinner />;
  const { workspace: w, users, workshops, vendors, submissions, rfqs, orders, invoices } = d;
  const admins = users.filter((u) => u.role === "company_admin");

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "users", label: "Users", count: users.length },
    { key: "vendors", label: "Vendors", count: vendors.length },
    { key: "workshops", label: "Workshops", count: workshops.length },
    { key: "rfqs", label: "RFQs", count: rfqs.length },
    { key: "orders", label: "Orders", count: orders.length },
    { key: "invoices", label: "Invoices", count: invoices.length },
  ];

  return (
    <>
      <button onClick={() => nav("/admin/workspaces")} className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> All workspaces
      </button>
      <div className="mb-4 flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-accent text-[15px] font-bold text-white">{w.name[0]}</span>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-semibold tracking-tight text-ink">{w.name}</h1>
            {w.is_sandbox && <Badge tone="amber">sandbox</Badge>}
            <Badge tone={w.is_active ? "green" : "gray"}>{w.is_active ? "active" : "inactive"}</Badge>
          </div>
          <div className="text-[12.5px] text-muted tnum">{w.slug}.qparts.app</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {submissions.length > 0 && (
            <RouterLink to="/onboarding/review" className="btn btn-sm rounded-md">
              <ClipboardCheck className="h-3.5 w-3.5" /> {submissions.length} under review
            </RouterLink>
          )}
          <button className={`btn btn-sm rounded-md ${w.is_active ? "text-accent" : ""}`} disabled={busy}
            onClick={() => toggleActive(!w.is_active)}>
            <Power className="h-3.5 w-3.5" /> {busy ? "…" : w.is_active ? "Suspend workspace" : "Activate workspace"}
          </button>
        </div>
      </div>
      {!w.is_active && (
        <div className="mb-4 rounded-lg border border-line bg-surface px-4 py-2.5 text-[12.5px] text-sub">
          This workspace is <strong>suspended</strong> — its users cannot sign in and its subdomain is closed.
        </div>
      )}

      {/* tabs */}
      <div className="mb-4 flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${tab === t.key ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t.label}
            {t.count != null && <span className="ml-1.5 text-faint tnum">{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <Card>
            <h3 className="mb-3 text-[14px] font-semibold text-ink">Administrators</h3>
            {admins.length === 0 ? (
              <div className="text-[13px] text-muted">No company admin assigned.</div>
            ) : (
              <div className="flex flex-col gap-2">
                {admins.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-[13px]">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-50 text-[11px] font-semibold text-accent">
                      {a.full_name.split(" ").map((p) => p[0]).slice(0, 2).join("")}
                    </span>
                    <span className="font-medium text-ink">{a.full_name}</span>
                    <span className="text-muted">{a.email}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <h3 className="mb-3 text-[14px] font-semibold text-ink">At a glance</h3>
            <dl className="divide-y divide-line-2 text-[13px]">
              <div className="flex justify-between py-1.5"><dt className="text-muted">Users</dt><dd className="font-medium tnum">{users.length}</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Workshops</dt><dd className="font-medium tnum">{workshops.length}</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Vendors</dt><dd className="font-medium tnum">{vendors.length}</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Created</dt><dd className="font-medium">{new Date(w.created_at).toLocaleDateString()}</dd></div>
            </dl>
          </Card>

          {/* full record + platform-side controls */}
          <Card>
            <h3 className="mb-3 text-[14px] font-semibold text-ink">Workspace details</h3>
            <dl className="divide-y divide-line-2 text-[13px]">
              <div className="flex justify-between py-1.5"><dt className="text-muted">Subdomain</dt><dd className="font-medium tnum">{w.slug}.qparts.app</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Slug</dt><dd className="font-medium tnum">{w.slug}</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Plan</dt><dd className="font-medium">{w.plan ?? "—"}</dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Data mode</dt><dd><Badge tone={w.is_sandbox ? "amber" : "gray"}>{w.is_sandbox ? "sandbox workspace" : "live workspace"}</Badge></dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Status</dt><dd><Badge tone={w.is_active ? "green" : "gray"}>{w.is_active ? "active" : "suspended"}</Badge></dd></div>
              <div className="flex justify-between py-1.5"><dt className="text-muted">Workspace id</dt><dd className="font-medium tnum text-[11.5px]">{w.id}</dd></div>
            </dl>
          </Card>

          {/* what this workspace is waiting on us for */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-ink">Under review</h3>
              {submissions.length > 0 && <RouterLink to="/onboarding/review" className="btn btn-sm rounded-md">Open review queue</RouterLink>}
            </div>
            {submissions.length === 0 ? (
              <p className="text-[12.5px] text-muted">Nothing pending — this workspace has no counterparty submissions awaiting review.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {submissions.map((sb) => (
                  <div key={sb.id} className="flex items-center justify-between text-[13px]">
                    <span className="font-medium text-ink">{sb.legal_name}</span>
                    <div className="flex items-center gap-1.5">
                      <Badge tone="gray">{sb.kind}</Badge>
                      <Badge tone={sb.counterparty_type === "company" ? "gray" : "amber"}>{sb.counterparty_type}</Badge>
                      {sb.candidates > 0 && <Badge tone="amber">{sb.candidates} match</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === "users" && (
        <Card pad={false}>
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Branch</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="trow">
                  <td className="td font-medium text-ink">{u.full_name}</td>
                  <td className="td text-muted">{u.email}</td>
                  <td className="td"><Badge tone="blue">{roleLabel[u.role] ?? u.role}</Badge></td>
                  <td className="td text-muted">{u.branch ?? "All"}</td>
                  <td className="td"><Badge tone={u.is_active ? "green" : "gray"}>{u.is_active ? "active" : "inactive"}</Badge></td>
                  <td className="td text-right">
                    <button className="btn btn-sm rounded-md" onClick={() => impersonate(u.id)}><Eye className="h-3.5 w-3.5" /> View as</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {tab === "vendors" && (
        <>
        <div className="mb-3 flex items-center gap-2">
          <button className="btn btn-sm rounded-md" onClick={() => setLinking("vendor")}><Link2 className="h-3.5 w-3.5" /> Link existing vendor</button>
          <RouterLink to="/vendors" className="btn btn-sm rounded-md"><Plus className="h-3.5 w-3.5" /> New vendor</RouterLink>
        </div>
        {linking === "vendor" && (
          <LinkCounterpartyDialog workspaceId={w.id} kind="vendor" onClose={(l) => { setLinking(null); if (l) load(); }} />
        )}
        <Card pad={false}>
          {vendors.length === 0 ? (
            <EmptyState title="No vendors linked" hint="Link an existing supplier from the directory, or create a new one." />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Vendor</th><th className="th">Type</th><th className="th">Class</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>
                {vendors.map((v) => (
                  <tr key={v.id} className="trow">
                    <td className="td font-medium text-ink">{v.legal_name}</td>
                    <td className="td text-muted">{v.vendor_type}</td>
                    <td className="td tnum">{v.classification ?? "—"}</td>
                    <td className="td"><Badge tone={statusTone(v.status)}>{v.status}</Badge></td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button className="btn btn-sm rounded-md" onClick={() => nav(`/vendors/${v.id}`)}>Open</button>
                        {v.user_id && <button className="btn btn-sm rounded-md" onClick={() => impersonate(v.user_id!)}><Eye className="h-3.5 w-3.5" /> View as</button>}
                        <button className="btn btn-sm rounded-md text-accent" onClick={() => unlink("vendor", v.id)}><Unlink className="h-3.5 w-3.5" /> Unlink</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        </>
      )}

      {tab === "workshops" && (
        <>
        <div className="mb-3 flex items-center gap-2">
          <button className="btn btn-sm rounded-md" onClick={() => setLinking("workshop")}><Link2 className="h-3.5 w-3.5" /> Link existing workshop</button>
          <RouterLink to="/org/workshops" className="btn btn-sm rounded-md"><Plus className="h-3.5 w-3.5" /> New workshop</RouterLink>
        </div>
        {linking === "workshop" && (
          <LinkCounterpartyDialog workspaceId={w.id} kind="workshop" onClose={(l) => { setLinking(null); if (l) load(); }} />
        )}
        <Card pad={false}>
          {workshops.length === 0 ? (
            <EmptyState title="No workshops" hint="Link an existing workshop customer from the directory, or create a new one." />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Workshop</th><th className="th">Tax no.</th><th className="th">Branches</th><th className="th" /></tr></thead>
              <tbody>
                {workshops.map((wk) => (
                  <tr key={wk.id} className="trow">
                    <td className="td font-medium text-ink">{wk.name}</td>
                    <td className="td text-muted tnum">{wk.tax_number ?? "—"}</td>
                    <td className="td tnum">{wk.branches}</td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button className="btn btn-sm rounded-md" onClick={() => nav(`/org/workshops/${wk.id}`)}>Open</button>
                        <button className="btn btn-sm rounded-md text-accent" onClick={() => unlink("workshop", wk.id)}><Unlink className="h-3.5 w-3.5" /> Unlink</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        </>
      )}

      {(tab === "rfqs" || tab === "orders" || tab === "invoices") && (
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-muted">
          Showing
          <Badge tone={d.environment === "sandbox" ? "amber" : "green"}>{d.environment}</Badge>
          data — switch Live/Sandbox at the top to change.
        </div>
      )}

      {tab === "rfqs" && (
        <Card pad={false}>
          {rfqs.length === 0 ? (
            <EmptyState title={`No RFQs in ${d.environment}`} />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Order</th><th className="th">Plate</th><th className="th">Items</th><th className="th">Status</th></tr></thead>
              <tbody>
                {rfqs.map((r) => (
                  <tr key={r.id} className="trow cursor-pointer" onClick={() => nav(`/rfqs/${r.id}`)}>
                    <td className="td font-semibold text-accent tnum">{r.order_number}</td>
                    <td className="td tnum">{r.plate_number ?? "—"}</td>
                    <td className="td tnum">{r.items}</td>
                    <td className="td"><Badge tone={statusTone(r.status)}>{r.status ?? "—"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "orders" && (
        <Card pad={false}>
          {orders.length === 0 ? (
            <EmptyState title={`No orders in ${d.environment}`} />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Order</th><th className="th">Items</th><th className="th">Status</th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id} className="trow">
                    <td className="td font-semibold text-accent tnum">{o.order_number}</td>
                    <td className="td tnum">{o.items}</td>
                    <td className="td"><Badge tone={statusTone(o.status)}>{o.status ?? "—"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "invoices" && (
        <Card pad={false}>
          {invoices.length === 0 ? (
            <EmptyState title={`No invoices in ${d.environment}`} />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Invoice</th><th className="th">Order</th><th className="th">Total (SAR)</th><th className="th">Status</th></tr></thead>
              <tbody>
                {invoices.map((iv) => (
                  <tr key={iv.id} className="trow">
                    <td className="td font-medium text-ink tnum">{iv.invoice_number ?? "—"}</td>
                    <td className="td tnum text-muted">{iv.order_number}</td>
                    <td className="td tnum">{iv.total_incl_vat ?? "—"}</td>
                    <td className="td"><Badge tone={statusTone(iv.status)}>{iv.status ?? "—"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}
