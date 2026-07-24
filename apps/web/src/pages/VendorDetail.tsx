import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { ChevronLeft, KeyRound, Building2, Users, Files, Eye, Upload } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState } from "../components/ui";
import CreateAccountDialog from "../components/CreateAccountDialog";
import BulkAccountsDialog from "../components/BulkAccountsDialog";

/**
 * One vendor's own page — the full record behind a directory row: identity, branches, portal
 * accounts (create them here), linked workspaces, quotation activity and won orders. A scoped
 * workspace user only ever sees its OWN link + quotations (the API enforces it).
 */
interface Detail {
  vendor: {
    id: string; legal_name: string; counterparty_type: "individual" | "company"; activation_status: string;
    vendor_type: string; tax_number: string | null; commercial_registration_number: string | null;
    primary_phone: string | null; primary_email: string | null; payment_terms_days: number | null;
    is_active: boolean; created_at: string;
  };
  branches: Array<{ id: string; name: string; address: string | null; region: string | null; city: string | null }>;
  accounts: Array<{ id: string; full_name: string; email: string; is_active: boolean; is_vendor_admin: boolean }>;
  workspaces: Array<{ id: string; name: string; slug: string; status: string; classification: string | null }>;
  quotations: Array<{ id: string; order_number: string; plate_number: string | null; status: string | null; workspace: string; quoted_items: number }>;
  won: { orders: number; total: string };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line-2 py-2.5 last:border-0">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="text-[13px] font-medium text-ink">{value || "—"}</span>
    </div>
  );
}

