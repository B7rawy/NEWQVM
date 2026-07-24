import { useEffect, useMemo, useState, useCallback } from "react";
import { Plus } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PageHeader, Card, Badge, statusTone, Spinner, EmptyState, Field } from "../components/ui";

/**
 * Service providers (QNEW-71 AC11) — the third counterparty family, now wired to the /providers API.
 * Global directory entities (individual|company) with an internal/external scope; creating/linking is
 * platform-only, matching Vendors/Workshops.
 */
type Scope = "internal" | "external";
interface Provider {
  id: string;
  legal_name: string;
  scope: Scope;
  service_type: string | null;
  counterparty_type: "individual" | "company";
  activation_status: string;
  primary_email: string | null;
  primary_phone: string | null;
  status: string;
}
type Filter = "all" | Scope;

export default function Providers() {
  const { me } = useAuth();
  const isPlatform = me?.persona === "platform";
  const [rows, setRows] = useState<Provider[] | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ counterpartyType: "company", scope: "external" as Scope, legalName: "", taxNumber: "", serviceType: "", primaryPhone: "", primaryEmail: "" });
  const isCompany = f.counterpartyType === "company";

  const load = useCallback(async () => {
    const r = await api.get<{ providers: Provider[] }>("/providers");
    setRows(r.providers);
  }, []);
  useEffect(() => {
    setRows(null);
    load().catch((e) => { setErr((e as Error).message); setRows([]); });
  }, [load]);

  const counts = useMemo(() => ({
    all: rows?.length ?? 0,
    internal: rows?.filter((r) => r.scope === "internal").length ?? 0,
    external: rows?.filter((r) => r.scope === "external").length ?? 0,
  }), [rows]);
  const visible = (rows ?? []).filter((r) => filter === "all" || r.scope === filter);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await api.post("/providers", {
        counterpartyType: f.counterpartyType,
        scope: f.scope,
        legalName: f.legalName,
        serviceType: f.serviceType || undefined,
        taxNumber: isCompany ? f.taxNumber || undefined : undefined,
        primaryPhone: f.primaryPhone || undefined,
        primaryEmail: f.primaryEmail || undefined,
      });
      setF({ counterpartyType: "company", scope: "external", legalName: "", taxNumber: "", serviceType: "", primaryPhone: "", primaryEmail: "" });
      setShow(false);
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function setStatus(id: string, status: string) {
    setErr("");
    try { await api.post(`/providers/${id}/status`, { status }); await load(); }
    catch (e) { setErr((e as Error).message); }
  }

  const tabs: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "internal", label: "Internal" },
    { key: "external", label: "External" },
  ];

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="Internal & external service providers"
        actions={isPlatform ? (
          <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
            <Plus className="h-4 w-4" /> New provider
          </button>
        ) : undefined}
      />

      {show && isPlatform && (
        <Card className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Field label="Type">
              <div className="flex gap-2">
                {(["company", "individual"] as const).map((t) => (
                  <button key={t} type="button" onClick={() => setF({ ...f, counterpartyType: t })}
                    className={`btn btn-sm flex-1 rounded-md ${f.counterpartyType === t ? "btn-primary" : ""}`}>
                    {t === "company" ? "Company" : "Individual"}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Scope">
              <select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as Scope })}>
                <option value="external">External partner</option>
                <option value="internal">Internal team</option>
              </select>
            </Field>
            <Field label={isCompany ? "Legal name" : "Full name"}>
              <input className="input" value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} placeholder={isCompany ? "SMSA Express" : "Ahmed Al-Otaibi"} />
            </Field>
            {isCompany ? (
              <Field label="Tax number (required)">
                <input className="input" value={f.taxNumber} onChange={(e) => setF({ ...f, taxNumber: e.target.value })} placeholder="3xxxxxxxxxxxxx3" />
              </Field>
            ) : (
              <Field label="Mobile (required)">
                <input className="input" value={f.primaryPhone} onChange={(e) => setF({ ...f, primaryPhone: e.target.value })} placeholder="05xxxxxxxx" />
              </Field>
            )}
            <Field label="Service">
              <input className="input" value={f.serviceType} onChange={(e) => setF({ ...f, serviceType: e.target.value })} placeholder="Shipping / Inspection…" />
            </Field>
            <Field label="Email">
              <input className="input" value={f.primaryEmail} onChange={(e) => setF({ ...f, primaryEmail: e.target.value })} placeholder="b2b@smsa.sa" />
            </Field>
            <div className="flex items-end">
              <button className="btn-primary mb-3 w-full rounded-md" disabled={busy || f.legalName.trim().length < 2 || (isCompany ? !f.taxNumber : !f.primaryPhone)}>
                {busy ? "Creating…" : "Create provider"}
              </button>
            </div>
          </form>
          {err && <div className="text-[13px] text-accent">{err}</div>}
        </Card>
      )}

      <div className="mb-3 flex items-center gap-1.5">
        {tabs.map((t) => (
          <button key={t.key} className={`btn btn-sm rounded-md ${filter === t.key ? "btn-primary" : ""}`} onClick={() => setFilter(t.key)}>
            {t.label} <span className="text-faint tnum">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      <Card pad={false}>
        {rows === null ? (
          <Spinner />
        ) : visible.length === 0 ? (
          <EmptyState title="No providers yet" hint={isPlatform ? "Add your first service provider." : "No providers linked to this workspace."} />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Provider</th>
                <th className="th">Type</th>
                <th className="th">Scope</th>
                <th className="th">Service</th>
                <th className="th">Contact</th>
                <th className="th">Status</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="trow">
                  <td className="td font-medium text-ink">{p.legal_name}</td>
                  <td className="td"><Badge tone={p.counterparty_type === "company" ? "gray" : "amber"}>{p.counterparty_type}</Badge></td>
                  <td className="td text-muted">{p.scope}</td>
                  <td className="td text-muted">{p.service_type ?? "—"}</td>
                  <td className="td text-muted">{p.primary_email ?? p.primary_phone ?? "—"}</td>
                  <td className="td">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                      {p.activation_status === "pending" && <Badge tone="amber">pending activation</Badge>}
                    </div>
                  </td>
                  <td className="td text-right">
                    {isPlatform && (p.status === "active" ? (
                      <button className="btn btn-sm rounded-md text-accent" onClick={() => setStatus(p.id, "suspended")}>Suspend</button>
                    ) : (
                      <button className="btn btn-sm rounded-md" onClick={() => setStatus(p.id, "active")}>Reactivate</button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
