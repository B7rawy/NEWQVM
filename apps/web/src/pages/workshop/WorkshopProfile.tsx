import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, Field } from "../../components/ui";

/**
 * MY PROFILE — the workshop's identity as Qparts holds it, read-only on purpose: legal identity
 * (name, tax number) is edited through Qparts so the directory stays authoritative, and saying
 * that beats a form that silently does nothing.
 */
interface Profile {
  name: string;
  tax_number: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  activation_status: string;
  counterparty_type: "individual" | "company";
  is_workshop_admin: boolean;
  teammates: Array<{ full_name: string; email: string; is_workshop_admin: boolean }>;
}
interface Branches {
  branches: Array<{ id: string; name: string; workshop: string; region: string | null; order_category: string | null }>;
  workspaces: string[];
}

export default function WorkshopProfile() {
  const [p, setP] = useState<Profile | null>(null);
  const [b, setB] = useState<Branches | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<Profile>("/workshop/profile").then(setP).catch((e) => setErr((e as Error).message));
    api.get<Branches>("/workshop/branches").then(setB).catch(() => setB(null));
  }, []);

  if (!p) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <PageHeader
        title="My Profile"
        subtitle="Your workshop's identity as registered with Qparts"
        actions={<Badge tone={p.activation_status === "active" ? "green" : "amber"}>{p.activation_status}</Badge>}
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h3 className="mb-3 text-[14px] font-semibold text-ink">Identity</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Legal name"><div className="input flex items-center">{p.name}</div></Field>
            <Field label="Type"><div className="input flex items-center capitalize">{p.counterparty_type}</div></Field>
            <Field label="Tax number"><div className="input flex items-center tnum">{p.tax_number ?? "—"}</div></Field>
            <Field label="Phone"><div className="input flex items-center tnum">{p.primary_phone ?? "—"}</div></Field>
            <Field label="Email"><div className="input flex items-center">{p.primary_email ?? "—"}</div></Field>
          </div>
          <p className="mt-2 text-[12px] text-faint">
            Identity changes go through your Qparts contact — the supplier directory has to stay verified.
          </p>
        </Card>
        <Card pad={false}>
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">Team</div>
          <div className="divide-y divide-line-2">
            {p.teammates.map((t, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-ink">{t.full_name}</div>
                  <div className="text-[12px] text-muted">{t.email}</div>
                </div>
                {t.is_workshop_admin && <Badge tone="blue">admin</Badge>}
              </div>
            ))}
          </div>
        </Card>
      </div>
      {b && (
        <Card pad={false} className="mt-4">
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">
            Branches · works with {b.workspaces.join(", ")}
          </div>
          <table className="w-full">
            <thead><tr><th className="th">Branch</th><th className="th">Region</th><th className="th">Category</th></tr></thead>
            <tbody>
              {b.branches.map((br) => (
                <tr key={br.id} className="trow">
                  <td className="td font-medium text-ink">{br.name}</td>
                  <td className="td text-muted">{br.region ?? "—"}</td>
                  <td className="td text-muted">{br.order_category ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
