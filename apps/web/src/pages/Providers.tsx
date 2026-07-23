import { useMemo, useState } from "react";
import { Plus, Handshake } from "lucide-react";
import { PageHeader, Card, Badge, statusTone, EmptyState, Field } from "../components/ui";

/**
 * Service providers — internal (Qparts' own service teams) and external (third-party partners).
 * Frontend-first: the structure/UX lives here now; the /providers API is wired underneath in a
 * later step (matches how Vendors/Workshops were built). Rows below are illustrative sample data.
 */
type Scope = "internal" | "external";
interface Provider {
  id: string;
  name: string;
  scope: Scope;
  service: string;
  contact: string;
  status: string;
}

const SAMPLE: Provider[] = [
  { id: "p1", name: "Qparts Logistics", scope: "internal", service: "Delivery & fulfillment", contact: "ops@qparts.co", status: "active" },
  { id: "p2", name: "Qparts Pricing Desk", scope: "internal", service: "Pricing & sourcing", contact: "pricing@qparts.co", status: "active" },
  { id: "p3", name: "Qparts Inspection Unit", scope: "internal", service: "Parts inspection", contact: "qa@qparts.co", status: "active" },
  { id: "p4", name: "SMSA Express", scope: "external", service: "Shipping", contact: "b2b@smsa.sa", status: "active" },
  { id: "p5", name: "Aramex", scope: "external", service: "Shipping", contact: "corp@aramex.com", status: "active" },
  { id: "p6", name: "Najm Services", scope: "external", service: "Insurance & claims", contact: "partners@najm.sa", status: "suspended" },
];

type Filter = "all" | Scope;

export default function Providers() {
  const [rows, setRows] = useState<Provider[]>(SAMPLE);
  const [filter, setFilter] = useState<Filter>("all");
  const [show, setShow] = useState(false);
  const [f, setF] = useState({ name: "", scope: "internal" as Scope, service: "", contact: "" });

  const counts = useMemo(
    () => ({
      all: rows.length,
      internal: rows.filter((r) => r.scope === "internal").length,
      external: rows.filter((r) => r.scope === "external").length,
    }),
    [rows],
  );
  const visible = filter === "all" ? rows : rows.filter((r) => r.scope === filter);

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!f.name.trim()) return;
    setRows((prev) => [
      { id: `p${Date.now()}`, name: f.name.trim(), scope: f.scope, service: f.service.trim(), contact: f.contact.trim(), status: "active" },
      ...prev,
    ]);
    setF({ name: "", scope: "internal", service: "", contact: "" });
    setShow(false);
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
        actions={
          <button className="btn-primary rounded-md" onClick={() => setShow((v) => !v)}>
            <Plus className="h-4 w-4" /> New provider
          </button>
        }
      />

      {/* Internal ⇄ External segmented filter */}
      <div className="mb-4 flex items-center gap-1 text-[13px] font-medium">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={`rounded-md px-3 py-1.5 transition ${
              filter === t.key ? "bg-accent-50 text-accent" : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-faint tnum">{counts[t.key]}</span>
          </button>
        ))}
      </div>

      {show && (
        <Card className="mb-5">
          <form onSubmit={create} className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <Field label="Name">
              <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Fleet Couriers Co." />
            </Field>
            <Field label="Scope">
              <select className="input" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as Scope })}>
                <option value="internal">Internal</option>
                <option value="external">External</option>
              </select>
            </Field>
            <Field label="Service">
              <input className="input" value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })} placeholder="Delivery / Inspection / …" />
            </Field>
            <Field label="Contact">
              <input className="input" value={f.contact} onChange={(e) => setF({ ...f, contact: e.target.value })} placeholder="email or phone" />
            </Field>
            <div className="md:col-span-4">
              <button className="btn-primary rounded-md" disabled={!f.name.trim()}>
                Add provider
              </button>
            </div>
          </form>
        </Card>
      )}

      <Card pad={false}>
        {visible.length === 0 ? (
          <EmptyState icon={<Handshake className="h-6 w-6" />} title="No providers here" hint="Add a service provider to get started." />
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Provider</th>
                <th className="th">Scope</th>
                <th className="th">Service</th>
                <th className="th">Contact</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.id} className="trow">
                  <td className="td font-medium text-ink">{p.name}</td>
                  <td className="td">
                    <Badge tone={p.scope === "internal" ? "blue" : "gray"}>{p.scope}</Badge>
                  </td>
                  <td className="td text-muted">{p.service || "—"}</td>
                  <td className="td text-muted">{p.contact || "—"}</td>
                  <td className="td">
                    <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="mt-3 text-[12px] text-faint">
        Preview — sample data. This screen is wired to the providers API in a later step.
      </p>
    </>
  );
}
