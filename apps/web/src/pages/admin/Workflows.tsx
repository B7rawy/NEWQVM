import { useCallback, useEffect, useState } from "react";
import { Plus, GitBranch, Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useTargetWorkspace } from "../../lib/target-workspace";
import { PageHeader, Card, Badge, Spinner, EmptyState, Field } from "../../components/ui";

interface Flow {
  id: string;
  flow_key: string;
  version: number;
  name_en: string;
  name_ar: string;
  status: "draft" | "active" | "retired";
  is_default: boolean;
  status_domain: "item" | "vendor";
  selection_condition: Record<string, unknown> | null;
  steps: number;
  transitions: number;
  records: number;
}

const TONE = { draft: "amber", active: "green", retired: "gray" } as const;
const LABEL = { draft: "Draft", active: "Active", retired: "Retired" } as const;

/**
 * Flow list for the active workspace + environment. Flows are per-environment on purpose (ADR-0012):
 * you draw and test one in Sandbox, then build and activate it in Live — so the environment pill in
 * the top bar changes what this page shows, and the banner below says so rather than leaving an
 * empty list looking broken.
 */
export default function Workflows() {
  const nav = useNavigate();
  const { environment, workspaces } = useAuth();
  // TARGET, not the app's active workspace: an admin configures several workspaces from
  // here without being thrown into each one (and losing this sidebar) to do it.
  const { target, choose } = useTargetWorkspace();
  const [rows, setRows] = useState<Flow[] | null>(null);
  const [show, setShow] = useState(false);
  const [nameAr, setNameAr] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [flowKey, setFlowKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get<{ flows: Flow[] }>("/admin/workflows", { tenant: target });
    setRows(r.flows);
  }, [target]);
  useEffect(() => {
    // A flow belongs to ONE workspace, so there is nothing to fetch in the platform-wide
    // "Admin workspace" view. Returning early keeps the server's English 400 off the screen —
    // the picker below is the answer, not an error message.
    if (!target) {
      setRows([]);
      return;
    }
    setRows(null);
    setErr("");
    load().catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, [load, target]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/admin/workflows", { flowKey, nameEn, nameAr }, { tenant: target });
      nav(`/admin/workflows/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="The steps every order moves through — and who must approve each one"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] text-muted">Building for</span>
            <select
              className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-[13px] font-medium text-ink"
              value={target ?? ""}
              onChange={(e) => choose(e.target.value || null)}
            >
              <option value="">Select a workspace…</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.slug}>{w.name}</option>
              ))}
            </select>
            {target && (
              <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
                <Plus className="h-4 w-4" /> New workflow
              </button>
            )}
          </div>
        }
      />

      {!target ? (
        <Card>
          <div className="mx-auto flex max-w-lg flex-col items-center gap-3 py-10 text-center">
            <Building2 className="h-8 w-8 text-faint" />
            <h3 className="text-[15px] font-semibold text-ink">Pick a workspace</h3>
            <p className="text-[13px] text-muted">
              Each workspace runs its own workflows — Deraya may work in different steps than
              Al-Amir. Choose one above and you stay right here in the admin panel.
            </p>
          </div>
        </Card>
      ) : (
      <>
      {environment === "sandbox" && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-[#5a4300]">
          Sandbox — workflows here are completely separate from Live. Build and test here, then
          recreate it in Live once you are happy with it.
        </div>
      )}

      {show && (
        <Card className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Name (Arabic)">
              <input className="input" value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="المسار العادي" />
            </Field>
            <Field label="Name (English)">
              <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="Standard flow" />
            </Field>
            <Field label="Key">
              <input
                className="input"
                value={flowKey}
                onChange={(e) => setFlowKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                placeholder="standard"
                dir="ltr"
              />
              <p className="mt-1 text-[11px] text-faint">Stays the same across versions</p>
            </Field>
            <div className="flex items-end">
              <button className="btn-primary mb-0.5 rounded-md" disabled={busy || !nameAr || !nameEn || !flowKey}>
                {busy ? "…" : "Create draft"}
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
          <EmptyState title="No workflows yet" hint="Create a draft, draw it, then activate it" />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Workflow</th>
                <th className="th">Version</th>
                <th className="th">Status</th>
                <th className="th">Steps</th>
                <th className="th">Transitions</th>
                <th className="th">In flight</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="trow cursor-pointer" onClick={() => nav(`/admin/workflows/${f.id}`)}>
                  <td className="td font-medium text-ink">
                    <GitBranch className="ml-1.5 inline h-4 w-4 text-faint" />
                    {f.name_en}
                    {f.is_default && <Badge tone="blue">default</Badge>}
                  </td>
                  <td className="td tnum text-muted">v{f.version}</td>
                  <td className="td">
                    <Badge tone={TONE[f.status]}>{LABEL[f.status]}</Badge>
                  </td>
                  <td className="td tnum">{f.steps}</td>
                  <td className="td tnum">{f.transitions}</td>
                  <td className="td tnum">{f.records}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      </>
      )}
    </>
  );
}
