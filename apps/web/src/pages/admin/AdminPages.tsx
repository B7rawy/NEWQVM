import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, ShieldAlert } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../../components/ui";

/**
 * PAGES — who sees what, editable without a deploy.
 *
 * Two columns of the catalog are shown and only one is editable. `module` is read-only on purpose:
 * it is what ties a page to a counterparty, and it answers "does this page exist in this workspace
 * at all", which is decided by whether a workshop/vendor/provider is LINKED, not by an opinion typed
 * into this screen. Roles answer the different question of who, among the people in a workspace
 * that does have it, may open it.
 *
 * Saving is per page and immediate — no Save button collecting a formful of changes, because the
 * unit of thought here is one page's audience and a batch save invites you to lose the other edits
 * when one of them is rejected.
 */
interface Page {
  key: string;
  module: string;
  persona: string;
  path: string;
  label: string;
  group_heading: string;
  sort_order: number;
  is_built: boolean;
  parent_key: string | null;
  roles: string[];
}

const PERSONA_LABEL: Record<string, string> = {
  platform: "Platform (in a workspace)",
  platform_system: "Platform (all workspaces)",
  workspace: "Workspace",
  workshop: "Workshop",
  vendor: "Vendor",
  service_provider: "Provider",
  internal: "Internal",
};

const MODULE_TONE: Record<string, "gray" | "green" | "amber" | "red" | "blue"> = {
  core: "gray", workshop: "blue", vendor: "green", service_provider: "amber", internal: "red",
};
/** Spelled out rather than derived: "a linked internal" is not a sentence. */
const MODULE_LABEL: Record<string, string> = {
  core: "always on",
  workshop: "a linked workshop",
  vendor: "a linked vendor",
  service_provider: "a linked provider",
  internal: "a linked internal team",
};

export default function AdminPages() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [rolesByPersona, setRoles] = useState<Record<string, string[]>>({});
  const [persona, setPersona] = useState("workspace");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await api.get<{ pages: Page[]; rolesByPersona: Record<string, string[]> }>("/admin/pages");
    setPages(r.pages);
    setRoles(r.rolesByPersona);
  }, []);
  useEffect(() => { load().catch((e) => { setErr((e as Error).message); setPages([]); }); }, [load]);

  const personas = useMemo(
    () => [...new Set((pages ?? []).map((p) => p.persona))].sort((a, b) => (a === "workspace" ? -1 : b === "workspace" ? 1 : a.localeCompare(b))),
    [pages],
  );
  const visible = (pages ?? []).filter((p) => p.persona === persona);
  const roleSet = rolesByPersona[persona] ?? [];

  async function toggle(page: Page, role: string) {
    const next = page.roles.includes(role) ? page.roles.filter((r) => r !== role) : [...page.roles, role];
    setBusy(page.key); setErr("");
    // optimistic: the checkbox answers instantly and is put back if the server refuses, because a
    // grid of toggles that each wait for a round trip feels broken long before it is slow.
    setPages((all) => (all ?? []).map((p) => (p.key === page.key ? { ...p, roles: next } : p)));
    try {
      await api.post(`/admin/pages/${encodeURIComponent(page.key)}/roles`, { roles: next });
    } catch (e) {
      setErr((e as Error).message);
      setPages((all) => (all ?? []).map((p) => (p.key === page.key ? { ...p, roles: page.roles } : p)));
    } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader
        title="Pages"
        subtitle="Which pages exist, what switches them on, and who may open them"
      />

      <Card className="mb-4">
        <div className="flex gap-2.5 text-[12.5px] leading-relaxed text-sub">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
          <div>
            <p>
              A page whose module is <b className="font-medium text-ink">not core</b> only exists in a
              workspace that has an active link of that kind — link a workshop and its pages appear,
              unlink it and they go. That is not editable here; it follows the links themselves.
            </p>
            <p className="mt-1">
              Roles below decide who may open a page in a workspace that has it. Workspace managers
              see every page of their workspace and a workshop's manager sees every workshop page,
              whatever is ticked — so clearing every box hides a page from everyone{" "}
              <b className="font-medium text-ink">except</b> those managers.
            </p>
          </div>
        </div>
      </Card>

      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}

      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {personas.map((p) => (
          <button key={p} onClick={() => setPersona(p)}
            className={`btn btn-sm rounded-md ${persona === p ? "btn-primary" : ""}`}>
            {PERSONA_LABEL[p] ?? p}{" "}
            <span className="tnum text-faint">{(pages ?? []).filter((x) => x.persona === p).length}</span>
          </button>
        ))}
      </div>

      <Card pad={false}>
        {pages === null ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <EmptyState title="No pages" hint="Nothing is registered for this portal." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className="th">Page</th>
                  <th className="th">Switched on by</th>
                  {roleSet.map((r) => <th key={r} className="th whitespace-nowrap text-center">{r}</th>)}
                </tr>
              </thead>
              <tbody>
                {visible.map((p, i) => {
                  const newGroup = i === 0 || visible[i - 1].group_heading !== p.group_heading;
                  return (
                    <tr key={p.key} className={`trow ${newGroup ? "border-t-2 border-line" : ""}`}>
                      <td className="td">
                        {newGroup && (
                          <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">
                            {p.group_heading}
                          </div>
                        )}
                        <div className={`font-medium text-ink ${p.parent_key ? "ms-4" : ""}`}>
                          {/* Children are shown indented under their parent, the same shape the
                              sidebar renders — this table is meant to be the map of the menu, and a
                              flat list would misdescribe it. */}
                          {p.parent_key && <span className="me-1 text-faint">└</span>}
                          {p.label} {!p.is_built && <span className="ms-1 text-[10.5px] font-medium text-faint">Soon</span>}
                        </div>
                        <div className={`font-mono text-[11.5px] text-faint ${p.parent_key ? "ms-4" : ""}`}>{p.path}</div>
                      </td>
                      <td className="td">
                        <Badge tone={MODULE_TONE[p.module] ?? "gray"}>
                          {MODULE_LABEL[p.module] ?? p.module}
                        </Badge>
                      </td>
                      {roleSet.map((r) => {
                        const on = p.roles.includes(r);
                        return (
                          <td key={r} className="td text-center">
                            <button
                              onClick={() => toggle(p, r)}
                              disabled={busy === p.key}
                              aria-label={`${on ? "Hide from" : "Show to"} ${r}`}
                              aria-pressed={on}
                              className={`inline-flex h-5 w-5 items-center justify-center rounded border transition ${
                                on ? "border-accent bg-accent text-white" : "border-line bg-surface text-transparent hover:border-accent"
                              }`}>
                              {busy === p.key ? <Loader2 className="h-3 w-3 animate-spin text-faint" /> : <Check className="h-3.5 w-3.5" />}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
