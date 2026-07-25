import { useEffect, useState } from "react";
import { Users, Building2 } from "lucide-react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, statusTone, Spinner } from "../../components/ui";

/**
 * Service-provider portal home. A provider delivers a SERVICE (shipping, inspection, claims) rather
 * than quoting RFQs, so its portal is its own record: identity, the workspaces it serves, and its
 * people — no quotation queue.
 */
interface Overview {
  legal_name: string; scope: "internal" | "external"; service_type: string | null;
  counterparty_type: "individual" | "company"; activation_status: string;
  tax_number: string | null; primary_email: string | null; primary_phone: string | null;
  workspaces: string[];
  teammates: Array<{ full_name: string; email: string; is_provider_admin: boolean; is_active: boolean }>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line-2 py-2.5 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="text-[13px] font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

export default function ProviderOverview() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.get<Overview>("/provider/overview").then(setD).catch((e) => setErr((e as Error).message));
  }, []);
  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <PageHeader
        title={d.legal_name}
        subtitle={`${d.scope === "internal" ? "Internal team" : "External partner"}${d.service_type ? ` · ${d.service_type}` : ""}`}
        actions={<Badge tone={statusTone(d.activation_status)}>{d.activation_status}</Badge>}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Identity</h3>
          <Row label="Legal form" value={<Badge tone={d.counterparty_type === "company" ? "gray" : "amber"}>{d.counterparty_type}</Badge>} />
          <Row label="Service" value={d.service_type} />
          <Row label={d.counterparty_type === "company" ? "Tax number" : "Mobile"} value={d.counterparty_type === "company" ? d.tax_number : d.primary_phone} />
          <Row label="Email" value={d.primary_email} />
          <Row label="Phone" value={d.primary_phone} />
        </Card>

        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">
            <Building2 className="mr-1.5 inline h-4 w-4 text-faint" /> Workspaces you serve
          </h3>
          {d.workspaces.length === 0 ? (
            <p className="text-[12.5px] text-muted">Not linked to any workspace yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {d.workspaces.map((w) => (
                <span key={w} className="rounded-full bg-surface px-2.5 py-1 text-[12px] font-medium text-sub">{w}</span>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">
            <Users className="mr-1.5 inline h-4 w-4 text-faint" /> Your team
          </h3>
          <div className="flex flex-col gap-2">
            {d.teammates.map((t, i) => (
              <div key={i} className="flex items-center justify-between text-[13px]">
                <div className="flex flex-col">
                  <span className="font-medium text-ink">{t.full_name}</span>
                  <span className="text-[12px] text-muted">{t.email}</span>
                </div>
                {t.is_provider_admin ? <Badge tone="blue">admin</Badge> : <Badge tone="gray">staff</Badge>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
