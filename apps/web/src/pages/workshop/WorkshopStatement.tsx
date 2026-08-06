import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, StatStrip, StatCard, Spinner, EmptyState } from "../../components/ui";

/**
 * STATEMENT — invoiced minus credited, per workspace. Deliberately only what the ledger actually
 * holds: invoices and credit notes are real records here; a "payments received" column would be
 * fiction until a payments table exists, so there isn't one.
 */
interface Row { workspace: string; invoiced: string; credited: string; invoice_count: number }

export default function WorkshopStatement() {
  const [d, setD] = useState<{ rows: Row[]; totals: { invoiced: number; credited: number } } | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.get<{ rows: Row[]; totals: { invoiced: number; credited: number } }>("/workshop/statement")
      .then(setD)
      .catch((e) => { setErr((e as Error).message); setD({ rows: [], totals: { invoiced: 0, credited: 0 } }); });
  }, []);

  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;
  const balance = d.totals.invoiced - d.totals.credited;

  return (
    <>
      <PageHeader title="Statement & Payments" subtitle="What was invoiced, what was credited back, and the balance" />
      {err && <div className="mb-3 text-[13px] text-accent">{err}</div>}
      <StatStrip>
        <StatCard label="Invoiced" value={d.totals.invoiced.toFixed(2)} hint="SAR incl. VAT" />
        <StatCard label="Credited" value={d.totals.credited.toFixed(2)} hint="SAR credit notes" />
        <StatCard label="Balance" value={balance.toFixed(2)} tone={balance > 0 ? "accent" : "ink"} hint="SAR outstanding" />
      </StatStrip>
      <Card pad={false} className="mt-4">
        {d.rows.length === 0 ? (
          <EmptyState title="Nothing invoiced yet" hint="The statement fills in as invoices are issued on your orders." />
        ) : (
          <table className="w-full">
            <thead><tr>
              <th className="th">Workspace</th><th className="th">Invoices</th>
              <th className="th">Invoiced</th><th className="th">Credited</th><th className="th">Balance</th>
            </tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.workspace} className="trow">
                  <td className="td font-medium text-ink">{r.workspace}</td>
                  <td className="td tnum">{r.invoice_count}</td>
                  <td className="td tnum">{Number(r.invoiced).toFixed(2)}</td>
                  <td className="td tnum">{Number(r.credited).toFixed(2)}</td>
                  <td className="td tnum font-medium text-ink">{(Number(r.invoiced) - Number(r.credited)).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
