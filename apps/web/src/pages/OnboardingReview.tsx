import { useEffect, useState, useCallback } from "react";
import { Check, GitMerge, X, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../components/ui";

interface Candidate {
  id: string;
  name: string;
  score: number;
  reasons: string[];
}
interface Review {
  id: string;
  kind: "vendor" | "workshop";
  counterparty_type: "individual" | "company";
  legal_name: string;
  tax_number: string | null;
  commercial_registration_number: string | null;
  mobile: string | null;
  email: string | null;
  classification: string | null;
  source: string;
  match_candidates: Candidate[];
  workspace: string;
  workspace_slug: string;
  created_at: string;
}

export default function OnboardingReview() {
  const [rows, setRows] = useState<Review[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const r = await api.get<{ submissions: Review[] }>("/counterparty/review");
    setRows(r.submissions);
  }, []);
  useEffect(() => {
    setRows(null);
    load().catch((e) => {
      setErr((e as Error).message);
      setRows([]);
    });
  }, [load]);

  async function act(id: string, action: "approve" | "reject", body: Record<string, unknown> = {}) {
    setBusy(id);
    setErr("");
    try {
      await api.post(`/counterparty/submissions/${id}/${action}`, body);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function merge(id: string, targetEntityId: string) {
    setBusy(id);
    setErr("");
    try {
      await api.post(`/counterparty/submissions/${id}/merge`, { targetEntityId });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="Onboarding review"
        subtitle="Pending counterparty submissions across every workspace — approve a new identity, merge into an existing one, or reject."
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="Queue is clear" hint="No submissions waiting for review." />
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((s) => (
            <Card key={s.id} pad={false}>
              <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
                {/* proposed identity */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink">{s.legal_name}</span>
                    <Badge tone="blue">{s.kind}</Badge>
                    <Badge tone={s.counterparty_type === "company" ? "gray" : "amber"}>{s.counterparty_type}</Badge>
                    {s.source === "excel_import" && <Badge tone="gray">imported</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] text-muted">
                    <span>Workspace: <b className="font-medium text-sub">{s.workspace}</b></span>
                    {s.tax_number && <span>Tax: <span className="tnum">{s.tax_number}</span></span>}
                    {s.commercial_registration_number && <span>CR: <span className="tnum">{s.commercial_registration_number}</span></span>}
                    {s.mobile && <span>Mobile: <span className="tnum">{s.mobile}</span></span>}
                    {s.email && <span>Email: {s.email}</span>}
                    {s.classification && <span>Class: {s.classification}</span>}
                  </div>

                  {/* match candidates */}
                  {s.match_candidates.length > 0 && (
                    <div className="mt-3 rounded-md border border-line-2 bg-surface p-3">
                      <div className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-faint">Possible existing matches</div>
                      <div className="flex flex-col gap-1.5">
                        {s.match_candidates.map((c) => (
                          <div key={c.id} className="flex items-center justify-between gap-3">
                            <div className="min-w-0 text-[13px]">
                              <span className="font-medium text-ink">{c.name}</span>
                              <span className="ml-2 text-[11.5px] text-muted">{c.reasons.join(" + ")} · {c.score}</span>
                            </div>
                            <button className="btn btn-sm rounded-md" disabled={busy === s.id} onClick={() => merge(s.id, c.id)}>
                              <GitMerge className="h-3.5 w-3.5" /> Merge
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* actions */}
                <div className="flex shrink-0 items-center gap-2 lg:flex-col lg:items-stretch">
                  <button className="btn-primary rounded-md" disabled={busy === s.id} onClick={() => act(s.id, "approve")}>
                    <Check className="h-4 w-4" /> Approve as new
                  </button>
                  <button className="btn btn-sm rounded-md text-accent" disabled={busy === s.id} onClick={() => act(s.id, "reject", { notes: "rejected in review" })}>
                    <X className="h-3.5 w-3.5" /> Reject
                  </button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
