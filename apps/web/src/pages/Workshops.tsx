import { useEffect, useState, useCallback, useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, KeyRound, ChevronRight, ChevronDown, Search, Building2, Eye } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";
import CreateAccountDialog from "../components/CreateAccountDialog";
import AddWorkshopWizard from "../components/AddWorkshopWizard";

/**
 * Workshops directory (QNEW-71). A workshop is a GLOBAL counterparty — an external CUSTOMER — not an
 * internal unit of the workspace (ticket Conflict B). One row per workshop showing everything that
 * decides whether it can actually transact: identity + identifier, branches, linked workspaces,
 * activation, and portal access. Branches live INSIDE their workshop row (expandable) instead of a
 * disconnected second table, and creating a workshop is a guided flow, not a permanent form.
 */
interface Workshop {
  id: string;
  name: string;
  counterparty_type: "individual" | "company";
  activation_status: string;
  tax_number: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  branches: number;
  workspaces: number;
  has_account: boolean;
  user_id: string | null;
}
interface Branch {
  id: string;
  workshop_id: string;
  name: string;
  workshop: string;
  region: string | null;
  order_category: string;
}
interface Region { id: string; name: string }
interface Ws { id: string; name: string }
type Filter = "all" | "pending" | "no_account" | "no_branch";

export default function Workshops() {
  const nav = useNavigate();
  const { activeSlug, me, impersonate } = useAuth();
  const isPlatform = me?.persona === "platform"; // only platform staff write the global workshop directory
  const canRequest = me?.role === "company_admin"; // a workspace onboards via the submission flow
  const [workshops, setWorkshops] = useState<Workshop[] | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [workspaces, setWorkspaces] = useState<Ws[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null); // expanded workshop row
  const [wizard, setWizard] = useState(false);
  const [acct, setAcct] = useState<{ id: string; name: string } | null>(null);
  const [branchFor, setBranchFor] = useState<string | null>(null); // inline add-branch target
  const [bName, setBName] = useState("");
  const [bRegion, setBRegion] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [w, b, r] = await Promise.all([
      api.get<{ workshops: Workshop[] }>("/org/workshops"),
      api.get<{ branches: Branch[] }>("/org/branches"),
      api.get<{ regions: Region[] }>("/org/regions"),
    ]);
    setWorkshops(w.workshops);
    setBranches(b.branches);
    setRegions(r.regions);
  }, []);
  useEffect(() => {
    if (isPlatform) api.get<{ workspaces: Ws[] }>("/admin/workspaces").then((r) => setWorkspaces(r.workspaces)).catch(() => {});
  }, [isPlatform]);
  useEffect(() => {
    setWorkshops(null);
    load().catch((e) => { setErr((e as Error).message); setWorkshops([]); });
  }, [activeSlug, load]);

  const stats = useMemo(() => ({
    total: workshops?.length ?? 0,
    pending: workshops?.filter((w) => w.activation_status === "pending").length ?? 0,
    noAccount: workshops?.filter((w) => !w.has_account).length ?? 0,
    noBranch: workshops?.filter((w) => w.branches === 0).length ?? 0,
    branches: branches.length,
  }), [workshops, branches]);

  const visible = useMemo(() => {
    let rows = workshops ?? [];
    if (filter === "pending") rows = rows.filter((w) => w.activation_status === "pending");
    if (filter === "no_account") rows = rows.filter((w) => !w.has_account);
    if (filter === "no_branch") rows = rows.filter((w) => w.branches === 0);
    const needle = q.trim().toLowerCase();
    if (needle) rows = rows.filter((w) =>
      w.name.toLowerCase().includes(needle) ||
      (w.tax_number ?? "").toLowerCase().includes(needle) ||
      (w.primary_phone ?? "").toLowerCase().includes(needle));
    // least-ready first so the page opens on what still needs work
    const score = (w: Workshop) => (w.branches > 0 ? 1 : 0) + (w.has_account ? 1 : 0);
    return [...rows].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  }, [workshops, filter, q]);

  async function addBranch(e: React.FormEvent, workshopId: string) {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/org/branches", { workshopId, name: bName.trim(), regionId: bRegion || undefined });
      setBName(""); setBRegion(""); setBranchFor(null);
      await load();
    } catch (e) { setErr((e as Error).message); }
  }

  return (
    <>
      <PageHeader
        title="Workshops"
        subtitle={isPlatform && !activeSlug ? "Global directory of workshop customers — one identity, shared by every workspace" : `Workshop customers linked to ${activeSlug ?? "this workspace"}`}
        actions={
          isPlatform ? (
            <button className="btn-primary rounded-md" onClick={() => setWizard(true)}>
              <Plus className="h-4 w-4" /> Add workshop
            </button>
          ) : canRequest ? (
            <Link to="/onboarding" className="btn-primary rounded-md">
              <Plus className="h-4 w-4" /> Request a workshop
            </Link>
          ) : undefined
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}

      {/* the stat strip IS the filter bar — each card selects its slice (no second chip row) */}
      <div className="mb-5 grid grid-cols-2 divide-x divide-line-2 overflow-hidden rounded-xl2 border border-line bg-panel shadow-card md:grid-cols-4">
        {([
          { key: "all" as Filter, label: "Workshops", value: stats.total, hint: "all customers" },
          { key: "pending" as Filter, label: "Pending activation", value: stats.pending, hint: "awaiting activation" },
          { key: "no_account" as Filter, label: "No portal access", value: stats.noAccount, hint: "cannot sign in yet" },
          { key: "no_branch" as Filter, label: "No branch", value: stats.noBranch, hint: "cannot be ordered for" },
        ]).map((c) => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            className={`px-5 py-4 text-left transition hover:bg-surface ${filter === c.key ? "bg-surface" : ""}`}>
            <div className="text-[12px] font-medium uppercase tracking-wide text-faint">{c.label}</div>
            <div className={`mt-1 text-[22px] font-semibold tnum ${c.value && c.key !== "all" ? "text-accent" : "text-ink"}`}>{c.value}</div>
            <div className="text-[11.5px] text-faint">{c.hint}</div>
          </button>
        ))}
      </div>

      {acct && <CreateAccountDialog kind="workshop" entityId={acct.id} entityName={acct.name} onClose={(created) => { setAcct(null); if (created) load(); }} />}
      {wizard && <AddWorkshopWizard regions={regions} workspaces={workspaces} activeSlug={activeSlug} onClose={(created) => { setWizard(false); if (created) load(); }} />}

      {/* toolbar: search + filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input className="input h-8 w-64 py-1 pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, tax number, mobile…" />
        </div>
        {filter !== "all" && (
          <button className="btn btn-sm rounded-md" onClick={() => setFilter("all")}>Clear filter</button>
        )}
        <span className="text-[12.5px] text-faint">{visible.length} shown</span>
      </div>

      <Card pad={false}>
        {workshops === null ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" />}
            title={workshops.length === 0 ? "No workshops yet" : "No workshops match"}
            hint={workshops.length === 0 ? (isPlatform ? "Add your first workshop customer." : "No workshops linked to this workspace.") : "Try a different search or filter."}
          />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th w-8" />
                <th className="th">Workshop</th>
                <th className="th">Identifier</th>
                <th className="th">Branches</th>
                {isPlatform && <th className="th">Workspaces</th>}
                <th className="th">Status</th>
                <th className="th">Readiness</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {visible.map((w) => {
                const mine = branches.filter((b) => b.workshop_id === w.id);
                const isOpen = open === w.id;
                return [
                  <tr key={w.id} className="trow cursor-pointer" onClick={() => setOpen(isOpen ? null : w.id)}>
                    <td className="td text-faint">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <button className="font-medium text-ink hover:text-accent hover:underline"
                          onClick={(e) => { e.stopPropagation(); nav(`/org/workshops/${w.id}`); }}>{w.name}</button>
                        <Badge tone={w.counterparty_type === "company" ? "gray" : "amber"}>{w.counterparty_type}</Badge>
                      </div>
                    </td>
                    <td className="td tnum text-muted">
                      {w.tax_number ? <><span className="text-faint">tax</span> {w.tax_number}</>
                        : w.primary_phone ? <><span className="text-faint">mob</span> {w.primary_phone}</>
                        : <span className="text-accent">no identifier</span>}
                    </td>
                    <td className="td tnum">{w.branches || <span className="text-accent">0</span>}</td>
                    {isPlatform && <td className="td tnum text-muted">{w.workspaces}</td>}
                    <td className="td">
                      <Badge tone={statusTone(w.activation_status)}>{w.activation_status}</Badge>
                    </td>
                    {/* readiness: what still blocks this workshop from transacting */}
                    <td className="td">
                      {w.branches > 0 && w.has_account ? (
                        <Badge tone="green">ready</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {w.branches === 0 && <Badge tone="amber">needs branch</Badge>}
                          {!w.has_account && <Badge tone="gray">needs user</Badge>}
                        </div>
                      )}
                    </td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        {isPlatform && !w.has_account && (
                          <button className="btn btn-sm rounded-md" onClick={() => setAcct({ id: w.id, name: w.name })}>
                            <KeyRound className="h-3.5 w-3.5" /> Add user
                          </button>
                        )}
                        {isPlatform && w.user_id && (
                          <button className="btn btn-sm rounded-md" onClick={() => impersonate(w.user_id!)}>
                            <Eye className="h-3.5 w-3.5" /> View as
                          </button>
                        )}
                        <button className="btn btn-sm rounded-md" onClick={() => nav(`/org/workshops/${w.id}`)}>Open</button>
                      </div>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={`${w.id}-x`} className="bg-surface/40">
                      <td className="td" />
                      <td className="td" colSpan={isPlatform ? 7 : 6}>
                        <div className="py-1">
                          <div className="mb-2 text-[12.5px] font-semibold text-ink">Branches</div>
                          {mine.length === 0 ? (
                            <p className="mb-2 text-[12.5px] text-muted">No branches yet — a request must be raised for a branch, so add one.</p>
                          ) : (
                            <div className="mb-2 flex flex-col gap-1">
                              {mine.map((b) => (
                                <div key={b.id} className="flex items-center gap-3 text-[13px]">
                                  <span className="font-medium text-ink">{b.name}</span>
                                  <span className="text-muted">{b.region ?? "—"}</span>
                                  <Badge tone="gray">{b.order_category}</Badge>
                                </div>
                              ))}
                            </div>
                          )}
                          {isPlatform && (branchFor === w.id ? (
                            <form onSubmit={(e) => addBranch(e, w.id)} className="flex flex-wrap items-end gap-2">
                              <Field label="Branch name">
                                <input className="input h-8 w-48 py-1" value={bName} onChange={(e) => setBName(e.target.value)} placeholder="North branch" />
                              </Field>
                              <Field label="Region">
                                <select className="input h-8 w-40 py-1" value={bRegion} onChange={(e) => setBRegion(e.target.value)}>
                                  <option value="">—</option>
                                  {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                              </Field>
                              <button className="btn-primary mb-3 rounded-md" disabled={!bName.trim()}>Add</button>
                              <button type="button" className="btn btn-sm mb-3 rounded-md" onClick={() => setBranchFor(null)}>Cancel</button>
                            </form>
                          ) : (
                            <button className="btn btn-sm rounded-md" onClick={() => { setBranchFor(w.id); setBName(""); setBRegion(""); }}>
                              <Plus className="h-3.5 w-3.5" /> Add branch
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
