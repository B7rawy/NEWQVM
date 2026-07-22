import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface WsDetail {
  workspace: { id: string; slug: string; name: string; is_sandbox: boolean; is_active: boolean; created_at: string };
  users: Array<{ id: string; full_name: string; email: string; role: string; branch: string | null; is_active: boolean }>;
  workshops: Array<{ id: string; name: string; tax_number: string | null; branches: number }>;
  vendors: Array<{ id: string; legal_name: string; vendor_type: string; status: string; classification: string | null; user_id: string | null }>;
}

const roleLabel: Record<string, string> = {
  company_admin: "Company admin",
  branch_manager: "Branch manager",
  service_advisor: "Service advisor",
};
type Tab = "overview" | "users" | "vendors" | "workshops";

export default function WorkspaceDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { impersonate } = useAuth();
  const [d, setD] = useState<WsDetail | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    setD(await api.get<WsDetail>(`/admin/workspaces/${id}/detail`));
  }, [id]);
  useEffect(() => {
    setD(null);
    load().catch((e) => setErr((e as Error).message));
  }, [id, load]);

  if (err) return <EmptyState title="Couldn't load workspace" hint={err} />;
  if (!d) return <Spinner />;
  const { workspace: w, users, workshops, vendors } = d;
  const admins = users.filter((u) => u.role === "company_admin");

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "overview", label: "Overview" },
    { key: "users", label: "Users", count: users.length },
    { key: "vendors", label: "Vendors", count: vendors.length },
    { key: "workshops", label: "Workshops", count: workshops.length },
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
      </div>

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
        <Card pad={false}>
          {vendors.length === 0 ? (
            <EmptyState title="No vendors linked" />
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
                      {v.user_id && <button className="btn btn-sm rounded-md" onClick={() => impersonate(v.user_id!)}><Eye className="h-3.5 w-3.5" /> View as</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "workshops" && (
        <Card pad={false}>
          {workshops.length === 0 ? (
            <EmptyState title="No workshops" />
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Workshop</th><th className="th">Tax no.</th><th className="th">Branches</th></tr></thead>
              <tbody>
                {workshops.map((wk) => (
                  <tr key={wk.id} className="trow">
                    <td className="td font-medium text-ink">{wk.name}</td>
                    <td className="td text-muted tnum">{wk.tax_number ?? "—"}</td>
                    <td className="td tnum">{wk.branches}</td>
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
