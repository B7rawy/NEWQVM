/**
 * reevaluate-reentrancy.ts — proves the third lever of QNEW-90 item 5: SYSTEM-ACTOR WRITES NEVER
 * RE-TRIGGER RULES.
 *
 * StatusService.reevaluate() is the one door through which a change in the world (a quote landing, a
 * delivery being recorded) reopens the rules on a record. The lever is that the ENGINE may not walk
 * through it: an action runs at autoDepth ≥ 1 by construction, so anything it reaches for is refused,
 * and a `set_field` write can never be handed back to the engine as if it were a fresh business
 * event. That matters because reevaluate() starts a pass at whatever depth it is given — a
 * re-evaluation reachable from inside an action run would reset the budget on every lap and
 * MAX_AUTO_DEPTH would never see the loop it exists to stop.
 *
 * WHY THIS IS A SCRIPT AND NOT AN HTTP CHECK. The refusal is a precondition on a method, and no
 * request can produce a context that is already inside an action run — that is the whole point of the
 * guard. Driving it over HTTP would mean asserting on a path that cannot be reached, i.e. asserting
 * nothing. So the service is constructed directly and handed a transaction that executes nothing and
 * counts what it was asked to do. The observable is exact: at depth 0 it goes and looks, and above
 * it, it does not touch the database at all.
 *
 * Its one dependency — the notification boundary the `notify` action delivers through — is stubbed
 * rather than built, because nothing on this path can reach it: reevaluate() either refuses outright
 * or looks for arrows, and neither branch runs an action.
 *
 * Prints two words for guard-check.sh: what it did at depth 0, then at depth 1.
 */
import "reflect-metadata";
import { StatusService } from "../src/common/status.service.js";

const calls: unknown[] = [];
/** Records every statement it is asked to run and runs none of them. */
const tx = { execute: async (q: unknown) => { calls.push(q); return [] as unknown[]; } };

const svc = new StatusService({
  sendInApp: async () => {
    throw new Error("reevaluate() must never deliver a notification");
  },
} as never);
const base = { tenantId: "00000000-0000-0000-0000-0000000000aa", userId: null };
const id = "00000000-0000-0000-0000-0000000000bb";

// A real-world event: the caller is a request, not the engine. It must go and look.
await svc.reevaluate(tx as never, { ...base, autoDepth: 0 }, "rfq", [id]);
const atDepthZero = calls.length > 0 ? "looked" : "refused";

// The engine talking to itself — the depth an action always runs at. It must not look.
calls.length = 0;
await svc.reevaluate(tx as never, { ...base, autoDepth: 1 }, "rfq", [id]);
const insideAnActionRun = calls.length > 0 ? "looked" : "refused";

console.log(`${atDepthZero} ${insideAnActionRun}`);
