import { useState } from "react";
import { Upload, CheckCircle2, AlertTriangle, Download } from "lucide-react";
import { api } from "../lib/api";
import { Card, Badge, Field } from "./ui";

/**
 * Bulk import wizard. The browser parses the .xlsx/.csv (SheetJS, lazily imported so it stays out of
 * the main bundle), maps flexible EN/AR headers → fields, previews + validates per row, then posts
 * the rows to POST /counterparty/import (server matches/auto-links/stages exactly like a single submit).
 */

interface Row {
  legalName: string;
  counterpartyType: "individual" | "company";
  taxNumber?: string;
  commercialRegistrationNumber?: string;
  mobile?: string;
  email?: string;
  classification?: string;
  _valid: boolean;
  _reason?: string;
}
interface ImportResult {
  batchId: string;
  total: number;
  autoLinked: number;
  pending: number;
  errors: number;
  perRow: Array<{ index: number; legalName: string; status: string; matchCount?: number; reason?: string }>;
}

const MAX_ROWS = 1000;

/** Normalised header (lowercased, collapsed) → our field. Accepts common EN + AR column names. */
const HEADER_MAP: Record<string, keyof Row> = {
  name: "legalName", "legal name": "legalName", legalname: "legalName", company: "legalName", "company name": "legalName", "full name": "legalName", الاسم: "legalName", اسم: "legalName", "اسم المورد": "legalName",
  type: "counterpartyType", entity: "counterpartyType", "entity type": "counterpartyType", النوع: "counterpartyType", نوع: "counterpartyType",
  tax: "taxNumber", "tax number": "taxNumber", taxnumber: "taxNumber", vat: "taxNumber", "الرقم الضريبي": "taxNumber", ضريبي: "taxNumber",
  cr: "commercialRegistrationNumber", "commercial registration": "commercialRegistrationNumber", "commercial registration number": "commercialRegistrationNumber", "السجل التجاري": "commercialRegistrationNumber", "سجل تجاري": "commercialRegistrationNumber",
  mobile: "mobile", phone: "mobile", "mobile number": "mobile", "phone number": "mobile", الجوال: "mobile", الموبايل: "mobile", جوال: "mobile", موبايل: "mobile", الهاتف: "mobile",
  email: "email", "e-mail": "email", mail: "email", الايميل: "email", "البريد الالكتروني": "email", البريد: "email",
  classification: "classification", class: "classification", category: "classification", التصنيف: "classification", تصنيف: "classification",
};
const norm = (h: string) => h.toString().trim().toLowerCase().replace(/\s+/g, " ");

function mapRow(obj: Record<string, unknown>): Row | null {
  const m: Partial<Record<keyof Row, string>> = {};
  for (const [k, v] of Object.entries(obj)) {
    const field = HEADER_MAP[norm(k)];
    if (field) m[field] = String(v ?? "").trim();
  }
  const legalName = m.legalName ?? "";
  const anyField = legalName || m.taxNumber || m.mobile || m.email || m.commercialRegistrationNumber || m.classification;
  if (!anyField) return null; // fully blank line → drop
  const counterpartyType = /ind|فرد/i.test(m.counterpartyType ?? "") ? "individual" : "company";
  const isCompany = counterpartyType === "company";
  const taxNumber = isCompany ? m.taxNumber || undefined : undefined;
  const cr = isCompany ? m.commercialRegistrationNumber || undefined : undefined;
  const mobile = m.mobile || undefined;
  const email = m.email || undefined;
  const hasId = !!(taxNumber || mobile || email);
  const valid = legalName.length >= 2 && hasId;
  return {
    legalName,
    counterpartyType,
    taxNumber,
    commercialRegistrationNumber: cr,
    mobile,
    email,
    classification: m.classification || undefined,
    _valid: valid,
    _reason: legalName.length < 2 ? "missing name" : !hasId ? "missing identifier" : undefined,
  };
}

/** Minimal RFC-4180-ish CSV → row objects. Parsing text ourselves preserves leading zeros in
 *  mobiles and UTF-8 Arabic headers (SheetJS' CSV path mangles both). Handles quoted fields. */
function parseCsv(input: string): Record<string, string>[] {
  const text = input.replace(/^﻿/, ""); // strip UTF-8 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const o: Record<string, string> = {};
      headers.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
      return o;
    });
}

