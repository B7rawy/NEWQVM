import { useEffect, useState, useCallback, useMemo } from "react";
import { Plus, Search, ShieldCheck, Eye } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { Card, Badge, Spinner, EmptyState, Field } from "../../components/ui";

/**
 * The PLATFORM system view of people (ADR-0010). Two distinct populations:
 *  - Platform staff  → platform_members: Qparts' own team, spans every workspace.
 *  - Everyone else   → the global directory: which workspaces each account belongs to, and whether
 *    it is a vendor/workshop portal login.
 * Workspace ROLES are not editable here — a role only means something inside a workspace, so that
 * stays on the workspace's own Users tab.
 */
const PLATFORM_ROLES = ["super_admin", "staff", "account_manager", "purchasing", "part_extractor", "finance_manager", "pricing_supervisor"] as const; // mirrors the pg enum platform_role

interface Staff { id: string; user_id: string; full_name: string; email: string; role: string; is_active: boolean; user_active: boolean }
interface GlobalUser {
  id: string; full_name: string; email: string; is_active: boolean;
  platform_role: string | null; is_vendor: boolean; is_workshop: boolean;
  memberships: Array<{ workspace: string; role: string }>;
}

export default function PlatformPeople() {
  const { me, impersonate } = useAuth();
  const isSuperAdmin = me?.platformRole === "super_admin";
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [users, setUsers] = useState<GlobalUser[] | null>(null);
  const [q, setQ] = useState("");
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ email: "", fullName: "", role: "support", password: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [s, u] = await Promise.all([
      api.get<{ staff: Staff[] }>("/admin/platform/staff"),
      api.get<{ users: GlobalUser[] }>("/admin/platform/users"),
    ]);
    setStaff(s.staff);
    setUsers(u.users);
  }, []);
  useEffect(() => { load().catch((e) => { setErr((e as Error).message); setStaff([]); setUsers([]); }); }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return users ?? [];
    return (users ?? []).filter((u) => u.full_name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));
  }, [users, q]);

  async function addStaff(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      await api.post("/admin/platform/staff", {
        email: f.email.trim(), fullName: f.fullName.trim() || undefined,
        role: f.role, password: f.password || undefined,
      });
      setF({ email: "", fullName: "", role: "support", password: "" });
      setShow(false);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function patchStaff(id: string, body: Record<string, unknown>) {
    setErr("");
    try { await api.patch(`/admin/platform/staff/${id}`, body); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}

      {/* ── platform staff ── */}
      <Card className="mb-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-ink">
              <ShieldCheck className="mr-1.5 inline h-4 w-4 text-faint" /> Platform staff
            </h3>
            <p className="mt-0.5 text-[12.5px] text-muted">Qparts' own team — these roles span every workspace.</p>
          </div>
          {isSuperAdmin && (
            <button className="btn btn-sm rounded-md" onClick={() => setShow((v) => !v)}>
              <Plus className="h-3.5 w-3.5" /> Add staff
            </button>
          )}
        </div>

        {show && isSuperAdmin && (
          <form onSubmit={addStaff} className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-5">
            <Field label="Email"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="staff@qparts.co" /></Field>
            <Field label="Full name"><input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} placeholder="Optional" /></Field>
            <Field label="Platform role">
              <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {PLATFORM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Password (optional)"><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder="min 8 — else invite" /></Field>
            <div className="flex items-end">
              <button className="btn-primary mb-3 w-full rounded-md" disabled={busy || !f.email.includes("@")}>{busy ? "Adding…" : "Grant access"}</button>
            </div>
          </form>
        )}

        {staff === null ? <Spinner /> : staff.length === 0 ? (
          <EmptyState title="No platform staff" />
        ) : (
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Platform role</th><th className="th">Status</th><th className="th" /></tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className="trow">
                  <td className="td font-medium text-ink">{s.full_name}</td>
                  <td className="td text-muted">{s.email}</td>
                  <td className="td">
                    {isSuperAdmin && s.user_id !== me?.user?.id ? (
                      <select className="input h-8 w-40 py-1" value={s.role} onChange={(e) => patchStaff(s.id, { role: e.target.value })}>
                        {PLATFORM_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <Badge tone={s.role === "super_admin" ? "blue" : "gray"}>{s.role}</Badge>
                    )}
                  </td>
                  <td className="td"><Badge tone={s.is_active ? "green" : "gray"}>{s.is_active ? "active" : "revoked"}</Badge></td>
                  <td className="td text-right">
                    {isSuperAdmin && s.user_id !== me?.user?.id && (
                      <button className={`btn btn-sm rounded-md ${s.is_active ? "text-accent" : ""}`}
                        onClick={() => patchStaff(s.id, { isActive: !s.is_active })}>
                        {s.is_active ? "Revoke access" : "Restore"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* ── global people directory ── */}
      <Card pad={false}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-5 py-3">
          <div>
            <h3 className="text-[14px] font-semibold text-ink">All people</h3>
            <p className="mt-0.5 text-[12.5px] text-muted">Every account on the platform and where it belongs. Workspace roles are edited inside each workspace.</p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
            <input className="input h-8 w-64 py-1 pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email…" />
          </div>
        </div>
        {users === null ? <Spinner /> : visible.length === 0 ? (
          <EmptyState title="No people match" />
        ) : (
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Belongs to</th><th className="th">Account</th><th className="th" /></tr></thead>
            <tbody>
              {visible.map((u) => (
                <tr key={u.id} className="trow">
                  <td className="td font-medium text-ink">{u.full_name}</td>
                  <td className="td text-muted">{u.email}</td>
                  <td className="td">
                    <div className="flex flex-wrap gap-1">
                      {u.platform_role && <Badge tone="blue">platform · {u.platform_role}</Badge>}
                      {u.memberships.map((m, i) => <Badge key={i} tone="gray">{m.workspace} · {m.role}</Badge>)}
                      {u.is_vendor && <Badge tone="amber">vendor portal</Badge>}
                      {u.is_workshop && <Badge tone="amber">workshop portal</Badge>}
                      {!u.platform_role && u.memberships.length === 0 && !u.is_vendor && !u.is_workshop && (
                        <span className="text-[12.5px] text-faint">no access</span>
                      )}
                    </div>
                  </td>
                  <td className="td"><Badge tone={u.is_active ? "green" : "gray"}>{u.is_active ? "active" : "inactive"}</Badge></td>
                  <td className="td text-right">
                    {/* every real account is reachable here — this is the directory that lists them all */}
                    {u.is_active && u.id !== me?.user?.id && !u.platform_role && (
                      <button className="btn btn-sm rounded-md" onClick={() => impersonate(u.id)}>
                        <Eye className="h-3.5 w-3.5" /> View as
                      </button>
                    )}
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
