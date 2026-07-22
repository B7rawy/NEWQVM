import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Field } from "../components/ui";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("admin@qvm.local");
  const [password, setPassword] = useState("admin1234");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(email, password);
    } catch (e) {
      setErr((e as Error).message || "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-surface">
      <form onSubmit={submit} className="w-[360px] rounded-xl2 border border-line bg-white p-7 shadow-card">
        <div className="text-[22px] font-bold tracking-tight text-navy">
          QVM<span className="text-accent"> Platform</span>
        </div>
        <p className="mb-4 mt-0.5 text-[13px] text-muted">Sign in to your workspace</p>
        <Field label="Email">
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </Field>
        <Field label="Password">
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        {err && <div className="mb-2 text-[13px] text-accent">{err}</div>}
        <button className="btn-primary w-full rounded-md" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
