/**
 * Shared spreadsheet reader for every bulk-import surface (counterparty onboarding, portal accounts).
 * CSV is parsed as UTF-8 TEXT on purpose: SheetJS mangles Arabic headers and strips leading zeros
 * from mobile numbers, which are both load-bearing here. .xlsx goes through SheetJS with raw:false
 * so text-formatted cells (phones, tax numbers) survive as written.
 */
export function parseCsv(input: string): Record<string, string>[] {
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

/** Read a .csv/.xlsx File into plain header→value objects. Throws on an unreadable file. */
export async function readSheet(file: File): Promise<Record<string, unknown>[]> {
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  const XLSX = await import("xlsx"); // lazily imported so it stays out of the main bundle
  const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as Record<string, unknown>[];
}

/** Case/spacing-insensitive column pick: pick(row, "full name", "name", "الاسم"). */
export function pick(obj: Record<string, unknown>, ...names: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const map = new Map(Object.keys(obj).map((k) => [norm(k), k]));
  for (const n of names) {
    const key = map.get(norm(n));
    const v = key != null ? obj[key] : undefined;
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}
