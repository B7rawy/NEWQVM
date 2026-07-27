import type { PageRef } from "./workflow.service.js";

/**
 * THE STANDARD FLOW — the workflow every workspace arrives with.
 *
 * WHY IT IS CODE AND NOT A ROW. It is a TRANSCRIPTION of what this application actually does: every
 * arrow below corresponds to a status move some endpoint performs today. That makes it reviewable
 * the way the gate catalog (gates.ts) and the action catalog (actions.ts) are reviewable — a change
 * to it is a diff somebody reads, next to the service line it claims to describe. A seed row would
 * be a copy of the product's behaviour that nothing keeps honest, editable into a shape the product
 * cannot perform, and silently different in every database it was inserted into.
 *
 * WHY IT MUST BE COMPLETE. The guard in status.service.ts is ASYMMETRIC (assertTransitionAllowed,
 * :515 vs :529/:574): if a record's current status has no step in the flow the move is allowed, but
 * once the from-status IS a step, leaving it for anything that is not a drawn arrow THROWS. So
 * including a status is what switches enforcement on for everything that leaves it. A template that
 * draws 'delivered' but forgets delivered -> return stops every return in the workspace. Every
 * status listed here therefore arrives with ALL of its outgoing moves, or it is not listed at all.
 *
 * ONE ITEM FLOW SERVES FIVE ENTITIES. The flow lookup filters on status_domain only — no
 * entity_type — and the database enforces one default per domain (workflow_flows_default_uq). So
 * rfq, rfq_item, order, order_item and the `return` document all execute the SAME graph, and what
 * is drawn below is their UNION. That is why 'confirmed' has four outgoing arrows belonging to
 * three different record kinds: -> delivered is an order line, -> invoice_issued is an order
 * header, -> return is a partially-delivered order line, -> cancelled is all of them.
 *
 * STATUSES DELIBERATELY ABSENT. Fifteen item statuses and eleven vendor statuses exist in the
 * catalog that NO code path ever writes (extract_pn, tendering, sent_to_vendor, processing,
 * pending_invoice, settled, …). Drawing them would be theatre: a step nothing can ever occupy, and
 * — worse — a step the activation check demands an exit from. cancellation_request and
 * return_request are absent for a stronger reason: QNEW-89 moved "somebody has asked to cancel" out
 * of the status column into workflow_exceptions precisely so the record keeps its real status while
 * the request is reviewed.
 */

export interface TemplateStep {
  /** status CODE from the governed catalog — resolved to an id at provisioning time. */
  status: string;
  isEntry?: boolean;
  isTerminal?: boolean;
  x: number;
  y: number;
  /**
   * Which screens this status belongs on. NOT decoration — routing.ts turns it into a WHERE
   * predicate, and the safety rule there is that a status routed NOWHERE shows on every page while
   * a status routed ANYWHERE is filtered off every page it was not routed to. That makes partial
   * placement dangerous and complete placement safe, so each entry below is derived rather than
   * guessed: a status is placed on exactly the pages that list an entity able to hold it
   * (pages.ts `entities` x the record kinds in the transcription above).
   */
  pages: PageRef[];
}

export interface TemplateMove {
  from: string;
  to: string;
  labelEn: string;
  labelAr: string;
  /** The endpoint that performs this move, so the next reader can check the claim. */
  performedBy: string;
}

export interface FlowTemplate {
  flowKey: string;
  nameEn: string;
  nameAr: string;
  statusDomain: "item" | "vendor";
  steps: TemplateStep[];
  moves: TemplateMove[];
}

/**
 * OWNER ROLES ARE EMPTY ON EVERY STEP, AND THAT IS A DECISION, NOT AN OMISSION.
 *
 * Two independent reasons, either of which is sufficient:
 *
 *   1. owner_roles is a PERMISSION. assertTransitionAllowed refuses anybody who does not hold one
 *      of them to move the record out of that step. A template cannot know how a workspace has
 *      divided its desks, so any value here would refuse real work in some workspace on day one.
 *   2. Activation REFUSES an owner role nobody in the workspace holds (workflow.service.ts:1376).
 *      The membership vocabulary includes purchasing and part_extractor, but a workspace typically
 *      staffs company_admin / branch_manager / service_advisor — so a template naming the role that
 *      matches the product's language would simply fail to provision.
 *
 * An empty list is silence, not denial: everybody who can reach the endpoint can still make the
 * move. A workspace that wants desks assigns them by publishing a new version.
 *
 * TemplateStep therefore has no ownerRoles field at all — there is nothing to forget to set, and
 * adding one is a deliberate act that has to answer both objections above.
 */

const page = (p: string, mode: "action" | "watch" | "optional" = "action"): PageRef => ({
  page: p,
  mode,
  afterHours: null,
});

