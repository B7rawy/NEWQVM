import { useEffect, useState } from "react";
import { Check, ChevronLeft, X } from "lucide-react";
import { api } from "../lib/api";
import { Field } from "./ui";

/**
 * Add-workshop flow (QNEW-71). A workshop is only USEFUL once it has three things, so the flow walks
 * them in order instead of leaving disconnected forms on the page:
 *   1. Identity — legal form drives the mandatory identifier (company⇒tax, individual⇒mobile).
 *   2. First branch — an RFQ is always raised for a branch, so a workshop with none can't transact.
 *   3. Portal access — the owner's login; without it nobody can sign in as this workshop.
 * Steps 2 and 3 are skippable and can be completed later from the row actions.
 */
interface Region { id: string; name: string }
interface Ws { id: string; name: string }

const STEPS = ["Identity", "First branch", "Portal access"] as const;

export default function AddWorkshopWizard({ regions, workspaces, activeSlug, onClose }: { regions: Region[]; workspaces: Ws[]; activeSlug?: string | null; onClose: (created: boolean) => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [result, setResult] = useState<{ workshop: string; branch?: string; account?: string } | null>(null);

  // step 1
  const [cpType, setCpType] = useState<"company" | "individual">("company");
  const [name, setName] = useState("");
  const [tax, setTax] = useState("");
  const [mobile, setMobile] = useState("");
  const [email, setEmail] = useState("");
  const [targetWs, setTargetWs] = useState("");
  // step 2
  const [bName, setBName] = useState("");
  const [bRegion, setBRegion] = useState("");
  // step 3
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPass, setOwnerPass] = useState("");

  // Esc closes the drawer (a11y) — parent decides whether to refresh based on whether we created.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(!!createdId); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [createdId, onClose]);

  const isCompany = cpType === "company";
  const step1Valid = name.trim().length >= 2 && (isCompany ? tax.trim().length > 0 : mobile.trim().length > 0) && (!!activeSlug || !!targetWs);

  /** Step 1 actually creates the workshop, so later steps can attach to a real id. */
  async function createWorkshop() {
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>("/org/workshops", {
        counterpartyType: cpType,
        name: name.trim(),
        taxNumber: isCompany ? tax.trim() : undefined,
        primaryPhone: !isCompany ? mobile.trim() : mobile.trim() || undefined,
        primaryEmail: email.trim() || undefined,
        tenantId: targetWs || undefined,
      });
      setCreatedId(r.id);
      setResult({ workshop: name.trim() });
      setStep(1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addBranch(skip = false) {
    if (skip || !bName.trim()) return setStep(2);
    setErr("");
    setBusy(true);
    try {
      await api.post("/org/branches", { workshopId: createdId, name: bName.trim(), regionId: bRegion || undefined });
      setResult((r) => ({ ...r!, branch: bName.trim() }));
      setStep(2);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function addAccount(skip = false) {
    if (skip || !ownerEmail.trim()) return setStep(3);
    setErr("");
    setBusy(true);
    try {
      await api.post(`/counterparty/workshop/${createdId}/account`, {
        email: ownerEmail.trim(),
        password: ownerPass || undefined,
      });
      setResult((r) => ({ ...r!, account: ownerEmail.trim() }));
      setStep(3);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => onClose(!!createdId)}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-panel p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <div className="mb-5 flex items-start justify-between">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">Add a workshop</h2>
            <p className="mt-0.5 text-[12.5px] text-muted">A customer workshop: its identity, a branch to order from, and a login.</p>
          </div>
          <button className="btn btn-sm rounded-md" onClick={() => onClose(!!createdId)}><X className="h-4 w-4" /></button>
        </div>

        {/* stepper */}
        <div className="mb-6 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  step > i ? "bg-emerald-500 text-white" : step === i ? "bg-accent text-white" : "bg-surface text-faint"
                }`}
              >
                {step > i ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={`text-[12.5px] ${step >= i ? "font-medium text-ink" : "text-faint"}`}>{s}</span>
              {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line-2" />}
            </div>
          ))}
        </div>

        {/* STEP 1 — identity */}
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <Field label="Legal form">
              <div className="flex gap-2">
                {(["company", "individual"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setCpType(t)}
                    className={`btn btn-sm flex-1 rounded-md ${cpType === t ? "btn-primary" : ""}`}>
                    {t === "company" ? "Company" : "Individual"}
                  </button>
                ))}
              </div>
            </Field>
            {workspaces.length > 0 && (
              <Field label="Link to workspace">
                <select className="input" value={targetWs} onChange={(e) => setTargetWs(e.target.value)}>
                  {activeSlug ? <option value="">Active workspace ({activeSlug})</option> : <option value="">Select a workspace…</option>}
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={isCompany ? "Legal name" : "Full name"}>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isCompany ? "Al-Salam Motors" : "Ahmed Al-Otaibi"} />
            </Field>
            {isCompany ? (
              <Field label="Tax number (required)">
                <input className="input" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="3xxxxxxxxxxxxx3" />
              </Field>
            ) : (
              <Field label="Mobile (required)">
                <input className="input" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="05xxxxxxxx" />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-4">
              {isCompany && (
                <Field label="Phone (optional)">
                  <input className="input" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="+9665…" />
                </Field>
              )}
              <Field label="Email (optional)">
                <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@workshop.sa" />
              </Field>
            </div>
            <p className="text-[12px] text-faint">
              {isCompany ? "The tax number is the company's unique identifier — it prevents the same workshop existing twice." : "The mobile is this individual's unique identifier."}
            </p>
            <button className="btn-primary rounded-md" disabled={busy || !step1Valid} onClick={createWorkshop}>
              {busy ? "Creating…" : "Create & continue"}
            </button>
          </div>
        )}

        {/* STEP 2 — first branch */}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <p className="text-[12.5px] text-muted">Requests are always raised for a specific branch, so add at least one.</p>
            <Field label="Branch name">
              <input className="input" value={bName} onChange={(e) => setBName(e.target.value)} placeholder="Main branch" />
            </Field>
            <Field label="Region (optional)">
              <select className="input" value={bRegion} onChange={(e) => setBRegion(e.target.value)}>
                <option value="">Select region…</option>
                {regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
            <div className="flex gap-2">
              <button className="btn rounded-md" onClick={() => addBranch(true)}>Skip for now</button>
              <button className="btn-primary flex-1 rounded-md" disabled={busy || !bName.trim()} onClick={() => addBranch()}>
                {busy ? "Adding…" : "Add branch & continue"}
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 — portal access */}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <p className="text-[12.5px] text-muted">Give the owner a login so they can raise their own requests. You can also do this later.</p>
            <Field label="Owner email">
              <input className="input" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@workshop.sa" />
            </Field>
            <Field label="Password (optional — leave empty to invite)">
              <input className="input" type="password" value={ownerPass} onChange={(e) => setOwnerPass(e.target.value)} placeholder="min 8 chars" />
            </Field>
            <div className="flex gap-2">
              <button className="btn rounded-md" onClick={() => addAccount(true)}>Skip for now</button>
              <button className="btn-primary flex-1 rounded-md" disabled={busy || !ownerEmail.includes("@") || (!!ownerPass && ownerPass.length < 8)} onClick={() => addAccount()}>
                {busy ? "Creating…" : "Create login & finish"}
              </button>
            </div>
          </div>
        )}

        {/* DONE */}
        {step === 3 && result && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white"><Check className="h-3.5 w-3.5" /></span>
              {result.workshop} is ready
            </div>
            <ul className="flex flex-col gap-1 text-[13px] text-sub">
              <li>✓ Workshop created ({isCompany ? "company" : "individual"})</li>
              <li>{result.branch ? `✓ Branch “${result.branch}” added` : "— No branch yet (add one from the list)"}</li>
              <li>{result.account ? `✓ Login created for ${result.account}` : "— No login yet (create one from the list)"}</li>
            </ul>
            <button className="btn-primary rounded-md" onClick={() => onClose(true)}>Done</button>
          </div>
        )}

        {step < 3 && (
          <button className="mt-4 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink" onClick={() => (step === 0 ? onClose(!!createdId) : setStep((s) => s - 1))}>
            <ChevronLeft className="h-3.5 w-3.5" /> {step === 0 ? "Cancel" : "Back"}
          </button>
        )}
        {err && <div className="mt-3 text-[13px] text-accent">{err}</div>}
      </div>
    </div>
  );
}
