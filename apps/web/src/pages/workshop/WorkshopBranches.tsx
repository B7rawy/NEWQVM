import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PageHeader, Card, Badge, Spinner, EmptyState } from "../../components/ui";

interface Branch { id: string; name: string; workshop: string; region: string | null; order_category: string }
interface Data { branches: Branch[]; workspaces: string[] }

export default function WorkshopBranches() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.get<Data>("/workshop/branches").then(setD).catch((e) => setErr((e as Error).message));
  }, []);
  if (!d) return err ? <div className="text-[13px] text-accent">{err}</div> : <Spinner />;

  return (
    <>
      <PageHeader title="Branches" subtitle="Your workshop branches and the workspaces you work with." />
      <Card className="mb-5">
        <h3 className="mb-2 text-[13px] font-semibold text-ink">Workspaces you work with</h3>
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
      <Card pad={false}>
        <div className="border-b border-line-2 px-5 py-3 text-[14px] font-semibold text-ink">Branches</div>
        {d.branches.length === 0 ? (
          <EmptyState title="No branches" hint="Your workshop branches will appear here." />
        ) : (
          <table className="w-full">
            <thead>
              <tr><th className="th">Branch</th><th className="th">Workshop</th><th className="th">Region</th><th className="th">Type</th></tr>
            </thead>
            <tbody>
              {d.branches.map((b) => (
                <tr key={b.id} className="trow">
                  <td className="td font-medium text-ink">{b.name}</td>
                  <td className="td text-muted">{b.workshop}</td>
                  <td className="td text-muted">{b.region ?? "—"}</td>
                  <td className="td"><Badge tone="gray">{b.order_category}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
