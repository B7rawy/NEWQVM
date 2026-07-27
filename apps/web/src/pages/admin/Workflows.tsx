import { useCallback, useEffect, useState } from "react";
import { Plus, GitBranch, Building2, RotateCcw, ArrowRight } from "lucide-react";
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

interface ResetResult {
  flowId: string;
  version: number;
  statusDomain: "item" | "vendor";
  replaced: Array<{ id: string; flowKey: string; version: number }>;
  inFlightKeepingOldRules: number;
}

const TONE = { draft: "amber", active: "green", retired: "gray" } as const;
const LABEL = { draft: "Draft", active: "Active", retired: "Retired" } as const;
const DOMAIN_LABEL = { item: "Orders & requests", vendor: "Vendor invitations" } as const;

/**
 * Flow list for the active workspace + environment. Flows are per-environment on purpose (ADR-0012):
 * you draw and test one in Sandbox, then build and activate it in Live — so the environment pill in
 * the top bar changes what this page shows, and the banner below says so rather than leaving an
 * empty list looking broken.
 *
 * A workspace no longer starts from nothing: it is provisioned with the standard flow in Live, so
 * this page OPENS ON IT rather than on an empty state and a "create" button. Creating an extra flow
 * is still possible and is still one click away — it is just no longer the first thing a workspace
 * has to do before it has a workflow at all.
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
  const [confirmReset, setConfirmReset] = useState<"item" | "vendor" | null>(null);
  const [resetDone, setResetDone] = useState<ResetResult | null>(null);

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
    setConfirmReset(null);
    setResetDone(null);
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
      const r = // isDefault matters: a flow that is neither the default nor conditional fails the
      // workflow_flows_selection_complete CHECK on activation, so every flow created here was
      // permanently stuck in draft.
      await api.post<{ id: string }>("/admin/workflows", { flowKey, nameEn, nameAr, isDefault: true }, { tenant: target });
      nav(`/admin/workflows/${r.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doReset(statusDomain: "item" | "vendor") {
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<ResetResult>("/admin/workflows/reset", { statusDomain }, { tenant: target });
      setResetDone(r);
      setConfirmReset(null);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The flow each domain is actually RUNNING. status.service.ts consults the active default and
  // nothing else, so this is the one row on the page that answers "what are our rules today".
  const live = (domain: "item" | "vendor") =>
    (rows ?? []).find((f) => f.status_domain === domain && f.status === "active" && f.is_default);
  const others = (rows ?? []).filter((f) => f !== live("item") && f !== live("vendor"));

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
              <button className="btn rounded-md" onClick={() => setShow((v) => !v)}>
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
          Sandbox — workflows here are completely separate from Live, and a workspace is not given
          the standard flow here. Build and test what you like; Live keeps its own.
        </div>
      )}

      {err && <div className="mb-4 rounded-md border border-line px-4 py-2.5 text-[13px] text-accent">{err}</div>}

      {resetDone && (
        <div className="mb-4 rounded-md border border-line bg-panel px-4 py-3 text-[13px] text-ink">
          Restored the standard {DOMAIN_LABEL[resetDone.statusDomain].toLowerCase()} workflow as
          version {resetDone.version}.{" "}
          {resetDone.inFlightKeepingOldRules > 0
            ? `${resetDone.inFlightKeepingOldRules} record${resetDone.inFlightKeepingOldRules === 1 ? "" : "s"} already moving stayed on the version they started under.`
            : "Nothing was in flight, so nothing carried over."}
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
        </Card>
      )}

      {rows === null ? (
        <Card><Spinner /></Card>
      ) : (
        <>
          {/* THE WORKSPACE'S OWN WORKFLOW, one card per status domain. Both are shown even when one
              is missing, because "this workspace has no vendor workflow" is a fact worth seeing —
              vendor invitations are ungoverned until it exists. */}
          <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
            {(["item", "vendor"] as const).map((domain) => {
              const f = live(domain);
              return (
                <Card key={domain}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[11.5px] font-medium uppercase tracking-wide text-faint">
                        {DOMAIN_LABEL[domain]}
                      </div>
                      {f ? (
                        <>
                          <h3 className="mt-1 text-[15px] font-semibold text-ink">
                            <GitBranch className="ml-1.5 inline h-4 w-4 text-faint" />
                            {f.name_en}
                            <span className="mr-2 ml-2"><Badge tone={TONE[f.status]}>{LABEL[f.status]}</Badge></span>
                          </h3>
                          <p className="mt-1 text-[12.5px] text-muted">
                            Version {f.version} · {f.steps} steps · {f.transitions} moves ·{" "}
                            {f.records} record{f.records === 1 ? "" : "s"} in flight
                          </p>
                        </>
                      ) : (
                        <p className="mt-1 text-[13px] text-muted">
                          No active workflow here — these moves are not being checked against
                          anything yet.
                        </p>
                      )}
                    </div>
                  </div>

                  {f && (
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button className="btn-primary rounded-md" onClick={() => nav(`/admin/workflows/${f.id}`)}>
                        Open and edit <ArrowRight className="h-4 w-4" />
                      </button>
                      <button
                        className="btn rounded-md"
                        disabled={busy}
                        onClick={() => { setResetDone(null); setConfirmReset(domain); }}
                      >
                        <RotateCcw className="h-4 w-4" /> Reset to standard
                      </button>
                    </div>
                  )}

                  {/* THE CONFIRMATION HAS TO SAY WHAT IT WILL NOT DO. A reset that quietly re-pointed
                      live orders at a different rulebook is the exact failure the versioning exists
                      to prevent, and somebody pressing "restore the default" is not expecting to
                      change an order that is halfway through. */}
                  {confirmReset === domain && (
                    <div className="mt-4 rounded-md border border-line bg-surface px-4 py-3">
                      <h4 className="text-[13.5px] font-semibold text-ink">
                        Replace this drawing with the standard one?
                      </h4>
                      <ul className="mt-2 space-y-1 text-[12.5px] text-muted">
                        <li>
                          · It publishes a NEW VERSION and makes it live. Your current version is
                          kept, retired, exactly as it is now.
                        </li>
                        <li>
                          · Any changes you made to the drawing are not in the new version. Nothing
                          is deleted — you can still open the retired one to read it.
                        </li>
                        <li>
                          · {f && f.records > 0
                            ? `${f.records} record${f.records === 1 ? "" : "s"} already moving will keep the rules ${f.records === 1 ? "it" : "they"} started under.`
                            : "Records already moving keep the rules they started under."}{" "}
                          Only records raised from now on use the standard flow.
                        </li>
                      </ul>
                      <div className="mt-3 flex gap-2">
                        <button className="btn-primary rounded-md" disabled={busy} onClick={() => doReset(domain)}>
                          {busy ? "…" : "Yes, reset it"}
                        </button>
                        <button className="btn rounded-md" disabled={busy} onClick={() => setConfirmReset(null)}>
                          Keep mine
                        </button>
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>

          <h3 className="mb-2 text-[13px] font-semibold text-muted">Other versions and drafts</h3>
          <Card pad={false}>
            {others.length === 0 ? (
              <EmptyState
                title="Nothing else here"
                hint="Drafts you are working on, and versions this workspace has retired, appear here"
              />
            ) : (
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Workflow</th>
                    <th className="th">Applies to</th>
                    <th className="th">Version</th>
                    <th className="th">Status</th>
                    <th className="th">Steps</th>
                    <th className="th">Transitions</th>
                    <th className="th">In flight</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map((f) => (
                    <tr key={f.id} className="trow cursor-pointer" onClick={() => nav(`/admin/workflows/${f.id}`)}>
                      <td className="td font-medium text-ink">
                        <GitBranch className="ml-1.5 inline h-4 w-4 text-faint" />
                        {f.name_en}
                        {f.is_default && <Badge tone="blue">default</Badge>}
                      </td>
                      <td className="td text-muted">{DOMAIN_LABEL[f.status_domain]}</td>
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
      )}
    </>
  );
}
