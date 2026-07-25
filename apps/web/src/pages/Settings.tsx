import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, Field, EmptyState } from "../components/ui";

export default function Settings() {
  const { workspaces, activeSlug, me, environment } = useAuth();
  const ws = workspaces.find((w) => w.slug === activeSlug);
  const [name, setName] = useState(ws?.name ?? "");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  if (!ws) return <EmptyState title="No active workspace" />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg("");
    setErr("");
    setBusy(true);
    try {
      await api.patch(`/admin/workspaces/${ws!.id}`, { name });
      setMsg("Saved. Refresh to see the new name in the switcher.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Settings" subtitle="Workspace configuration" />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <h3 className="mb-4 text-[14px] font-semibold text-ink">Workspace</h3>
          <form onSubmit={save}>
            <Field label="Name">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!me?.isInternal} />
            </Field>
            <Field label="Subdomain">
              <div className="flex items-center gap-2">
                <input className="input" value={ws.slug} disabled />
                <span className="whitespace-nowrap text-[13px] text-muted">.easycarty.store</span>
              </div>
              <p className="mt-1 text-[11px] text-faint">
                Locally we resolve the workspace via the switcher (X-Tenant header). In production each
                workspace is served at its subdomain.
              </p>
            </Field>
            {me?.isInternal && (
              <button className="btn-primary rounded-md" disabled={busy || !name}>
                {busy ? "Saving…" : "Save changes"}
              </button>
            )}
            {msg && <div className="mt-2 text-[13px] text-emerald-600">{msg}</div>}
            {err && <div className="mt-2 text-[13px] text-accent">{err}</div>}
          </form>
        </Card>
        <Card>
          <h3 className="mb-4 text-[14px] font-semibold text-ink">Details</h3>
          <dl className="space-y-3 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted">Environment</dt>
              <dd>
                {environment === "sandbox" ? (
                  <Badge tone="amber">sandbox — test data</Badge>
                ) : (
                  <Badge tone="green">live</Badge>
                )}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Your role</dt>
              <dd className="text-ink">{me?.isInternal ? "Platform staff" : me?.role ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Workspace ID</dt>
              <dd className="tnum text-faint">{ws.id.slice(0, 8)}…</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
