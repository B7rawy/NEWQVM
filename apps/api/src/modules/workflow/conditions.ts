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
  //
  // EVERY DOCUMENT IN THE CHAIN ANSWERS FOR THE REQUEST IT CAME FROM, and leaving them out was not a
  // harmless omission. A condition on an entity this function could not resolve got `{}`, and the
  // evaluator fails closed on a missing fact — so the move was refused for ever, silently. The
  // shipped standard flow contains `return` and `credit_note_issued`, and returns.service.ts drives
  // a RETURN document across that arrow: an admin who wrote "only when the payer is insurance" on it
  // — the most natural thing to do with this feature — would have blocked every credit note in the
  // workspace, insurance or not, with a refusal naming a rule that could never be true.
  //
  // All of these hang off an order, and an order hangs off the request, so the facts are one more
  // join away rather than genuinely unavailable.
  const viaOrder = (table: string) => sql`
    select r.* from rfqs r
    join orders o on o.rfq_id = r.id
    join ${sql.raw(table)} d on d.order_id = o.id
    where d.id = ${id}::uuid`;
  const source =
    entity === "rfq" ? sql`select * from rfqs where id = ${id}::uuid`
    : entity === "rfq_item" ? sql`select r.* from rfqs r join rfq_items i on i.rfq_id = r.id where i.id = ${id}::uuid`
    : entity === "order" ? sql`select r.* from rfqs r join orders o on o.rfq_id = r.id where o.id = ${id}::uuid`
    : entity === "order_item" ? sql`select r.* from rfqs r join orders o on o.rfq_id = r.id join order_items oi on oi.order_id = o.id where oi.id = ${id}::uuid`
    : entity === "return" ? viaOrder("returns")
    : entity === "invoice" ? viaOrder("invoices")
    : entity === "delivery" ? viaOrder("deliveries")
    : entity === "credit_note" ? viaOrder("credit_notes")
    : entity === "purchase_order" ? viaOrder("purchase_orders")
    // rfq_vendor is the one that genuinely cannot answer: a vendor invitation belongs to the
    // request but the vendor-domain flow governs the INVITATION, and asking "who pays" about it is
    // a question about a different record. The editor does not offer these fields there.
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

/**
 * WHICH RECORDS THIS FLOW TAKES, as a sentence — the flow-selection counterpart of describe().
 *
 * It lives here, beside describe(), because a flow's `selection_condition` has THREE states and only
 * one of them is a condition. describe() alone would render the other two wrongly and dangerously:
 * `null` means "never chosen automatically", and isEmptyCondition(null) is true, so describe(null)
 * says "always" — the exact opposite. A screen that printed that would tell an admin a flow captures
 * every record when in fact it captures none.
 *
 * THE DEFAULT IS NOT DESCRIBED BY ITS CONDITION AT ALL, because the engine does not select it by
 * one: bindOnEntry ranks the conditional flows and falls back to the default when none matched. So
 * the honest sentence for the default is what it actually is.
 *
 * NEITHER IS A HANDOFF FLOW, AND LEAVING IT OUT OF THE SIGNATURE MADE THIS FUNCTION LIE. `entry_mode`
 * was added by 0066 as a THIRD answer to "how do records get here", and a sub-flow carries no
 * selection condition precisely because nothing selects it — so a function that could only see
 * `null` reported a live, correctly-routed sub-flow as "nothing — no routing set, so it is never
 * chosen". Both halves of that sentence are false: it is chosen constantly, by being handed records,
 * and not being in the selection race IS its routing.
 *
 * `is_default` is tested FIRST because that is the order the ENGINE resolves in: selectableFlows()
 * drops handoff flows from the candidate list but reads the fallback off `is_default` alone, so a
 * flow carrying both flags really would capture newborn records. That combination is now refused at
 * creation and at routing (workflow.service.ts), but a row predating those refusals must still be
 * described as what it does rather than as what it was meant to do.
 */
export function describeSelection(
  isDefault: boolean,
  cond: Condition | null | undefined,
  entryMode?: string | null,
): string {
  if (isDefault) return "any record no other flow claims";
  if (entryMode === "handoff") return "only records another workflow hands to it";
  if (cond === null || cond === undefined) return "nothing — no routing set, so it is never chosen";
  if (isEmptyCondition(cond)) return "every record";
  return describe(cond);
}
