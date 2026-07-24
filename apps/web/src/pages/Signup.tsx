import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Field } from "../components/ui";

/** Public self-registration for a counterparty (vendor/workshop) — QNEW-71 Slice 6a.
 *  Creates a pending account and signs in immediately; the portal then prompts for activation. */
export default function Signup() {
  const { signup } = useAuth();
  const [kind, setKind] = useState<"vendor" | "workshop">("vendor");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mobile, setMobile] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await signup({ kind, fullName, email, password, mobile: mobile || undefined });
    } catch (e) {
      setErr((e as Error).message || "sign up failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-surface">
      <form onSubmit={submit} className="w-[380px] rounded-xl2 border border-line bg-panel p-7 shadow-card">
        <div className="flex items-center gap-2">
          <img src="/qvm-logo.png" alt="QParts" className="h-8 w-auto" />
          <span className="text-[22px] font-bold uppercase tracking-tight text-navy">Parts</span>
        </div>
        <p className="mb-4 mt-1.5 text-[13px] text-muted">Create your account — start now, verify later.</p>

        <Field label="I am a">
          <div className="flex overflow-hidden rounded-md border border-line text-[13px] font-medium">
            {(["vendor", "workshop"] as const).map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => setKind(k)}
                className={`flex-1 px-3 py-2 ${kind === k ? "bg-accent text-white" : "bg-panel text-muted hover:bg-surface"}`}
              >
                {k === "vendor" ? "Supplier" : "Workshop"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Full name">
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ahmed Al-Otaibi" />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" placeholder="you@company.sa" />
        </Field>
        <Field label="Mobile (optional)">
          <input className="input" value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="05xxxxxxxx" />
        </Field>
        <Field label="Password">
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
        </Field>
        {err && <div className="mb-2 text-[13px] text-accent">{err}</div>}
        <button className="btn-primary w-full rounded-md" disabled={busy || !fullName || !email || password.length < 8}>
          {busy ? "Creating account…" : "Create account"}
        </button>
        <p className="mt-3 text-center text-[12.5px] text-muted">
          Already have an account?{" "}
          <a href="/login" className="font-medium text-accent hover:underline">Sign in</a>
        </p>
      </form>
    </div>
  );
}
