import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../lib/api";
import { Card, Badge, Spinner } from "./ui";

/**
 * Link an EXISTING directory identity to a workspace. The directory is global master data, so a
 * workspace relationship is a LINK — never a duplicate identity. Only entities not already linked
 * are offered.
 */
interface Candidate {
  id: string; name: string; counterparty_type: "individual" | "company";
  tax_number: string | null; primary_phone: string | null;
}

export default function LinkCounterpartyDialog({
  workspaceId, kind, onClose,
}: {
  workspaceId: string;
  kind: "vendor" | "workshop";
  onClose: (linked: boolean) => void;
}) {
  const [rows, setRows] = useState<Candidate[] | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [linked, setLinked] = useState(false);

  useEffect(() => {
    api.get<{ candidates: Candidate[] }>(`/admin/workspaces/${workspaceId}/linkable/${kind}`)
      .then((r) => setRows(r.candidates))
      .catch((e) => { setErr((e as Error).message); setRows([]); });
  }, [workspaceId, kind]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows ?? [];
    return (rows ?? []).filter((c) =>
      c.name.toLowerCase().includes(needle) ||
      (c.tax_number ?? "").toLowerCase().includes(needle) ||
      (c.primary_phone ?? "").toLowerCase().includes(needle));
  }, [rows, q]);

  async function link(c: Candidate) {
    setErr(""); setBusy(c.id);
    try {
      await api.post(`/admin/workspaces/${workspaceId}/link/${kind}/${c.id}`, {});
      setRows((prev) => (prev ?? []).filter((x) => x.id !== c.id));
      setLinked(true);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">Link an existing {kind}</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            The directory is shared — linking connects this workspace to an identity that already exists, instead of creating a duplicate.
          </p>
        </div>
        <button className="btn btn-sm rounded-md" onClick={() => onClose(linked)}>Close</button>
      </div>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
        <input className="input h-8 w-72 py-1 pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, tax number, mobile…" />
      </div>
      {rows === null ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          {rows.length === 0 ? `Every ${kind} in the directory is already linked to this workspace.` : "No match."}
        </p>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full">
            <thead><tr><th className="th">Name</th><th className="th">Type</th><th className="th">Identifier</th><th className="th" /></tr></thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="trow">
                  <td className="td font-medium text-ink">{c.name}</td>
                  <td className="td"><Badge tone={c.counterparty_type === "company" ? "gray" : "amber"}>{c.counterparty_type}</Badge></td>
                  <td className="td tnum text-muted">{c.tax_number ?? c.primary_phone ?? "—"}</td>
                  <td className="td text-right">
                    <button className="btn btn-sm rounded-md" disabled={busy === c.id} onClick={() => link(c)}>
                      {busy === c.id ? "Linking…" : "Link"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {err && <div className="mt-2 text-[13px] text-accent">{err}</div>}
    </Card>
  );
}
