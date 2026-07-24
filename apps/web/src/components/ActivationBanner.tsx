import { useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";

/** Shown to a self-registered counterparty whose account is still PENDING (QNEW-71 activation gate).
 *  Provide the mobile identifier → the account auto-activates. */
export default function ActivationBanner() {
  const { me, refreshMe } = useAuth();
  const [mobile, setMobile] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  // keep showing while `done` so the success confirmation survives refreshMe flipping the status.
  if (!done && (!me || me.activationStatus !== "pending")) return null;

  async function activate(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await api.post("/account/activate", { mobile });
      setDone(true);
      await refreshMe();
    } catch (e) {
      setErr((e as Error).message || "activation failed");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="flex items-center gap-2 border-b border-emerald-300 bg-emerald-50 px-6 py-2.5 text-[13px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> Account activated — welcome aboard.
      </div>
    );

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-6 py-2.5 dark:border-amber-800 dark:bg-amber-950/40">
      <form onSubmit={activate} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
        <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="font-medium text-amber-800 dark:text-amber-300">Your account is pending activation.</span>
        <span className="text-amber-700 dark:text-amber-400">Add your mobile number to activate:</span>
        <input
          className="input h-8 w-44 py-1"
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          placeholder="05xxxxxxxx"
        />
        <button className="btn-primary btn-sm rounded-md" disabled={busy || mobile.trim().length < 6}>
          {busy ? "Activating…" : "Activate"}
        </button>
        {err && <span className="text-accent">{err}</span>}
      </form>
    </div>
  );
}
