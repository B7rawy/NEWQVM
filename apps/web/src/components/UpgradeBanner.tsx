import { useState } from "react";
import { Building2, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Field } from "./ui";

/** Offered to an ACTIVE individual counterparty (QNEW-71 upgrade path): create a company entity and
 *  re-parent all history onto it. Optional — a slim info bar that expands into a short form. */
export default function UpgradeBanner() {
  const { me, refreshMe } = useAuth();
  const [open, setOpen] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [taxNumber, setTaxNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  const eligible = (me?.persona === "vendor" || me?.persona === "workshop") && me?.counterpartyType === "individual" && me?.activationStatus === "active";
  // keep showing while `done` so the success confirmation survives refreshMe flipping counterpartyType.
  if (!done && !eligible) return null;

  async function upgrade(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/account/upgrade", { legalName, taxNumber });
      setDone(true);
      await refreshMe();
    } catch (e) {
      setErr((e as Error).message || "upgrade failed");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="flex items-center gap-2 border-b border-emerald-300 bg-emerald-50 px-6 py-2.5 text-[13px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> Upgraded to a company — your history moved across.
      </div>
    );

  return (
    <div className="border-b border-line bg-navy/5 px-6 py-2.5 dark:bg-white/5">
      {!open ? (
        <div className="flex flex-wrap items-center gap-3 text-[13px]">
          <Building2 className="h-4 w-4 shrink-0 text-muted" />
          <span className="text-sub">You're registered as an individual.</span>
          <button className="font-medium text-accent hover:underline" onClick={() => setOpen(true)}>
            Upgrade to a company →
          </button>
        </div>
      ) : (
        <form onSubmit={upgrade} className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Legal company name">
              <input className="input h-8 py-1" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Gulf Auto Parts Co." />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Tax number">
              <input className="input h-8 py-1" value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} placeholder="3001234567890" />
            </Field>
          </div>
          <button className="btn-primary btn-sm mb-3 rounded-md" disabled={busy || legalName.length < 2 || !taxNumber}>
            {busy ? "Upgrading…" : "Upgrade"}
          </button>
          <button type="button" className="btn btn-sm mb-3 rounded-md" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {err && <span className="mb-3.5 text-[13px] text-accent">{err}</span>}
        </form>
      )}
    </div>
  );
}
