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
  /** Ties between two flows that both match. Higher goes first; see selection_summary. */
  selection_priority: number;
  /**
   * WHICH RECORDS THIS FLOW TAKES, as a sentence, rendered by the server (describeSelection).
   *
   * Not derived here on purpose. `selection_condition` has three states — null, {}, and a real
   * condition — and two of them look nearly identical in JSON while meaning opposite things ("never
   * chosen" vs "chosen for everything"). One renderer, next to the evaluator that acts on it, is the
   * only way this screen and the engine cannot drift apart.
   */
  selection_summary: string;
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
      // WHETHER THIS ONE IS THE FALLBACK DEPENDS ON WHETHER THE WORKSPACE ALREADY HAS ONE, and it
      // has to be decided here because nothing can change it later: `is_default` is set at creation
      // and no endpoint updates it.
      //
      // Sending `true` unconditionally — which this did — was right when a workspace had at most one
      // flow, and became a trap the moment provisioning gave every workspace a default: the second
      // flow was born claiming a slot that was taken, and activation could only ever refuse it.
      // Sending `false` when a fallback exists produces the flow the owner is actually asking for
      // when they press "New workflow" beside an existing one — an alternative, chosen by a
      // condition, running next to the fallback rather than replacing it.
      const r = await api.post<{ id: string }>(
        "/admin/workflows",
        { flowKey, nameEn, nameAr, isDefault: !live("item") },
        { tenant: target },
      );
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

  // THE FALLBACK of each domain — the flow a record joins when no other flow's condition matched
  // it. Every workspace has one, and until somebody draws a second flow it is the only flow there
  // is, so it stays the headline of this screen.
  const live = (domain: "item" | "vendor") =>
    (rows ?? []).find((f) => f.status_domain === domain && f.status === "active" && f.is_default);
  // The alternatives running BESIDE it — an insurance flow next to a cash flow. The server returns
  // flows in the engine's own selection order (selection_priority desc, then oldest), so listing
  // them in the order received is not a presentation choice: it is the order they are tried in, and
  // the first one that matches takes the record.
  const alsoLive = (domain: "item" | "vendor") =>
    (rows ?? []).filter((f) => f.status_domain === domain && f.status === "active" && !f.is_default);
  const onCard = new Set(
    (["item", "vendor"] as const).flatMap((d) => [live(d), ...alsoLive(d)]).filter(Boolean).map((f) => f!.id),
  );
  const others = (rows ?? []).filter((f) => !onCard.has(f.id));

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
          {/* SAY WHAT KIND OF FLOW THIS WILL BE BEFORE IT IS MADE. A workspace's second flow is an
              ALTERNATIVE, not a replacement, and it needs a condition of its own before it can go
              live — which is a refusal at activation if nobody says so here. `is_default` is fixed
              at creation, so this is also the last moment the answer can change. */}
          {live("item") && (
            <p className="mt-3 text-[12px] text-muted">
              {live("item")!.name_en} stays the fallback for orders &amp; requests. This flow runs
              beside it and needs a condition saying which records it takes, or it cannot be
              activated.
            </p>
          )}
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
              const alts = alsoLive(domain);
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
                          {/* "ON IT RIGHT NOW", not "in flight" — 0066 changed what this number
                              counts. It is a count of workflow_record_state rows pointing at this
                              flow, and a record that crosses into a sub-flow stops pointing here
                              until it comes back. So "in flight" now overstates: an order away in
                              the insurance flow is very much in flight and is not in this number. */}
                          <p className="mt-1 text-[12.5px] text-muted">
                            Version {f.version} · {f.steps} steps · {f.transitions} moves ·{" "}
                            {f.records} record{f.records === 1 ? "" : "s"} on it right now
                          </p>
                          {/* WHICH RECORDS THIS ONE TAKES. Worth saying even when it is the only
                              flow, because it is the sentence that stops making sense the moment a
                              second one is drawn — and this is the screen where that happens. */}
                          <p className="mt-1 text-[12.5px] text-muted">
                            Takes {f.selection_summary}
                            {alts.length > 0 && " — it is the fallback"}
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

                  {/* THE OTHER FLOWS LIVE IN THIS DOMAIN, in the order the engine tries them.
                      A record is matched against these first, top to bottom, and the first one whose
                      sentence is true takes it; anything left over goes to the flow above. Showing
                      them in any other order would describe a rulebook the engine does not run. */}
                  {alts.length > 0 && (
                    <div className="mt-4 rounded-md border border-line bg-surface px-4 py-3">
                      <h4 className="text-[12.5px] font-semibold text-ink">
                        Checked before the fallback, in this order
                      </h4>
                      <ol className="mt-2 space-y-1.5">
                        {alts.map((a, i) => (
                          <li key={a.id} className="text-[12.5px] text-muted">
                            <button
                              className="font-medium text-ink underline-offset-2 hover:underline"
                              onClick={() => nav(`/admin/workflows/${a.id}`)}
                            >
                              {i + 1}. {a.name_en}
                            </button>{" "}
                            — takes {a.selection_summary}
                            {a.records > 0 && ` · ${a.records} in flight`}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

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
                          {/* Says "on it right now" rather than "already moving" because since
                              0066 those are different sets: records away in a sub-flow are moving
                              and are not counted here. They keep their rules too — the sentence
                              after this one is the claim that matters, and it is true of both. */}
                          · {f && f.records > 0
                            ? `${f.records} record${f.records === 1 ? "" : "s"} on it right now will keep the rules ${f.records === 1 ? "it" : "they"} started under.`
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
                    <th className="th">Takes</th>
                    <th className="th">Version</th>
                    <th className="th">Status</th>
                    <th className="th">Steps</th>
                    <th className="th">Transitions</th>
                    {/* See the summary line above: this counts records bound to the flow AT THIS
                        MOMENT, which since 0066 excludes the ones away in a sub-flow. */}
                    <th className="th">On it now</th>
                  </tr>
                </thead>
                <tbody>
                  {others.map((f) => (
                    <tr key={f.id} className="trow cursor-pointer" onClick={() => nav(`/admin/workflows/${f.id}`)}>
                      <td className="td font-medium text-ink">
                        <GitBranch className="ml-1.5 inline h-4 w-4 text-faint" />
                        {f.name_en}
                        {/* Only a LIVE default is the fallback. Rows retired before the flag was
                            cleared on retirement still carry it, and badging a version nothing has
                            executed for months as the workspace's fallback is a false claim about
                            the running system. */}
                        {f.is_default && f.status === "active" && <Badge tone="blue">fallback</Badge>}
                      </td>
                      <td className="td text-muted">{DOMAIN_LABEL[f.status_domain]}</td>
                      {/* The routing a draft WOULD have. "nothing — no routing set" is the reason a
                          draft cannot be activated, so it belongs where somebody is looking for it,
                          not only in the error message they get when they press the button. */}
                      <td className="td text-muted">{f.selection_summary}</td>
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
