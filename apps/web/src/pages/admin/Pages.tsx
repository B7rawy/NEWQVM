import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, ArrowRight, Check, GitBranch, Lock, Plus, Users, X,
} from "lucide-react";
import { api } from "../../lib/api";
import { useTargetWorkspace } from "../../lib/target-workspace";

/**
 * PAGES — the workflow, read as screens.
 *
 * The canvas asks you to think in statuses and arrows. Nobody running this business does; they think
 * in the screens their staff open. This is the same workflow document seen the other way round: a
 * list of screens, and for each one — what sits on it, who handles that work, and which screen the
 * order moves to next.
 *
 * Nothing here is a second copy of the data. Every number and every arrow is derived server-side
 * from the same steps and transitions the canvas edits, so the two views can never disagree.
 *
 * The one thing you can change here is PLACEMENT — which screen a status appears on — and it applies
 * to a live workflow immediately, without publishing a new version. That is deliberate: a status on
 * the wrong screen hides real work from the people watching that queue, and making them republish a
 * whole workflow to fix a typo would be the wrong trade. Everything that is a RULE (who may act,
 * what may follow what) stays in the workflow version and is read-only here.
 */

interface StatusOnPage {
  code: string; labelEn: string; labelAr: string;
  ownerRoles: string[]; isEntry: boolean; isTerminal: boolean; slaHours: number | null;
}
interface Exit {
  from: string; to: string; action: string | null;
  requiresApproval: boolean; allowedRoles: string[]; handoff: string;
  goesTo: string[]; staysHere: boolean;
}
interface PageRow {
  key: string; path: string; labelEn: string; labelAr: string;
  personas: string[]; wired: boolean;
  statuses: StatusOnPage[]; exits: Exit[]; owners: string[];
}
interface PageView {
  flow: { id: string; name: string; version: number; status: string } | null;
  pages: PageRow[];
  unplaced: Array<{ code: string; labelEn: string; labelAr: string }>;
  holders: Record<string, number>;
}

const PERSONA_GROUP: Record<string, string> = {
  internal: "Our team", workshop: "Workshop", vendor: "Vendor",
};

/** Routing only actually filters on the screens whose endpoint asks for it. Saying so is the point. */
const ROUTING_LIVE = new Set(["rfqs", "orders"]);

const role = (r: string) => r.replace(/_/g, " ");

function Badge({ page }: { page: PageRow }) {
  if (!page.wired)
    return <span className="text-[11px] text-faint">Not built yet</span>;
  if (!ROUTING_LIVE.has(page.key))
    return <span className="text-[11px] text-faint">Placing here has no effect yet</span>;
  return (
    <span className="flex items-center gap-1 text-[11px] text-[var(--chip-green-fg)]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--chip-green-fg)]" /> Routing is live
    </span>
  );
}