/** Screens that list RFQ headers. A request status belongs on both or on neither. */
const REQUEST_SCREENS: PageRef[] = [page("rfqs"), page("workshop_requests", "watch")];
/** Screens that list ORDER headers — including the vendor's own view of the business it won. */
const ORDER_SCREENS: PageRef[] = [
  page("orders"),
  page("workshop_orders", "watch"),
  page("vendor_confirmed", "watch"),
];

/**
 * THE ITEM FLOW — requests, their lines, orders, order lines, and the return document.
 *
 * Entry is new_rfq. Orders are BORN at 'confirmed' and never pass through new_rfq, which is fine
 * for two separate reasons: bindOnEntry deliberately ignores is_entry (status.service.ts:411-416),
 * and the activation reachability check is satisfied because 'confirmed' is reachable from new_rfq
 * along new_rfq -> priced -> confirmed.
 */
const ITEM_FLOW: FlowTemplate = {
  flowKey: "standard",
  nameEn: "Standard flow",
  nameAr: "المسار القياسي",
  statusDomain: "item",
  steps: [
    { status: "new_rfq", isEntry: true, x: 80, y: 100, pages: REQUEST_SCREENS },
    { status: "priced", x: 340, y: 100, pages: REQUEST_SCREENS },
    { status: "sent_insurance_approval", x: 600, y: 100, pages: REQUEST_SCREENS },
    { status: "insurance_approved", x: 860, y: 100, pages: REQUEST_SCREENS },
    // 'confirmed' is held by the request AND by the order it became, so it sits on both sets of
    // screens. Dropping it from the request screens would make every confirmed RFQ disappear from
    // /rfqs, which is the exact "a wrong placement hides live work" failure routing.ts warns about.
    {
      status: "confirmed",
      x: 1120,
      y: 100,
      pages: [page("rfqs", "watch"), page("workshop_requests", "watch"), ...ORDER_SCREENS],
    },
    { status: "delivered", x: 80, y: 300, pages: ORDER_SCREENS },
    { status: "invoice_issued", x: 340, y: 300, pages: ORDER_SCREENS },
    { status: "return", x: 600, y: 300, pages: ORDER_SCREENS },
    // A credit note is settled between the workspace and the workshop; the vendor's screen has no
    // part in it, so it is not routed there.
    {
      status: "credit_note_issued",
      isTerminal: true,
      x: 860,
      y: 300,
      pages: [page("orders"), page("workshop_orders", "watch")],
    },
    // Nothing is DONE to a cancelled record, so it is `watch` everywhere it still has to be visible.
    {
      status: "cancelled",
      isTerminal: true,
      x: 1120,
      y: 300,
      pages: [
        page("rfqs", "watch"),
        page("workshop_requests", "watch"),
        page("orders", "watch"),
        page("workshop_orders", "watch"),
        page("vendor_confirmed", "watch"),
      ],
    },
  ],
  moves: [
    {
      from: "new_rfq", to: "priced", labelEn: "Winning quote picked", labelAr: "اعتماد أفضل عرض",
      // The line goes new_rfq -> priced DIRECTLY. Nothing in the product ever writes tendering,
      // sent_to_vendor or ready_for_quotation, so drawing those as intermediate steps would refuse
      // this move on the first click.
      performedBy: "POST /api/rfqs/:id/items/:itemId/winning-quote (vendor-rfq.service.ts:283)",
    },
    {
      from: "new_rfq", to: "sent_insurance_approval", labelEn: "Send to insurer", labelAr: "إرسال للتأمين",
      performedBy: "POST /api/rfqs/:id/insurance/send-for-approval (insurance.service.ts:117)",
    },
    {
      from: "new_rfq", to: "confirmed", labelEn: "Confirm request", labelAr: "تأكيد الطلب",
      performedBy: "POST /api/rfqs/:id/confirm (orders.service.ts:106)",
    },
    {
      from: "new_rfq", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "priced", to: "confirmed", labelEn: "Confirm request", labelAr: "تأكيد الطلب",
      performedBy: "POST /api/rfqs/:id/confirm (orders.service.ts:107)",
    },
    {
      from: "priced", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "sent_insurance_approval", to: "insurance_approved",
      labelEn: "Insurer approved", labelAr: "موافقة شركة التأمين",
      performedBy: "POST /api/rfqs/:id/insurance/approve (insurance.service.ts:117)",
    },
    {
      from: "sent_insurance_approval", to: "confirmed",
      labelEn: "Confirm without waiting for the insurer", labelAr: "تأكيد دون انتظار التأمين",
      // DRAWN BECAUSE THE PRODUCT DOES IT, not because it is a good idea. confirm() looks at nothing
      // about the insurance state — only assertRfqNotConfirmed runs — and this was verified live:
      // POST /api/rfqs/:id/confirm from sent_insurance_approval returns 201. Omitting the arrow
      // would not stop the bypass being a bypass; it would break it the moment the flow went live,
      // which is a product change smuggled in as a drawing. Deleting this one line and resetting is
      // how a workspace decides otherwise.
      performedBy: "POST /api/rfqs/:id/confirm (orders.service.ts:106)",
    },
    {
      from: "sent_insurance_approval", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "insurance_approved", to: "confirmed", labelEn: "Confirm request", labelAr: "تأكيد الطلب",
      performedBy: "POST /api/rfqs/:id/confirm (orders.service.ts:106)",
    },
    {
      from: "insurance_approved", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "confirmed", to: "delivered", labelEn: "Delivered in full", labelAr: "تم التسليم بالكامل",
      // A PARTIAL delivery moves nothing (delivery.service.ts:87-89) — the line only leaves
      // 'confirmed' when the cumulative delivered quantity reaches approved_qty.
      performedBy: "POST /api/orders/:id/deliveries (delivery.service.ts:90)",
    },
    {
      from: "confirmed", to: "invoice_issued", labelEn: "Invoice issued", labelAr: "إصدار الفاتورة",
      // The order HEADER never reaches 'delivered' — only its lines do — so the invoice arrow
      // leaves 'confirmed'. An invoice drawn out of 'delivered' would refuse every invoice.
      performedBy: "POST /api/orders/:id/invoice (invoice.service.ts:138)",
    },
    {
      from: "confirmed", to: "return", labelEn: "Return raised", labelAr: "تسجيل مرتجع",
      // The same button as delivered -> return, on a PARTIALLY delivered line. The cap at
      // returns.service.ts:66 is on quantity, not on status, so a line still at 'confirmed' can be
      // returned — verified live.
      performedBy: "POST /api/orders/:id/returns (returns.service.ts:95)",
    },
    {
      from: "confirmed", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "delivered", to: "return", labelEn: "Return raised", labelAr: "تسجيل مرتجع",
      // Reached two ways: the returns endpoint, and a return EXCEPTION being approved. There is no
      // delivered -> cancelled arrow because the product refuses it: 'delivered' is in
      // DELIVERED_ONWARDS (exceptions.service.ts:44), which answers "raise a return instead".
      performedBy: "POST /api/orders/:id/returns (returns.service.ts:95); exceptions.service.ts:183",
    },
    {
      from: "invoice_issued", to: "return", labelEn: "Return raised", labelAr: "تسجيل مرتجع",
      // The order header's only onward move. A return may only be raised from DELIVERED_ONWARDS,
      // and 'invoice_issued' is the only one of those four an order header ever reaches.
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "return", to: "credit_note_issued", labelEn: "Credit note issued", labelAr: "إصدار إشعار الخصم",
      // ONE arrow, TWO record kinds. The `returns` row was born at 'return' via a raw INSERT
      // (returns.service.ts:81) rather than through enter(), so it has no workflow_record_state
      // binding and falls back to this same default item flow. Drawing it once is correct.
      performedBy: "POST /api/returns/:returnId/credit-note (returns.service.ts:177 and :178)",
    },
    {
      from: "return", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      // 'return' is NOT in DELIVERED_ONWARDS, so a cancellation is accepted mid-return.
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "credit_note_issued", to: "cancelled", labelEn: "Cancellation approved", labelAr: "اعتماد الإلغاء",
      // Also not in DELIVERED_ONWARDS, so a line whose credit note is already out can still be
      // cancelled. Drawn because the product allows it, not because it reads tidily.
      performedBy: "POST /api/workflow/exceptions/:id/resolve (exceptions.service.ts:183)",
    },
    {
      from: "cancelled", to: "credit_note_issued", labelEn: "Credit note issued", labelAr: "إصدار إشعار الخصم",
      // A line cancelled AFTER its return was raised still gets its credit note: transitionMany
      // reads no from-status and moves the line from wherever it is. Verified live. This is why
      // 'cancelled' being terminal does not mean "no arrows out" — is_terminal exempts a step from
      // the must-have-an-exit check; it does not forbid one.
      performedBy: "POST /api/returns/:returnId/credit-note (returns.service.ts:178)",
    },
  ],
};

