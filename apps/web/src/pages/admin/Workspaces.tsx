import { useEffect, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState, Field } from "../../components/ui";

interface Ws {
  id: string;
  slug: string;
  name: string;
  is_sandbox: boolean;
  is_active: boolean;
  branches: number;
  vendors: number;
  users: number;
}

export default function Workspaces() {
  const nav = useNavigate();
  const [rows, setRows] = useState<Ws[] | null>(null);
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [sandbox, setSandbox] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get<{ workspaces: Ws[] }>("/admin/workspaces");
    setRows(r.workspaces);
  }, []);
  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/admin/workspaces", { name, slug, isSandbox: sandbox });
      setName("");
      setSlug("");
      setSandbox(false);
      setShow(false);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Every client workspace on the platform"
        actions={
          <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
            <Plus className="h-4 w-4" /> New workspace
          </button>
        }
      />
      {show && (
        <Card className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Qparts Dammam" />
            </Field>
            <Field label="Subdomain (slug)">
              <input
                className="input"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="dammam"
              />
              <p className="mt-1 text-[11px] text-faint">{slug || "slug"}.qparts.app</p>
            </Field>
            <div className="flex items-end gap-3">
              <label className="mb-2 flex items-center gap-2 text-[13px] text-sub">
                <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
                Sandbox
              </label>
              <button className="btn-primary mb-0.5 rounded-md" disabled={busy || !name || !slug}>
                {busy ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
          {err && <div className="mt-1 text-[13px] text-accent">{err}</div>}
        </Card>
      )}

      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No workspaces" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Subdomain</th>
                <th className="th">Branches</th>
                <th className="th">Vendors</th>
                <th className="th">Users</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.id} className="trow cursor-pointer" onClick={() => nav(`/admin/workspaces/${w.id}`)}>
                  <td className="td font-medium text-ink">
                    {w.name} {w.is_sandbox && <Badge tone="amber">sandbox</Badge>}
                  </td>
                  <td className="td tnum text-muted">{w.slug}</td>
                  <td className="td tnum">{w.branches}</td>
                  <td className="td tnum">{w.vendors}</td>
                  <td className="td tnum">{w.users}</td>
                  <td className="td">
                    <Badge tone={w.is_active ? "green" : "gray"}>{w.is_active ? "active" : "inactive"}</Badge>
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
