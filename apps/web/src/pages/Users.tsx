import { useEffect, useState, useCallback } from "react";
import { Plus, Eye } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, Spinner, EmptyState, Field } from "../components/ui";

interface Member {
  id: string;
  membership_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: string;
  branch: string | null;
  workshop_branch_id: string | null;
  is_active: boolean; // the user's GLOBAL account status
  membership_active: boolean; // whether they're active IN THIS WORKSPACE (what this screen manages)
}
interface Branch {
  id: string;
  name: string;
}

const roleLabel: Record<string, string> = {
  company_admin: "Company admin",
  branch_manager: "Branch manager",
  service_advisor: "Service advisor",
};

export default function Users() {
  const { activeSlug, me, impersonate } = useAuth();
  const canViewAs = me?.persona === "platform" || me?.role === "company_admin";
  const [rows, setRows] = useState<Member[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [show, setShow] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [f, setF] = useState({ email: "", fullName: "", role: "service_advisor", workshopBranchId: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [u, b, r] = await Promise.all([
      api.get<{ users: Member[] }>(`/admin/users?includeInactive=${showInactive}`),
      api.get<{ branches: Branch[] }>("/org/branches").catch(() => ({ branches: [] })),
      api.get<{ roles: string[] }>("/admin/users/roles").catch(() => ({ roles: ["company_admin", "branch_manager", "service_advisor"] })),
    ]);
    setRows(u.users);
    setBranches(b.branches);
    setRoles(r.roles);
  }, [showInactive]);

  async function patchMember(membershipId: string, body: Record<string, unknown>) {
    setErr("");
    try {
      await api.patch(`/admin/users/${membershipId}`, body);
      setEditing(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    if (!activeSlug) return;
    setRows(null);
    load().catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, [activeSlug, load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/admin/users", {
        email: f.email,
        fullName: f.fullName,
        role: f.role,
        workshopBranchId: f.workshopBranchId || undefined,
        password: f.password || undefined,
      });
      setF({ email: "", fullName: "", role: "service_advisor", workshopBranchId: "", password: "" });
      setShow(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Users & permissions are managed PER workspace (memberships belong to a workspace). In the
  // unscoped Admin-workspace view there is no single workspace to manage, so prompt to pick one
  // instead of leaving the table on an endless spinner.
  if (!activeSlug) {
    return (
      <>
        <PageHeader title="Users & Permissions" subtitle="People with access to a workspace" />
        <Card>
          <EmptyState
            title="Select a workspace"
            hint="User accounts and permissions are managed per workspace. Choose a workspace from the switcher to view and manage its users."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Users & Permissions"
        subtitle="People with access to this workspace"
        actions={
          <>
            <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Show inactive
            </label>
            <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
              <Plus className="h-4 w-4" /> Add user
            </button>
          </>
        }
      />
      {show && (
        <Card className="mb-5">
          <form onSubmit={add} className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Full name">
              <input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="Nasser Al-Otaibi" />
            </Field>
            <Field label="Email">
              <input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="nasser@company.sa" />
            </Field>
            <Field label="Role">
              <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel[r] ?? r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Branch (optional)">
              <select className="input" value={f.workshopBranchId} onChange={(e) => setF({ ...f, workshopBranchId: e.target.value })}>
                <option value="">All branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Password (optional)">
              <input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="Set now or invite later" />
            </Field>
            <div className="flex items-end">
              <button className="btn-primary mb-3 w-full rounded-md" disabled={busy || !f.email || !f.fullName}>
                {busy ? "Adding…" : "Add user"}
              </button>
            </div>
          </form>
          {err && <div className="text-[13px] text-accent">{err}</div>}
        </Card>
      )}

      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No users yet" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Email</th>
                <th className="th">Role</th>
                <th className="th">Branch</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {rows.map((u) =>
                editing === u.membership_id ? (
                  <tr key={u.id} className="trow bg-surface">
                    <td className="td font-medium text-ink">{u.full_name}</td>
                    <td className="td text-muted">{u.email}</td>
                    <td className="td">
                      <select
                        className="input py-1 text-[12px]"
                        defaultValue={u.role}
                        onChange={(e) => (u.role = e.target.value)}
                        id={`role-${u.membership_id}`}
                      >
                        {roles.map((r) => (
                          <option key={r} value={r}>{roleLabel[r] ?? r}</option>
                        ))}
                      </select>
                    </td>
                    <td className="td">
                      <select className="input py-1 text-[12px]" defaultValue={u.workshop_branch_id ?? ""} id={`branch-${u.membership_id}`}>
                        <option value="">All branches</option>
                        {branches.map((b) => (
                          <option key={b.id} value={b.id}>{b.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="td" colSpan={2}>
                      <div className="flex justify-end gap-2">
                        <button
                          className="btn-primary btn-sm rounded-md"
                          onClick={() => {
                            const role = (document.getElementById(`role-${u.membership_id}`) as HTMLSelectElement).value;
                            const branch = (document.getElementById(`branch-${u.membership_id}`) as HTMLSelectElement).value;
                            patchMember(u.membership_id, { role, workshopBranchId: branch || null });
                          }}
                        >
                          Save
                        </button>
                        <button className="btn btn-sm rounded-md" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={u.id} className="trow">
                    <td className="td font-medium text-ink">{u.full_name}</td>
                    <td className="td text-muted">{u.email}</td>
                    <td className="td">
                      <Badge tone="blue">{roleLabel[u.role] ?? u.role}</Badge>
                    </td>
                    <td className="td text-muted">{u.branch ?? "All"}</td>
                    <td className="td">
                      <Badge tone={u.membership_active ? "green" : "gray"}>{u.membership_active ? "active" : "inactive"}</Badge>
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5">
                        <button className="btn btn-sm rounded-md" onClick={() => setEditing(u.membership_id)}>Edit</button>
                        <button
                          className={`btn btn-sm rounded-md ${u.membership_active ? "text-accent" : ""}`}
                          onClick={() => patchMember(u.membership_id, { isActive: !u.membership_active })}
                        >
                          {u.membership_active ? "Deactivate" : "Reactivate"}
                        </button>
                        {canViewAs && u.id !== me?.user?.id && u.is_active && (
                          <button className="btn btn-sm rounded-md" onClick={() => impersonate(u.id)}>
                            <Eye className="h-3.5 w-3.5" /> View as
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
