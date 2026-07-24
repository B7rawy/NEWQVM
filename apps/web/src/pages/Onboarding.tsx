import { useEffect, useState, useCallback } from "react";
import { Plus, CheckCircle2, Clock } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";

interface Submission {
  id: string;
  kind: "vendor" | "workshop";
  counterparty_type: "individual" | "company";
  legal_name: string;
  tax_number: string | null;
  mobile: string | null;
  email: string | null;
  status: string;
  candidate_count: number;
  created_at: string;
}
interface SubmitResult {
  status: "pending" | "merged";
  autoLinked: boolean;
  entityId?: string;
  matchCount: number; // count only — directory names are never exposed to the workspace (privacy)
}

const empty = { kind: "vendor", counterpartyType: "company", legalName: "", taxNumber: "", commercialRegistrationNumber: "", mobile: "", email: "", classification: "" };

export default function Onboarding() {
  const { activeSlug, me } = useAuth();
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [f, setF] = useState({ ...empty });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ submissions: Submission[] }>("/counterparty/submissions");
    setRows(r.submissions);
  }, []);
  useEffect(() => {
    setRows(null);
    load().catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, [activeSlug, load]);

  const isCompany = f.counterpartyType === "company";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setResult(null);
    setBusy(true);
    try {
      const res = await api.post<SubmitResult>("/counterparty/submissions", {
        kind: f.kind,
        counterpartyType: f.counterpartyType,
        legalName: f.legalName,
        taxNumber: f.taxNumber || undefined,
        commercialRegistrationNumber: f.commercialRegistrationNumber || undefined,
        mobile: f.mobile || undefined,
        email: f.email || undefined,
        classification: f.classification || undefined,
      });
      setResult(res);
      setF({ ...empty, kind: f.kind, counterpartyType: f.counterpartyType });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (me?.persona === "platform" && !activeSlug) {
    return (
      <>
        <PageHeader title="Add a supplier or workshop" subtitle="Request a counterparty for a workspace" />
        <Card>
          <EmptyState title="Select a workspace" hint="Submissions belong to a workspace. Pick one from the switcher to submit on its behalf, or use Onboarding review to process the queue." />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Add a supplier or workshop"
        subtitle="Request a new counterparty — our team verifies it and links it to your workspace (no duplicates)."
      />

      {/* Submission form */}
      <Card className="mb-5">
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Type">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="vendor">Vendor (supplier)</option>
              <option value="workshop">Workshop (client)</option>
            </select>
          </Field>
          <Field label="Entity">
            <select
              className="input"
              value={f.counterpartyType}
              onChange={(e) => {
                const v = e.target.value;
                // Reset company-only identifiers when switching to individual (avoid stale values).
                setF((prev) => ({ ...prev, counterpartyType: v, ...(v === "individual" ? { taxNumber: "", commercialRegistrationNumber: "" } : {}) }));
              }}
            >
              <option value="company">Company</option>
              <option value="individual">Individual</option>
            </select>
          </Field>
          <Field label={isCompany ? "Legal name" : "Full name"}>
            <input className="input" value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} placeholder={isCompany ? "Gulf Auto Parts Co." : "Nasser Al-Otaibi"} />
          </Field>
          {isCompany ? (
            <>
              <Field label="Tax number">
                <input className="input" value={f.taxNumber} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} placeholder="3001234567890" />
              </Field>
              <Field label="Commercial registration (optional)">
                <input className="input" value={f.commercialRegistrationNumber} onChange={(e) => setF({ ...f, commercialRegistrationNumber: e.target.value })} placeholder="1010xxxxxx" />
              </Field>
            </>
          ) : (
            <Field label="Mobile">
              <input className="input" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="05xxxxxxxx" />
            </Field>
          )}
          <Field label="Email (optional)">
            <input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="sales@company.sa" />
          </Field>
          {isCompany && (
            <Field label="Mobile (optional)">
              <input className="input" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} placeholder="05xxxxxxxx" />
            </Field>
          )}
          <Field label="Classification (optional)">
            <input className="input" value={f.classification} onChange={(e) => setF({ ...f, classification: e.target.value })} placeholder="A / B / C" />
          </Field>
          <div className="flex items-end md:col-span-3">
            <button className="btn-primary rounded-md" disabled={busy || !f.legalName || (isCompany ? !f.taxNumber && !f.email && !f.mobile : !f.mobile)}>
              <Plus className="h-4 w-4" /> {busy ? "Submitting…" : "Submit for review"}
            </button>
          </div>
        </form>
        {err && <div className="mt-2 text-[13px] text-accent">{err}</div>}
        {result && (
          <div className={`mt-3 flex items-start gap-2 rounded-md border px-4 py-3 text-[13px] ${result.autoLinked ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300" : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"}`}>
            {result.autoLinked ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <Clock className="mt-0.5 h-4 w-4 shrink-0" />}
            <div>
              {result.autoLinked ? (
                <>Linked to an existing verified entity in your workspace — ready to use.</>
              ) : (
                <>
                  Submitted for review. {result.matchCount > 0 && `We found ${result.matchCount} possible existing match${result.matchCount > 1 ? "es" : ""} — our team will confirm.`} You'll see it below once approved.
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* My submissions */}
      <Card pad={false}>
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">My submissions</div>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No submissions yet" hint="Submit a supplier or workshop above to get started." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Name</th>
                  <th className="th">Type</th>
                  <th className="th">Identifier</th>
                  <th className="th">Status</th>
                  <th className="th">Matches</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="trow">
                    <td className="td font-medium text-ink">{s.legal_name}</td>
                    <td className="td text-muted">
                      {s.kind} · {s.counterparty_type}
                    </td>
                    <td className="td tnum text-muted">{s.tax_number ?? s.mobile ?? s.email ?? "—"}</td>
                    <td className="td">
                      <Badge tone={statusTone(s.status)}>{s.status}</Badge>
                    </td>
                    <td className="td tnum text-muted">{s.candidate_count || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
