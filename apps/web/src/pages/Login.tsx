import { useState } from "react";
import { useAuth } from "../lib/auth";
import { Field } from "../components/ui";

export default function Login() {
  const { login } = useAuth();
  // NEVER prefill credentials. These defaults used to be the seeded Platform Admin's email AND
  // password, and they shipped in the production bundle — opening the site and pressing Sign in
  // handed anyone the most privileged account on the platform.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      <form onSubmit={submit} className="w-[360px] rounded-xl2 border border-line bg-panel p-7 shadow-card">
        <div className="flex items-center gap-2">
          <img src="/qvm-logo.png" alt="QParts" className="h-8 w-auto" />
          <span className="text-[22px] font-bold uppercase tracking-tight text-navy">Parts</span>
        </div>
        <p className="mb-4 mt-1.5 text-[13px] text-muted">Sign in to your workspace</p>
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
        <p className="mt-3 text-center text-[12.5px] text-muted">
          New supplier or workshop?{" "}
          <a href="/signup" className="font-medium text-accent hover:underline">Create an account</a>
        </p>
      </form>
    </div>
  );
}
