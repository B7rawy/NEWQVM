import { sql } from "drizzle-orm";
import type { Tx } from "../../db/db.service.js";

/**
 * EXIT GATES — QNEW-89 §4.
 *
 * A gate answers "is the business actually ready for this move", which is a question about the
 * record's CHILDREN, not about the record. "Confirm the order" is not really available because
 * someone has permission; it is available once every line has a price.
 *
 * THE CATALOG IS CODE, NOT AN EXPRESSION LANGUAGE. An admin picking "every line must be priced" from
 * a list cannot write a query that is wrong, slow, or reaches into another tenant's data. Adding a
 * new kind of gate costs a function here — the right trade for a builder aimed at people who run a
 * parts business rather than people who write SQL.
 *
 * EVERY GATE RETURNS A REASON, NOT A BOOLEAN. A disabled button that says "cannot proceed" sends
 * someone hunting; one that says "2 of 5 lines are not priced: GP-114, GP-880" is a work instruction.
 * That is why `check` returns `detail` and `offending` and not just `pass`.
 *
 * RLS DOES THE TENANT SCOPING. Every query here runs inside the caller's transaction, so the same
 * policies that scope the record scope its children — no gate needs (or should have) a tenant filter
 * of its own.
 */

export type GateEnforcement = "block" | "warn_override";

export interface GateResult {
  pass: boolean;
  /** One sentence a person can act on. Rendered on the disabled button. */
  detail: string;
  /** The specific things standing in the way — part numbers, line ids, values. */
  offending: string[];
}

export interface GateParam {
  key: string;
  labelEn: string;
  /** `status` renders a status picker; the rest are plain inputs. */
  type: "status" | "number" | "percent" | "money" | "enum";
  options?: string[];
  default?: unknown;
}

export interface GateDef {
  key: string;
  labelEn: string;
  labelAr: string;
  /** What it guards against, in the builder, so the choice is informed. */
  helpEn: string;
  params: GateParam[];
  /** Which record kinds it can be attached to. A gate over lines is meaningless on a line. */
  entities: Array<"rfq" | "order">;
  /** Sensible enforcement for this KIND of rule — see the note on warn_override below. */
  defaultEnforcement: GateEnforcement;
  check(tx: Tx, entity: string, id: string, params: Record<string, unknown>): Promise<GateResult>;
}

/** rfqs hold rfq_items; orders hold order_items. One place to resolve it. */
function childTable(entity: string): { table: string; fk: string; join: string } | null {
  if (entity === "rfq") return { table: "rfq_items", fk: "rfq_id", join: "rfq_items" };
  if (entity === "order") return { table: "order_items", fk: "order_id", join: "order_items" };
  return null;
}