/**
 * THE VENDOR FLOW — the invitation a vendor is sent, quotes on, and wins.
 *
 * A workspace with only an item flow leaves every rfq_vendor move ungoverned, because the flow
 * lookup is per status_domain and rfq_vendors speak the vendor vocabulary.
 *
 * Nothing ever enters this flow through the gateway: vendor-rfq.service.ts:84 inserts rfq_vendors
 * with the 'rfq' status id by hand, so there is no status_logs row and no binding, and the first
 * real move (rfq -> priced) resolves against the workspace's active default. That is exactly what
 * this flow has to be — the entry step is 'rfq' because that is where every invitation starts,
 * even though nothing announces the arrival.
 */
const VENDOR_FLOW: FlowTemplate = {
  flowKey: "standard-vendor",
  nameEn: "Standard vendor flow",
  nameAr: "مسار المورّد القياسي",
  statusDomain: "vendor",
  steps: [
    { status: "rfq", isEntry: true, x: 80, y: 100, pages: [page("vendor_quotations")] },
    { status: "priced", x: 340, y: 100, pages: [page("vendor_quotations")] },
    // Kept on the quotations screen as `watch` as well as on its own: a won invitation is still an
    // invitation, and dropping it from the list the vendor already reads would remove rows that
    // are visible today.
    {
      status: "confirmed", isTerminal: true, x: 600, y: 100,
      pages: [page("vendor_quotations", "watch"), page("vendor_confirmed")],
    },
  ],
  moves: [
    {
      from: "rfq", to: "priced", labelEn: "Quote submitted", labelAr: "تم تقديم العرض",
      // Both the emailed token link and the logged-in vendor portal funnel through the one
      // writeQuoteItems path. A revised quote is a self-transition and writes nothing.
      performedBy: "POST /api/quote-access/:token/quote or /api/vendor-portal/quotations/:id/quote (vendor-rfq.service.ts:218)",
    },
    {
      from: "priced", to: "confirmed", labelEn: "Business won", labelAr: "ترسية الطلب",
      // Only the WINNING vendors' invitations advance. Losing invitations are left at 'priced'
      // forever — nothing in the product moves them, so no arrow leaves 'priced' for them.
      performedBy: "POST /api/rfqs/:id/confirm (orders.service.ts:117)",
    },
  ],
};