export default function VendorDetail() {
  const { id } = useParams();
  const { me, impersonate } = useAuth();
  const isPlatform = me?.persona === "platform";
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [acct, setAcct] = useState(false);
  const [bulk, setBulk] = useState(false);

  const load = useCallback(async () => {
    setD(await api.get<Detail>(`/vendors/${id}`));
  }, [id]);
  useEffect(() => { load().catch((e) => setErr((e as Error).message)); }, [load]);

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;
  const v = d.vendor;
  const admin = d.accounts.find((a) => a.is_vendor_admin) ?? d.accounts[0];

  return (
    <>
      <Link to="/vendors" className="mb-3 inline-flex items-center gap-1 text-[12.5px] text-muted hover:text-ink">
        <ChevronLeft className="h-3.5 w-3.5" /> Vendors
      </Link>
      <PageHeader
        title={v.legal_name}
        subtitle={`${v.counterparty_type === "company" ? "Company" : "Individual"} supplier · ${v.vendor_type} · added ${new Date(v.created_at).toLocaleDateString()}`}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={statusTone(v.activation_status)}>{v.activation_status}</Badge>
            {d.accounts.length > 0 ? <Badge tone="green">has login</Badge> : <Badge tone="amber">no login</Badge>}
            {isPlatform && admin && (
              <button className="btn btn-sm rounded-md" onClick={() => impersonate(admin.id)}>
                <Eye className="h-3.5 w-3.5" /> View as
              </button>
            )}
          </div>
        }
      />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      {acct && (
        <CreateAccountDialog kind="vendor" entityId={v.id} entityName={v.legal_name}
          onClose={(created) => { setAcct(false); if (created) load(); }} />
      )}
      {bulk && (
        <BulkAccountsDialog kind="vendor" entityId={v.id} entityName={v.legal_name}
          onClose={(imported) => { setBulk(false); if (imported) load(); }} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Identity</h3>
          <Row label="Legal form" value={<Badge tone={v.counterparty_type === "company" ? "gray" : "amber"}>{v.counterparty_type}</Badge>} />
          <Row label="Category" value={v.vendor_type} />
          <Row label={v.counterparty_type === "company" ? "Tax number" : "Mobile (identifier)"}
            value={v.counterparty_type === "company" ? v.tax_number : v.primary_phone} />
          <Row label="Commercial reg." value={v.commercial_registration_number} />
          <Row label="Email" value={v.primary_email} />
          <Row label="Phone" value={v.primary_phone} />
          <Row label="Payment terms" value={v.payment_terms_days != null ? `${v.payment_terms_days} days` : null} />
        </Card>

        <Card className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink">
              <Users className="mr-1.5 inline h-4 w-4 text-faint" /> Portal accounts
            </h3>
            {isPlatform && (
              <div className="flex items-center gap-1.5">
                <button className="btn btn-sm rounded-md" onClick={() => setAcct(true)}>
                  <KeyRound className="h-3.5 w-3.5" /> Create login
                </button>
                <button className="btn btn-sm rounded-md" onClick={() => setBulk(true)}>
                  <Upload className="h-3.5 w-3.5" /> Import logins
                </button>
              </div>
            )}
          </div>
          {d.accounts.length === 0 ? (
            <p className="text-[12.5px] text-muted">No login yet — this supplier cannot sign in to price requests. Create one so they can quote themselves.</p>
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Status</th></tr></thead>
              <tbody>
                {d.accounts.map((a) => (
                  <tr key={a.id} className="trow">
                    <td className="td font-medium text-ink">{a.full_name}</td>
                    <td className="td text-muted">{a.email}</td>
                    <td className="td">{a.is_vendor_admin ? <Badge tone="blue">admin</Badge> : <Badge tone="gray">staff</Badge>}</td>
                    <td className="td"><Badge tone={a.is_active ? "green" : "gray"}>{a.is_active ? "active" : "inactive"}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <h3 className="mb-3 text-[14px] font-semibold text-ink">
            <Building2 className="mr-1.5 inline h-4 w-4 text-faint" /> Branches
          </h3>
          {d.branches.length === 0 ? (
            <p className="text-[12.5px] text-muted">No branches recorded.</p>
          ) : (
            <table className="w-full">
              <thead><tr><th className="th">Branch</th><th className="th">Region</th><th className="th">City</th><th className="th">Address</th></tr></thead>
              <tbody>
                {d.branches.map((b) => (
                  <tr key={b.id} className="trow">
                    <td className="td font-medium text-ink">{b.name}</td>
                    <td className="td text-muted">{b.region ?? "—"}</td>
                    <td className="td text-muted">{b.city ?? "—"}</td>
                    <td className="td text-muted">{b.address ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">Business</h3>
          <Row label="Won orders" value={<span className="tnum">{d.won.orders}</span>} />
          <Row label="Won value (SAR)" value={<span className="tnum">{Number(d.won.total).toFixed(2)}</span>} />
          <h3 className="mb-2 mt-4 text-[14px] font-semibold text-ink">Workspaces</h3>
          {d.workspaces.length === 0 ? (
            <p className="text-[12.5px] text-muted">Not linked to any workspace.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {d.workspaces.map((x) => (
                <div key={x.id} className="flex items-center justify-between">
                  <span className="text-[13px] font-medium text-ink">{x.name}</span>
                  <div className="flex items-center gap-1.5">
                    {x.classification && <Badge tone="gray">{x.classification}</Badge>}
                    <Badge tone={statusTone(x.status)}>{x.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card pad={false} className="mt-5">
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">
          <Files className="mr-1.5 inline h-4 w-4 text-faint" /> Recent quotation requests
        </div>
        {d.quotations.length === 0 ? (
          <EmptyState title="No quotation requests yet" hint="Requests sent to this supplier will appear here." />
        ) : (
          <table className="w-full">
            <thead><tr><th className="th">Order</th><th className="th">Plate</th><th className="th">Workspace</th><th className="th">Quoted items</th><th className="th">Status</th></tr></thead>
            <tbody>
              {d.quotations.map((q) => (
                <tr key={q.id} className="trow">
                  <td className="td font-medium text-ink">{q.order_number}</td>
                  <td className="td text-muted">{q.plate_number ?? "—"}</td>
                  <td className="td text-muted">{q.workspace}</td>
                  <td className="td tnum">{q.quoted_items}</td>
                  <td className="td"><Badge tone={statusTone(q.status)}>{q.status ?? "—"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
