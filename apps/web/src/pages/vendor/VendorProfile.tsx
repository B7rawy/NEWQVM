import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../../components/ui";

interface Branch { id: string; name: string; address: string | null; region: string | null }
interface Profile {
  legal_name: string; counterparty_type: string; activation_status: string; vendor_type: string;
  primary_email: string | null; primary_phone: string | null; tax_number: string | null;
  commercial_registration_number: string | null; branches: Branch[]; workspaces: string[];
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line-2 py-2.5 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="text-[13px] font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

export default function VendorProfile() {
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.get<Profile>("/vendor/profile").then(setP).catch((e) => setErr((e as Error).message));
  }, []);
  if (!p) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <PageHeader title="Vendor Profile" subtitle="Your company identity and where you supply." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[16px] font-semibold text-ink">{p.legal_name}</span>
            <Badge tone={p.counterparty_type === "company" ? "gray" : "amber"}>{p.counterparty_type}</Badge>
            <Badge tone={statusTone(p.activation_status)}>{p.activation_status}</Badge>
          </div>
          <Row label="Type" value={p.vendor_type} />
          <Row label="Email" value={p.primary_email} />
          <Row label="Phone" value={p.primary_phone} />
          <Row label="Tax number" value={p.tax_number} />
          <Row label="Commercial registration" value={p.commercial_registration_number} />
        </Card>
        <Card>
          <h3 className="mb-2 text-[13px] font-semibold text-ink">Workspaces you supply</h3>
          {p.workspaces.length === 0 ? (
            <p className="text-[12.5px] text-muted">Not linked to any workspace yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {p.workspaces.map((w) => (
                <span key={w} className="rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium text-sub">{w}</span>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card pad={false} className="mt-5">
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Branches</div>
        {p.branches.length === 0 ? (
          <EmptyState title="No branches" hint="Your depots/branches will appear here." />
        ) : (
          <table className="w-full">
            <thead>
              <tr><th className="th">Branch</th><th className="th">Region</th><th className="th">Address</th></tr>
            </thead>
            <tbody>
              {p.branches.map((b) => (
                <tr key={b.id} className="trow">
                  <td className="td font-medium text-ink">{b.name}</td>
                  <td className="td text-muted">{b.region ?? "—"}</td>
                  <td className="td text-muted">{b.address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