export const STANDARD_FLOWS: FlowTemplate[] = [ITEM_FLOW, VENDOR_FLOW];

export const templateFor = (domain: "item" | "vendor"): FlowTemplate => {
  const t = STANDARD_FLOWS.find((f) => f.statusDomain === domain);
  if (!t) throw new Error(`no standard flow is defined for the '${domain}' domain`);
  return t;
};

/**
 * The four structural rules activation imposes (workflow.service.ts:1320-1364), checked HERE at
 * import time as well as there at activation time.
 *
 * The reason for the duplicate is the failure it prevents: activation runs per workspace, so a
 * template edited into an unactivatable shape would deploy green, provision nothing, and surface as
 * "this one workspace has no workflow" weeks later in whichever workspace was created next. Failing
 * at process start turns that into a boot failure on the machine of whoever made the edit.
 */
function assertTemplateSound(t: FlowTemplate): void {
  const errs: string[] = [];
  const codes = new Set<string>();
  for (const s of t.steps) {
    if (codes.has(s.status)) errs.push(`step '${s.status}' appears twice`);
    codes.add(s.status);
  }
  const entries = t.steps.filter((s) => s.isEntry);
  if (entries.length !== 1) errs.push(`exactly one entry step is required (found ${entries.length})`);
  if (!t.steps.some((s) => s.isTerminal)) errs.push("no terminal step — records could never finish");

  const out = new Map<string, string[]>();
  for (const m of t.moves) {
    if (!codes.has(m.from)) errs.push(`move from '${m.from}', which is not a step`);
    if (!codes.has(m.to)) errs.push(`move to '${m.to}', which is not a step`);
    if (m.from === m.to) errs.push(`move '${m.from}' -> itself does nothing`);
    out.set(m.from, [...(out.get(m.from) ?? []), m.to]);
  }
  const pairs = new Set<string>();
  for (const m of t.moves) {
    const k = `${m.from}>${m.to}`;
    // The database is stricter than it looks: workflow_transitions_edge_uq is unique on
    // (flow_id, from_step_id, to_step_id, priority) and every move here is priority 0.
    if (pairs.has(k)) errs.push(`two moves '${m.from}' -> '${m.to}' would collide on priority 0`);
    pairs.add(k);
  }
  for (const s of t.steps) {
    if (!s.isTerminal && !out.has(s.status))
      errs.push(`step '${s.status}' is not terminal and has no way out — records would stall there`);
  }
  if (entries.length === 1) {
    const seen = new Set([entries[0].status]);
    const queue = [entries[0].status];
    while (queue.length) {
      for (const n of out.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
    }
    for (const s of t.steps) {
      if (!seen.has(s.status)) errs.push(`step '${s.status}' cannot be reached from the entry step`);
    }
  }
  if (errs.length) throw new Error(`the standard '${t.flowKey}' flow is not activatable: ${errs.join("; ")}`);
}

for (const t of STANDARD_FLOWS) assertTemplateSound(t);