export default function Pages() {
  const { target } = useTargetWorkspace();
  const [data, setData] = useState<PageView | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!target) return setData(null);
    try {
      const d = await api.get<PageView>("/admin/workflows/page-view", { tenant: target });
      setData(d);
      setSel((s) => s ?? d.pages.find((p) => p.statuses.length)?.key ?? d.pages[0]?.key ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [target]);
  useEffect(() => { load(); }, [load]);

  const page = useMemo(() => data?.pages.find((p) => p.key === sel) ?? null, [data, sel]);

  /** Placement is the only write on this screen, and it applies to a live workflow immediately. */
  async function place(status: string, pages: string[]) {
    if (!data?.flow) return;
    setBusy(true); setErr(null);
    try {
      await api.put(`/admin/workflows/${data.flow.id}/placement`, { status, pages }, { tenant: target });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); setAdding(false); }
  }

  const pageOf = (code: string) =>
    data?.pages.filter((p) => p.statuses.some((s) => s.code === code)) ?? [];

  if (!target)
    return (
      <div className="card p-8 text-center">
        <p className="text-[14px] font-medium text-sub">Pick a workspace</p>
        <p className="mt-1 text-[12.5px] text-faint">
          Each workspace runs its own screens. Choose one from the workspace picker above.
        </p>
      </div>
    );

  if (!data) return <div className="card p-4 text-[13px] text-muted">Loading…</div>;

  if (!data.flow)
    return (
      <div className="card p-8 text-center">
        <p className="text-[14px] font-medium text-sub">This workspace has no workflow yet</p>
        <p className="mt-1 text-[12.5px] text-faint">
          Create one first, then come back here to lay it out across your screens.
        </p>
        <Link to="/admin/workflows" className="btn btn-sm mt-3 inline-flex">Go to Workflows</Link>
      </div>
    );

  const grouped = ["internal", "workshop", "vendor"].map((persona) => ({
    heading: PERSONA_GROUP[persona],
    rows: data.pages.filter((p) => p.personas.includes(persona)),
  })).filter((g) => g.rows.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[19px] font-semibold text-ink">Pages</h1>
          <p className="text-[12.5px] text-muted">
            What each screen shows, who handles it, and where an order goes from there.
          </p>
        </div>
        <div className="flex items-center gap-2.5 text-[12px] text-muted">
          <span>{data.flow.name} · v{data.flow.version} · {data.flow.status}</span>
          <Link to={`/admin/workflows/${data.flow.id}`} className="btn btn-sm">
            <GitBranch className="h-3.5 w-3.5" /> Diagram
          </Link>
        </div>
      </div>

      {err && <div className="card border-accent p-3 text-[12.5px] text-accent">{err}</div>}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* ── the screens ───────────────────────────────────────────────────── */}
        <aside className="flex flex-col gap-3">
          {grouped.map((g) => (
            <div key={g.heading} className="card overflow-hidden">
              <p className="border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {g.heading}
              </p>
              {g.rows.map((p) => (
                <button key={p.key} onClick={() => setSel(p.key)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-line px-3 py-2.5 text-left last:border-0 transition ${
                    sel === p.key ? "bg-accent-50" : "hover:bg-surface"}`}>
                  <span className="text-[13px] font-medium text-ink">{p.labelEn}</span>
                  <span className="text-[11px] text-muted">
                    {p.statuses.length} placed
                    {p.owners.length > 0 && ` · ${p.owners.length} handling it`}
                  </span>
                  <Badge page={p} />
                </button>
              ))}
            </div>
          ))}

          {/* The safety rule, made into an object. It is the most counter-intuitive behaviour in
              the system and it is invisible everywhere else. */}
          {data.unplaced.length > 0 && (
            <div className="card border-[var(--chip-amber-bg)] p-3">
              <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                <AlertTriangle className="h-4 w-4 text-[var(--chip-amber-fg)]" />
                Not placed yet — {data.unplaced.length}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
                These show up on <b>every</b> screen until you place them somewhere.
              </p>
              <div className="mt-2 flex flex-wrap gap-1">
                {data.unplaced.slice(0, 12).map((u) => (
                  <span key={u.code} className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10.5px] text-sub">
                    {u.labelEn}
                  </span>
                ))}
                {data.unplaced.length > 12 && (
                  <span className="px-1 text-[10.5px] text-faint">+{data.unplaced.length - 12}</span>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* ── the page ──────────────────────────────────────────────────────── */}
        {page && (
          <div className="flex flex-col gap-4">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-semibold text-ink">
                    {page.labelEn} <span className="text-[13px] font-normal text-muted">{page.labelAr}</span>
                  </h2>
                  <p className="mt-0.5 font-mono text-[11.5px] text-faint">{page.path}</p>
                </div>
                <Badge page={page} />
              </div>
              {!ROUTING_LIVE.has(page.key) && page.wired && (
                <p className="mt-2.5 rounded-md bg-surface px-3 py-2 text-[11.5px] leading-relaxed text-muted">
                  This screen exists, but its list does not filter by the workflow yet — anything you
                  place here will not change what it shows until that is wired up.
                </p>
              )}
            </div>

            {/* what sits here */}
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <p className="text-[13px] font-semibold text-ink">What sits on this screen</p>
                <button onClick={() => setAdding((v) => !v)} disabled={busy} className="btn btn-sm">
                  <Plus className="h-3.5 w-3.5" /> Place a status here
                </button>
              </div>

              {adding && (
                <div className="border-b border-line bg-surface p-3">
                  <p className="mb-2 text-[11.5px] text-muted">
                    Pick a status to show on {page.labelEn}. It can sit on more than one screen.
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {data.unplaced.concat(
                      data.pages.flatMap((p) => p.key === page.key ? [] : p.statuses.map((s) => ({
                        code: s.code, labelEn: s.labelEn, labelAr: s.labelAr,
                      }))),
                    )
                      .filter((s, i, a) => a.findIndex((x) => x.code === s.code) === i)
                      .filter((s) => !page.statuses.some((p) => p.code === s.code))
                      .map((s) => (
                        <button key={s.code} disabled={busy}
                          onClick={() => place(s.code, [...pageOf(s.code).map((p) => p.key), page.key])}
                          className="rounded-md border border-line bg-panel px-2 py-1 text-[11.5px] text-sub hover:border-navy hover:text-ink disabled:opacity-50">
                          {s.labelEn}
                        </button>
                      ))}
                  </div>
                </div>
              )}

              {page.statuses.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-faint">
                  Nothing is placed here, so this screen shows everything by default.
                </p>
              ) : (
                page.statuses.map((s) => (
                  <div key={s.code} className="border-b border-line px-4 py-3 last:border-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-ink">
                          {s.labelEn} <span className="text-[12px] font-normal text-muted">{s.labelAr}</span>
                          {s.isEntry && <span className="ml-2 rounded bg-[var(--chip-green-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--chip-green-fg)]">STARTS HERE</span>}
                          {s.isTerminal && <span className="ml-2 rounded bg-[var(--chip-gray-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--chip-gray-fg)]">ENDS HERE</span>}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted">
                          <Users className="h-3.5 w-3.5" />
                          {s.ownerRoles.length
                            ? <>Handled by {s.ownerRoles.map(role).join(", ")}</>
                            : <span className="text-faint">Anyone who can open this screen</span>}
                          {s.ownerRoles.some((r) => !data.holders[r]) && (
                            <span className="text-accent">· nobody holds that role</span>
                          )}
                          <Lock className="ml-1 h-3 w-3 text-faint" />
                        </p>
                      </div>
                      <button
                        onClick={() => place(s.code, pageOf(s.code).filter((p) => p.key !== page.key).map((p) => p.key))}
                        disabled={busy}
                        title="Remove from this screen"
                        className="shrink-0 rounded-md p-1 text-faint hover:bg-surface hover:text-accent disabled:opacity-50">
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    {pageOf(s.code).length > 1 && (
                      <p className="mt-1 text-[11px] text-faint">
                        Also on {pageOf(s.code).filter((p) => p.key !== page.key).map((p) => p.labelEn).join(", ")}
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* where work goes next */}
            <div className="card overflow-hidden">
              <p className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">
                What can happen next
              </p>
              {page.exits.length === 0 ? (
                <p className="px-4 py-6 text-center text-[12.5px] text-faint">
                  Nothing placed here has anywhere to go yet.
                </p>
              ) : (
                page.exits.map((e, i) => {
                  const dest = e.goesTo.length
                    ? data.pages.filter((p) => e.goesTo.includes(p.key)).map((p) => p.labelEn).join(", ")
                    : null;
                  return (
                    <div key={i} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-0">
                      <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] text-ink">
                          <b>{e.action || "Move"}</b>
                          {e.requiresApproval && (
                            <span className="ml-2 rounded bg-[var(--chip-amber-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--chip-amber-fg)]">
                              NEEDS APPROVAL
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">
                          {e.staysHere ? (
                            <>Stays on this screen, becomes <b>{e.to}</b></>
                          ) : dest ? (
                            <>Goes to <b>{dest}</b> — becomes {e.to}</>
                          ) : (
                            <>Becomes <b>{e.to}</b>, which is not placed on any screen yet, so it will
                            show everywhere</>
                          )}
                        </p>
                        <p className="mt-0.5 text-[11px] text-faint">
                          {e.allowedRoles.length
                            ? `Only ${e.allowedRoles.map(role).join(" or ")} can do this`
                            : "Anyone who can reach the order"}
                          {" · "}
                          {e.handoff === "keep" ? "same person keeps it"
                            : e.handoff === "actor" ? "whoever does it takes it on"
                            : "hands to the next desk"}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
              <p className="flex items-center gap-1.5 border-t border-line bg-surface px-4 py-2.5 text-[11px] text-faint">
                <Lock className="h-3 w-3" />
                These are rules, so they are part of the published workflow — change them in the
                <Link to={`/admin/workflows/${data.flow.id}`} className="text-navy hover:underline"> diagram</Link>.
              </p>
            </div>

            <p className="flex items-center gap-1.5 text-[11.5px] text-faint">
              <Check className="h-3.5 w-3.5" />
              Placing a status takes effect immediately — no need to publish a new version.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