export const GATES: GateDef[] = [
  {
    key: "all_items_at_status",
    labelEn: "Every line has reached a status",
    labelAr: "كل الأصناف وصلت لحالة معيّنة",
    helpEn:
      "Blocks the move until every line is at (or past) the chosen status. Cancelled and unavailable " +
      "lines are ignored — otherwise one dead line holds the whole order forever.",
    params: [{ key: "status", labelEn: "Every line must be at", type: "status" }],
    entities: ["rfq", "order"],
    defaultEnforcement: "block",
    async check(tx, entity, id, params) {
      const c = childTable(entity);
      if (!c) return { pass: true, detail: "not applicable to this record", offending: [] };
      const want = String(params.status ?? "");

      // EXCLUDING TERMINAL LINES IS THE WHOLE POINT. A cancelled line will never reach 'priced', so
      // counting it means the order can never be confirmed — the same class of bug as the
      // confirmed-cancelled-item defect fixed on 25/07.
      const rows = (await tx.execute(sql`
        select ${sql.raw(entity === "rfq" ? "ci.part_number" : "ci.final_part_number")} as label,
               s.code as status
        from ${sql.raw(c.table)} ci
        left join item_statuses s on s.id = ci.status_id
        where ci.${sql.raw(c.fk)} = ${id}::uuid
          and coalesce(s.code, '') <> ${want}
          and coalesce(s.code, '') not in ('cancelled', 'unavailable')`)) as Array<{
        label: string | null; status: string | null;
      }>;

      const total = (await tx.execute(sql`
        select count(*)::int as n from ${sql.raw(c.table)} where ${sql.raw(c.fk)} = ${id}::uuid`)) as Array<
        { n: number }
      >;

      if (rows.length === 0) return { pass: true, detail: `all ${total[0]?.n ?? 0} lines are ${want}`, offending: [] };
      return {
        pass: false,
        detail: `${rows.length} of ${total[0]?.n ?? 0} lines are not ${want} yet`,
        offending: rows.map((r) => `${r.label ?? "line"} (${r.status ?? "no status"})`),
      };
    },
  },

  {
    key: "min_quotes_per_item",
    labelEn: "Enough vendor quotes per line",
    labelAr: "عدد كافٍ من عروض المورّدين لكل صنف",
    helpEn:
      "Holds the move until every line has at least N quotes, so a winner is picked from a real " +
      "comparison rather than the first vendor who answered.",
    params: [{ key: "n", labelEn: "Quotes required per line", type: "number", default: 3 }],
    entities: ["rfq"],
    // Deliberately warn_override: a strict count stalls urgent orders in a thin market, and a gate
    // that blocks work people know is fine is a gate they route around.
    defaultEnforcement: "warn_override",
    async check(tx, entity, id, params) {
      if (entity !== "rfq") return { pass: true, detail: "only applies to requests", offending: [] };
      const need = Number(params.n ?? 3);
      const rows = (await tx.execute(sql`
        select ri.part_number as label,
               (select count(*)::int from rfq_vendor_items vi where vi.rfq_item_id = ri.id) as quotes
        from rfq_items ri
        left join item_statuses s on s.id = ri.status_id
        where ri.rfq_id = ${id}::uuid
          and coalesce(s.code, '') not in ('cancelled', 'unavailable')`)) as Array<{
        label: string | null; quotes: number;
      }>;
      const short = rows.filter((r) => r.quotes < need);
      if (short.length === 0)
        return { pass: true, detail: `every line has at least ${need} quotes`, offending: [] };
      return {
        pass: false,
        detail: `${short.length} line(s) have fewer than ${need} quotes`,
        offending: short.map((r) => `${r.label ?? "line"} (${r.quotes})`),
      };
    },
  },

  {
    key: "min_margin_pct",
    labelEn: "Minimum margin on every line",
    labelAr: "حد أدنى للهامش على كل صنف",
    helpEn:
      "Stops an order going through with a line priced below the margin you accept. Margin is " +
      "(selling price − winning cost) measured against the basis you choose.",
    params: [
      { key: "pct", labelEn: "Minimum margin %", type: "percent", default: 5 },
      { key: "basis", labelEn: "Measured against", type: "enum", options: ["cost", "agency_price", "selling_price"], default: "cost" },
    ],
    entities: ["rfq", "order"],
    defaultEnforcement: "warn_override",
    async check(tx, entity, id, params) {
      if (entity !== "rfq") return { pass: true, detail: "only applies to requests", offending: [] };
      const pct = Number(params.pct ?? 5);
      const basis = String(params.basis ?? "cost");
      const basisCol =
        basis === "agency_price" ? sql`ri.agency_price`
        : basis === "selling_price" ? sql`ri.selling_price`
        : sql`vi.offered_cost`;

      // A line with no price yet is NOT a margin failure — that is what all_items_at_status is for.
      // Reporting it here too would blame the wrong gate and send someone to the wrong screen.
      const rows = (await tx.execute(sql`
        select ri.part_number as label,
               round((((ri.selling_price - vi.offered_cost) / nullif(${basisCol}, 0)) * 100)::numeric, 1) as margin
        from rfq_items ri
        left join item_statuses s on s.id = ri.status_id
        left join rfq_vendor_items vi on vi.id = ri.winning_vendor_quote_item_id
        where ri.rfq_id = ${id}::uuid
          and coalesce(s.code, '') not in ('cancelled', 'unavailable')
          and ri.selling_price is not null and vi.offered_cost is not null
          and (((ri.selling_price - vi.offered_cost) / nullif(${basisCol}, 0)) * 100) < ${pct}`)) as Array<{
        label: string | null; margin: string | null;
      }>;

      if (rows.length === 0) return { pass: true, detail: `every priced line clears ${pct}%`, offending: [] };
      return {
        pass: false,
        detail: `${rows.length} line(s) are below the ${pct}% margin`,
        offending: rows.map((r) => `${r.label ?? "line"} (${r.margin ?? "?"}%)`),
      };
    },
  },

  {
    key: "total_over",
    labelEn: "Order value is above an amount",
    labelAr: "قيمة الطلب أعلى من مبلغ",
    helpEn:
      "Use it to send only the big orders down a different path — an approval step, a second " +
      "signature. It passes when the total is above the amount.",
    params: [{ key: "amount", labelEn: "Amount (SAR)", type: "money", default: 5000 }],
    entities: ["rfq"],
    defaultEnforcement: "block",
    async check(tx, entity, id, params) {
      if (entity !== "rfq") return { pass: true, detail: "only applies to requests", offending: [] };
      const amount = Number(params.amount ?? 0);
      const [row] = (await tx.execute(sql`
        select coalesce(sum(ri.selling_price * ri.quantity), 0)::float8 as total
        from rfq_items ri
        left join item_statuses s on s.id = ri.status_id
        where ri.rfq_id = ${id}::uuid and coalesce(s.code, '') not in ('cancelled', 'unavailable')`)) as Array<
        { total: number }
      >;
      const total = row?.total ?? 0;
      return total > amount
        ? { pass: true, detail: `total ${total} is above ${amount}`, offending: [] }
        : { pass: false, detail: `total is ${total}, which is not above ${amount}`, offending: [] };
    },
  },
];

