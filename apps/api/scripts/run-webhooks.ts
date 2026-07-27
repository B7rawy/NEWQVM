/**
 * run-webhooks.ts — drive ONE webhook dispatch pass now, for every workspace and both environments.
 *
 * The ticker in WorkflowWebhookDispatchService is what makes delivery continuous; this is the same
 * pass, driven by hand. It is the sibling of run-digest.ts and exists for the same two reasons,
 * neither of which is "instead of the timer":
 *
 *   • guard-check.sh has to assert what the dispatcher DOES — that a failure is retried, that the
 *     retries stop, that a dead delivery reaches the run log — without waiting out a backoff
 *     schedule that spans eleven hours. All of that behaviour is in runOnce(), not in setInterval.
 *     Driving it over HTTP would have meant adding a route whose only caller was the test, which is
 *     a worse thing to ship than a script.
 *   • an operator who has just brought the API back up after an outage can watch the backlog drain
 *     rather than waiting thirty seconds to find out whether it will.
 *
 * IT IS SAFE TO RUN WHILE THE SERVER'S OWN TICKER IS RUNNING, and that is a property of the claim
 * rather than of this file: rows are taken with `for update skip locked` and their next attempt is
 * pushed into the future in the same committed statement, so the worst a concurrent pass can do is
 * find nothing left to do. That is the same protection that makes pm2 with two instances safe.
 *
 * The service is constructed directly rather than through a Nest context because it needs nothing
 * from one — DbService reads its URL from the environment. Nothing here arms a timer:
 * onApplicationBootstrap is a lifecycle hook Nest calls, and Nest is not running.
 *
 * Prints one line per workspace that had work, then a summary line guard-check.sh reads.
 */
import "reflect-metadata";
import { DbService } from "../src/db/db.service.js";
import { WorkflowWebhookDispatchService } from "../src/modules/workflow/webhook-dispatch.service.js";

const db = new DbService();
const dispatcher = new WorkflowWebhookDispatchService(db);

const results = await dispatcher.runOnce();
// Only the workspaces that had something due. A line per workspace per environment on every run
// would bury the one that mattered under a page of "nothing to do", which is how a log stops
// being read.
for (const r of results.filter((r) => r.claimed > 0))
  console.log(
    `${r.tenant}/${r.environment}: claimed=${r.claimed} delivered=${r.delivered} ` +
      `retrying=${r.retrying} dead=${r.dead}`,
  );

const total = (pick: (r: (typeof results)[number]) => number) => results.reduce((n, r) => n + pick(r), 0);
console.log(
  `SUMMARY claimed=${total((r) => r.claimed)} delivered=${total((r) => r.delivered)} ` +
    `retrying=${total((r) => r.retrying)} dead=${total((r) => r.dead)}`,
);

await db.onModuleDestroy();
