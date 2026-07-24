import { useState } from "react";
import { Upload, Download } from "lucide-react";
import { api } from "../lib/api";
import { readSheet, pick } from "../lib/sheet";
import { Card, Badge, Spinner } from "./ui";

/**
 * Bulk portal-account provisioning from a sheet. The browser parses the .xlsx/.csv and posts plain
 * rows; the server creates/links each one INDEPENDENTLY and reports per-row status, so one bad row
 * never sinks the batch. Password is optional per row — leave it empty to send an invite.
 */
interface Row { email: string; fullName?: string; phone?: string; password?: string }
interface Result { total: number; tally: Record<string, number>; results: Array<{ email: string; status: string; message?: string }> }

export default function BulkAccountsDialog({
  kind, entityId, entityName, onClose,
}: {
  kind: "vendor" | "workshop" | "service_provider";
  entityId: string;
  entityName: string;
  onClose: (imported: boolean) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(""); setResult(null); setRows(null); setFilename(file.name);
    try {
      const objs = await readSheet(file);
      const parsed = objs
        .map((o) => ({
          email: pick(o, "email", "e-mail", "الايميل", "البريد"),
          fullName: pick(o, "full name", "name", "الاسم") || undefined,
          phone: pick(o, "phone", "mobile", "الجوال", "الهاتف") || undefined,
          password: pick(o, "password", "كلمة المرور") || undefined,
        }))
        .filter((r) => r.email);
      if (parsed.length === 0) setErr("No rows with an Email column were found. The first row must be headers (Email, Full name, Phone, Password).");
      setRows(parsed);
    } catch {
      setErr("Could not read the file. Use a .xlsx or .csv with a header row.");
    }
  }

  function template() {
    const csv = "Email,Full name,Phone,Password\nowner@example.com,Owner Name,0551234567,\nstaff@example.com,Staff Name,,secret12345\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${kind}-accounts-template.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  async function doImport() {
    if (!rows?.length) return;
    setErr(""); setBusy(true);
    try {
      setResult(await api.post<Result>(`/counterparty/${kind}/${entityId}/accounts/bulk`, { rows }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const tone = (s: string) => (s === "error" ? "amber" : s === "skipped" ? "gray" : "green");

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">Import users for “{entityName}”</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Upload an .xlsx/.csv with a header row: <span className="tnum">Email, Full name, Phone, Password</span>. Leave Password empty to send an invite.
          </p>
        </div>
        <button className="btn btn-sm rounded-md" onClick={() => onClose(!!result)}>Close</button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="btn btn-sm cursor-pointer rounded-md">
          <Upload className="h-3.5 w-3.5" /> {filename || "Choose .xlsx / .csv…"}
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
        </label>
        <button className="btn btn-sm rounded-md" onClick={template}><Download className="h-3.5 w-3.5" /> Template</button>
        {rows && rows.length > 0 && !result && (
          <button className="btn-primary rounded-md" disabled={busy} onClick={doImport}>
            {busy ? "Importing…" : `Add ${rows.length} user${rows.length > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      {busy && <Spinner label="Adding users…" />}

      {/* preview before import */}
      {rows && rows.length > 0 && !result && !busy && (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full">
            <thead><tr><th className="th">Email</th><th className="th">Name</th><th className="th">Phone</th><th className="th">Password</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="trow">
                  <td className="td font-medium text-ink">{r.email}</td>
                  <td className="td text-muted">{r.fullName ?? "—"}</td>
                  <td className="td tnum text-muted">{r.phone ?? "—"}</td>
                  <td className="td text-muted">{r.password ? "set" : "invite"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* per-row outcome */}
      {result && (
        <>
          <div className="mb-2 flex flex-wrap gap-2 text-[12.5px]">
            <span className="text-muted">{result.total} rows:</span>
            {Object.entries(result.tally).map(([k, n]) => <Badge key={k} tone={tone(k)}>{n} {k}</Badge>)}
          </div>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full">
              <thead><tr><th className="th">Email</th><th className="th">Result</th><th className="th">Detail</th></tr></thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr key={i} className="trow">
                    <td className="td font-medium text-ink">{r.email}</td>
                    <td className="td"><Badge tone={tone(r.status)}>{r.status}</Badge></td>
                    <td className="td text-muted">{r.message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {err && <div className="mt-2 text-[13px] text-accent">{err}</div>}
    </Card>
  );
}