const BY_KEY = new Map(GATES.map((g) => [g.key, g]));
export const gateByKey = (k: string) => BY_KEY.get(k);

export interface GateConfig {
  gate: string;
  params?: Record<string, unknown>;
  enforcement?: GateEnforcement;
}

export interface GateFailure {
  gate: string;
  label: string;
  detail: string;
  offending: string[];
  enforcement: GateEnforcement;
}

/**
 * Run every gate on a transition and report ALL failures, not just the first.
 *
 * Reporting one at a time turns configuring a workflow into whack-a-mole: you fix the pricing, press
 * the button, and discover the margin rule. One pass, one complete answer.
 *
 * An UNKNOWN gate key fails closed. Absence of configuration is permissive by design everywhere in
 * this engine, but a gate someone deliberately wrote and we cannot evaluate is a different thing —
 * silently passing a money rule because of a typo is the dangerous direction.
 */
export async function runGates(
  tx: Tx,
  entity: string,
  id: string,
  configs: GateConfig[],
): Promise<GateFailure[]> {
  const failures: GateFailure[] = [];
  for (const cfg of configs) {
    const def = gateByKey(cfg.gate);
    if (!def) {
      failures.push({
        gate: cfg.gate,
        label: cfg.gate,
        detail: `this workflow uses a rule this server does not know ('${cfg.gate}')`,
        offending: [],
        enforcement: "block",
      });
      continue;
    }
    if (!def.entities.includes(entity as "rfq" | "order")) continue;
    const r = await def.check(tx, entity, id, cfg.params ?? {});
    if (!r.pass)
      failures.push({
        gate: def.key,
        label: def.labelEn,
        detail: r.detail,
        offending: r.offending,
        enforcement: cfg.enforcement ?? def.defaultEnforcement,
      });
  }
  return failures;
}
