import { sql } from "drizzle-orm";
import type { Tx } from "../../db/db.service.js";

/**
 * RECORD CONDITIONS — QNEW-89 §4.1.
 *
 * A gate asks about a record's children. A condition asks about the record itself: "is this an
 * insurance customer", "is this a pickup". It is the mechanism behind the owner's own example —
 * *"when a new request comes in, decide its type: insurance customer or not"* — where the same status
 * leads down two different paths depending on who is paying.
 *
 * `workflow_transitions.condition` has been stored, round-tripped and frozen since the engine was
 * built, and evaluated by nothing. This is the evaluator.
 *
 * THE FIELD LIST IS A CATALOG, for the same reason the gate list is: an admin choosing "Who pays"
 * from a dropdown cannot name a column that does not exist, or one that would leak. Adding a field
 * is a line here.
 *
 * `{}` MEANS ALWAYS. Every transition ever written carries `{}`, so an unconditional move stays
 * unconditional and nothing changes meaning when this ships.
 */

export interface ConditionField {
  key: string;
  labelEn: string;
  labelAr: string;
  type: "enum" | "number" | "text";
  options?: string[];
  /** Which record kinds carry it. A condition on an order line's payer makes no sense. */
  entities: Array<"rfq" | "order">;
  /** Where it lives, so the fact-gatherer can read it in one query per record. */
  column: string;
}

export const CONDITION_FIELDS: ConditionField[] = [
  {
    key: "payer_type",
    labelEn: "Who pays",
    labelAr: "مين الدافع",
    type: "enum",
    options: ["cash_client", "credit_client", "insurance"],
    entities: ["rfq"],
    column: "payer_type",
  },
  {
    key: "order_type",
    labelEn: "Order type",
    labelAr: "نوع الطلب",
    type: "enum",
    options: ["regular", "bulk"],
    entities: ["rfq"],
    column: "order_type",
  },
  {
    key: "delivery_type",
    labelEn: "Delivery or pickup",
    labelAr: "توصيل أم استلام",
    type: "enum",
    options: ["delivery", "pickup"],
    entities: ["rfq"],
    column: "delivery_type",
  },
];

const FIELD_BY_KEY = new Map(CONDITION_FIELDS.map((f) => [f.key, f]));
export const conditionFieldByKey = (k: string) => FIELD_BY_KEY.get(k);

export type Op = "eq" | "ne" | "gt" | "lt" | "in";
export interface Clause { field: string; op: Op; value: unknown }
/** `{}` = always. `{all:[…]}` = every clause. `{any:[…]}` = at least one. No nesting, on purpose. */
export interface Condition { all?: Clause[]; any?: Clause[] }

export const isEmptyCondition = (c: Condition | null | undefined) =>
  !c || (!c.all?.length && !c.any?.length);

/**
 * Read the facts a condition can be judged against.
 *
 * One query per record rather than one per clause — a transition with three conditions should not
 * cost three round trips. RLS scopes it; no tenant filter belongs here.
 */
export async function gatherFacts(
  tx: Tx,
  entity: string,
  id: string,
): Promise<Record<string, unknown>> {
  // Both an rfq_item and an rfq answer questions about the REQUEST that owns them, so a line
  // inherits its header's facts. Without this a condition on payer_type could never be evaluated on
  // the line-level moves, which is where most of the work actually happens.
  const source =
    entity === "rfq" ? sql`select * from rfqs where id = ${id}::uuid`
    : entity === "rfq_item" ? sql`select r.* from rfqs r join rfq_items i on i.rfq_id = r.id where i.id = ${id}::uuid`
    : entity === "order" ? sql`select r.* from rfqs r join orders o on o.rfq_id = r.id where o.id = ${id}::uuid`
    : entity === "order_item" ? sql`select r.* from rfqs r join orders o on o.rfq_id = r.id join order_items oi on oi.order_id = o.id where oi.id = ${id}::uuid`
    : null;
  if (!source) return {};
  const [row] = (await tx.execute(source)) as Array<Record<string, unknown>>;
  return row ?? {};
}

function test(clause: Clause, facts: Record<string, unknown>): boolean {
  const f = conditionFieldByKey(clause.field);
  // FAIL CLOSED on an unknown field. Everywhere else in this engine absence is permissive, but a
  // condition someone deliberately wrote and we cannot read is different: silently passing a rule
  // because of a typo is the dangerous direction.
  if (!f) return false;
  const actual = facts[f.column];
  switch (clause.op) {
    case "eq": return String(actual ?? "") === String(clause.value ?? "");
    case "ne": return String(actual ?? "") !== String(clause.value ?? "");
    case "gt": return Number(actual) > Number(clause.value);
    case "lt": return Number(actual) < Number(clause.value);
    case "in": return Array.isArray(clause.value) && clause.value.map(String).includes(String(actual ?? ""));
    default: return false;
  }
}

export function evaluate(cond: Condition | null | undefined, facts: Record<string, unknown>): boolean {
  if (isEmptyCondition(cond)) return true;
  if (cond!.all?.length && !cond!.all.every((c) => test(c, facts))) return false;
  if (cond!.any?.length && !cond!.any.some((c) => test(c, facts))) return false;
  return true;
}

/** The same sentence the builder shows while authoring, so what you approve is what you wrote. */
export function describe(cond: Condition | null | undefined): string {
  if (isEmptyCondition(cond)) return "always";
  const one = (c: Clause) => {
    const f = conditionFieldByKey(c.field);
    const label = f?.labelEn ?? c.field;
    const v = Array.isArray(c.value) ? c.value.join(" or ") : String(c.value);
    const op =
      c.op === "eq" ? "is" : c.op === "ne" ? "is not"
      : c.op === "gt" ? "is more than" : c.op === "lt" ? "is less than" : "is one of";
    return `${label} ${op} ${String(v).replace(/_/g, " ")}`;
  };
  const parts: string[] = [];
  if (cond!.all?.length) parts.push(cond!.all.map(one).join(" and "));
  if (cond!.any?.length) parts.push(`(${cond!.any.map(one).join(" or ")})`);
  return parts.join(" and ");
}