export default function ImportWizard({ onDone }: { onDone: () => void }) {
  const [kind, setKind] = useState<"vendor" | "workshop">("vendor");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr("");
    setResult(null);
    setRows(null);
    setFilename(file.name);
    try {
      let objs: Record<string, unknown>[];
      if (/\.csv$/i.test(file.name)) {
        // UTF-8 text parse preserves Arabic headers + leading zeros in mobile numbers.
        objs = parseCsv(await file.text());
      } else {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // raw:false → formatted text (keeps text-formatted phone/tax cells intact).
        objs = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, unknown>[];
      }
      const parsed = objs.map(mapRow).filter((r): r is Row => r !== null);
      if (parsed.length === 0) setErr("No data rows found. The first row must be column headers (Name, Tax number, Mobile, Email…).");
      setRows(parsed);
    } catch {
      setErr("Could not read the file. Use a .xlsx or .csv file with a header row.");
    }
  }

  async function doImport() {
    if (!rows) return;
    if (rows.length > MAX_ROWS) {
      setErr(`Too many rows (${rows.length}). Split into files of ${MAX_ROWS} or fewer.`);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const payload = {
        kind,
        filename,
        rows: rows.map(({ _valid, _reason, ...r }) => r), // eslint-disable-line @typescript-eslint/no-unused-vars
      };
      const res = await api.post<ImportResult>("/counterparty/import", payload);
      setResult(res);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const csv = "Name,Type,Tax number,Commercial registration,Mobile,Email,Classification\nGulf Auto Parts Co.,company,3001234567890,1010xxxxxx,05xxxxxxxx,sales@gulf.sa,A\nNasser Al-Otaibi,individual,,,05xxxxxxxx,,B\n";
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = "counterparty-import-template.csv";
    a.click();
  }

  const validCount = rows?.filter((r) => r._valid).length ?? 0;
  const invalidCount = (rows?.length ?? 0) - validCount;

  return (
    <Card className="mb-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-semibold text-ink">Bulk import from Excel</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">Upload an .xlsx or .csv with a header row — we match, auto-link exact matches, and queue the rest for review.</p>
        </div>
        <button className="btn btn-sm rounded-md" onClick={downloadTemplate}>
          <Download className="h-3.5 w-3.5" /> Template
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Field label="These rows are">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "vendor" | "workshop")}>
            <option value="vendor">Vendors (suppliers)</option>
            <option value="workshop">Workshops (clients)</option>
          </select>
        </Field>
        <div className="md:col-span-2">
          <label className="label">File</label>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-line-2 bg-surface px-3 py-2 text-[13px] text-muted transition hover:border-accent hover:text-ink">
            <Upload className="h-4 w-4" />
            <span className="truncate">{filename || "Choose .xlsx / .csv…"}</span>
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={onFile} />
          </label>
        </div>
      </div>

      {err && <div className="mt-3 text-[13px] text-accent">{err}</div>}

      {rows && rows.length > 0 && !result && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2 text-[12.5px] text-muted">
            <span className="font-medium text-ink">{rows.length} rows</span>
            <Badge tone="green">{validCount} valid</Badge>
            {invalidCount > 0 && <Badge tone="red">{invalidCount} skipped</Badge>}
          </div>
          <div className="max-h-72 overflow-auto rounded-md border border-line-2">
            <table className="w-full">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Type</th>
                  <th className="th">Identifier</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 100).map((r, i) => (
                  <tr key={i} className="trow">
                    <td className="td font-medium text-ink">{r.legalName || <span className="text-faint">—</span>}</td>
                    <td className="td text-muted">{r.counterpartyType}</td>
                    <td className="td tnum text-muted">{r.taxNumber ?? r.mobile ?? r.email ?? "—"}</td>
                    <td className="td text-right">
                      {r._valid ? (
                        <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-500" />
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11.5px] text-accent">
                          <AlertTriangle className="h-3.5 w-3.5" /> {r._reason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 100 && <div className="mt-1 text-[11.5px] text-faint">Showing first 100 of {rows.length} rows.</div>}
          <button className="btn-primary mt-3 rounded-md" disabled={busy || validCount === 0} onClick={doImport}>
            {busy ? "Importing…" : `Import ${validCount} valid row${validCount === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-md border border-line-2 bg-surface p-4">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" /> Imported {result.total} rows
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge tone="green">{result.autoLinked} auto-linked</Badge>
            <Badge tone="amber">{result.pending} queued for review</Badge>
            {result.errors > 0 && <Badge tone="red">{result.errors} skipped</Badge>}
          </div>
          <p className="mt-2 text-[12px] text-muted">Queued rows now appear in your submissions below and in the platform review queue.</p>
        </div>
      )}
    </Card>
  );
}
