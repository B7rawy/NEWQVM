import { useState } from "react";
import { api } from "../lib/api";
import { Card, Field } from "./ui";

/**
 * Platform provisions a LOGIN for an existing directory entity (QNEW-71 access half): the owner
 * signs straight into their own portal with the entity's branches + workspace links attached — no
 * self-registration, no orphan identity to merge later.
 */
export default function CreateAccountDialog({
  kind,
  entityId,
  entityName,
  onClose,
}: {
  kind: "vendor" | "workshop" | "service_provider";
  entityId: string;
  entityName: string;
  onClose: (created?: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<{ invited: boolean }>(`/counterparty/${kind}/${entityId}/account`, {
        email: email.trim(),
        fullName: fullName.trim() || undefined,
        password: password || undefined,
      });
      setDone(r.invited ? `Invited ${email} — they still need a password set.` : `Account ready: ${email}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-ink">Add a user to “{entityName}”</h3>
        <button className="btn btn-sm rounded-md" onClick={() => onClose(!!done)}>Close</button>
      </div>
      {done ? (
        <div className="text-[13px] text-ink">
          {done}
          <p className="mt-1 text-[12.5px] text-muted">They sign in at the normal login page and land in this counterparty's own portal.</p>
        </div>
      ) : (
        <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Field label="User email">
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="owner@example.com" />
          </Field>
          <Field label="Full name (optional)">
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={entityName} />
          </Field>
          <Field label="Password (optional — else invite)">
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 8 chars" />
          </Field>
          <div className="flex items-end">
            <button className="btn-primary mb-3 w-full rounded-md" disabled={busy || !email.includes("@") || (!!password && password.length < 8)}>
              {busy ? "Adding…" : "Add user"}
            </button>
          </div>
        </form>
      )}
      {err && <div className="mt-2 text-[13px] text-accent">{err}</div>}
    </Card>
  );
}
