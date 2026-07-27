/**
 * run-digest.ts — run the daily failure digest NOW, once, for every workspace.
 *
 * The scheduler in WorkflowDigestService is what makes the job daily; this is the same pass, driven
 * by hand. It exists for two reasons and neither of them is "instead of the timer":
 *
 *   • guard-check.sh has to assert what the digest DOES without waiting for midnight, and the
 *     behaviour worth asserting — the window, the grouping, the refusal to report a day twice — is
 *     in runOnce(), not in setInterval. Driving it over HTTP would have meant adding a route whose
 *     only caller was the test, which is a worse thing to ship than a script.
 *   • an operator who has just brought the API back up after a long outage can see the catch-up
 *     happen rather than waiting fifteen minutes to find out whether it will.
 *
 * IT IS SAFE TO RUN AT ANY TIME, and that is a property of the design rather than of this file:
 * every pass claims its day in workflow_failure_digests before telling anybody anything, so running
 * this while the server's own timer fires cannot deliver the same digest twice.
 *
 * The services are constructed directly rather than through a Nest context because none of them
 * needs one — DbService reads its URL from the environment and NotificationsService needs only the
 * transaction it is handed. Nothing here arms a timer: onApplicationBootstrap is a lifecycle hook
 * Nest calls, and Nest is not running.
 *
 * Prints one line per workspace/environment pass, then a summary line guard-check.sh reads.
 */
import "reflect-metadata";
import { DbService } from "../src/db/db.service.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { WorkflowDigestService } from "../src/modules/workflow/digest.service.js";

const db = new DbService();
const digest = new WorkflowDigestService(db, new NotificationsService(db));

const results = await digest.runOnce();
for (const r of results)
  console.log(`${r.tenant}/${r.environment}: ${r.result} failures=${r.failures} recipients=${r.recipients}`);

const sent = results.filter((r) => r.result === "sent");
console.log(
  `SUMMARY sent=${sent.length} notified=${sent.reduce((n, r) => n + r.recipients, 0)} ` +
    `failures=${sent.reduce((n, r) => n + r.failures, 0)}`,
);

await db.onModuleDestroy();
