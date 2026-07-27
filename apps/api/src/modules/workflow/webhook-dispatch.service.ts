import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, type Tx } from "../../db/db.service.js";
import type { Environment } from "../../common/env-guards.js";
import {
  postGuarded,
  PUBLIC_ONLY,
  validateWebhookUrl,
  WebhookRefusedError,
} from "./webhook-url.js";

/**
 * THE WEBHOOK DISPATCHER — QNEW-90 item 3, the half of the webhook action that touches the network.
 *
 * The action does not send. It writes a row to workflow_webhook_outbox inside the caller's business
 * transaction and returns, which is what makes "the receiver was told about something that then
 * rolled back" impossible rather than unlikely (see the header of migration 0064). Everything that
 * actually opens a socket is here, and it runs LATER, on its own, from a transaction that has
 * already committed.
 *
 * ── IT IS THE DIGEST'S TICKER, NOT A SECOND STYLE OF ONE ────────────────────────────────────────
 * WorkflowDigestService got here first and settled the questions this job would otherwise have to
 * answer again, so the shape is deliberately the same one: a single setInterval armed in
 * onApplicationBootstrap and cleared in onModuleDestroy, unref'd so a background job is never the
 * reason a process refuses to exit; a `running` flag so a slow pass is not joined by the next tick;
 * a try/catch around the whole pass because an interval callback that throws is an unhandled
 * rejection, and nothing about the product should stop because a background job could not run; one
 * transaction and one try/catch per workspace, so one workspace's problem does not stop the next
 * workspace's deliveries; and a runOnce() that is public because a script (scripts/run-webhooks.ts)
 * has to be able to drive exactly this without waiting for a clock.
 *
 * ── A TICK IS NOT A SEND, AND A RESTART LOSES NOTHING ───────────────────────────────────────────
 * The digest's tick asks each workspace whether its day has rolled over. This one asks each
 * workspace what is DUE — rows whose next_attempt_at has passed — and almost always the answer is
 * nothing. The state that decides is entirely in the table, never in this process, which is what
 * makes a restart a non-event: a delivery queued thirty seconds before a deploy is picked up by
 * whatever process comes back, and one that was mid-flight when the process died is simply due
 * again after its backoff.
 *
 * ── AT LEAST ONCE, NEVER EXACTLY ONCE, AND THE RECEIVER IS TOLD SO ──────────────────────────────
 * The digest could promise exactly-once reporting because a unique key made a second attempt at the
 * same day impossible. Nothing can make that promise across a network: a receiver that processes a
 * request and then fails to answer is indistinguishable, from here, from one that never got it, and
 * the only safe thing to do with that ambiguity is retry. So every delivery carries a stable
 * delivery id — the outbox row's own id, identical on every attempt — and the scheme documented in
 * migration 0064 tells whoever builds the receiving end to de-duplicate on it. Claiming otherwise
 * would be the more comfortable lie.
 */

/** How often the tick asks what is due. Overridable so a test does not have to wait. */
const TICK_MS = Number(process.env.WORKFLOW_WEBHOOK_TICK_MS ?? 30_000);

/**
 * How long to wait after each failed attempt, in seconds.
 *
 * THE SHAPE IS "SOON, THEN GIVE UP SLOWLY". The first retry is a minute away because the commonest
 * failure by far is a receiver that was restarting, and a minute later it is back. The last is six
 * hours away because by then the failure is not transient and the only thing more attempts buy is
 * load on somebody else's broken service. The whole schedule spans a little over eleven hours,
 * which is chosen to be longer than a night: a receiver that broke at 9pm and was fixed at 8am gets
 * its deliveries, and one that is still broken at lunchtime has a real problem that retrying will
 * not solve.
 *
 * ITS LENGTH IS THE ATTEMPT CEILING. There is no second constant to disagree with it: a row is
 * dead once it has been attempted BACKOFF_SECONDS.length times, so adding a step to this array is
 * the only way to change how long the system keeps trying.
 */
const BACKOFF_SECONDS = [60, 300, 900, 3_600, 10_800, 21_600] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/**
 * How many rows one workspace-environment pass will claim.
 *
 * BOUNDED BECAUSE A PASS IS SEQUENTIAL AND THE THING IT WAITS FOR IS SOMEBODY ELSE'S SERVER. Twenty
 * five deliveries against a receiver that is timing out is twenty five times the total timeout, and
 * the next workspace in the loop is waiting behind it. A backlog is not lost by this bound — the
 * remaining rows are still due and the next tick takes the next batch — it is merely spread, which
 * is the correct behaviour for a queue that nobody is watching in real time.
 */
const BATCH = 25;

/** The headers a receiver verifies. Named here so the service, the tests and migration 0064's
 *  written-out scheme cannot drift into disagreeing about the spelling. */
export const HEADER_DELIVERY = "x-qvm-delivery";
export const HEADER_TIMESTAMP = "x-qvm-timestamp";
export const HEADER_SIGNATURE = "x-qvm-signature";

/** What one pass did, in the language the log line and the guard both read. */
export interface DispatchOutcome {
  tenant: string;
  environment: Environment;
  claimed: number;
  delivered: number;
  retrying: number;
  dead: number;
}

/**
 * The bytes that go on the wire, and the headers that authenticate them.
 *
 * ── THE SCHEME ──────────────────────────────────────────────────────────────────────────────────
 *     X-QVM-Signature: v1=hex( HMAC_SHA256( secret, timestamp + "." + rawBody ) )
 *
 * WHY THE TIMESTAMP IS INSIDE THE SIGNED MESSAGE rather than merely sent beside it: if it were only
 * a header, an attacker who captured one request could replay it with any timestamp they liked and
 * the signature would still verify, so the receiver's freshness check would be checking a number
 * nobody had authenticated. Binding it makes the pair inseparable — change the timestamp and the
 * signature stops matching.
 *
 * WHY THE BODY IS BUILT ONCE HERE and handed to the sender as a string: a receiver verifies against
 * the RAW bytes it read, and JSON.stringify is not guaranteed to produce the same bytes twice
 * across versions or through a re-parse. Serialising in one place and signing exactly what is sent
 * removes the whole class of "the signature is wrong and the payload looks identical" bug.
 *
 * `v1=` is a version tag, not decoration. It is what lets a future scheme be introduced by sending
 * two headers for a while instead of by breaking every receiver on the same afternoon.
 *
 * EXPORTED because scripts/prove-webhook-delivery.ts asserts what a real receiver would compute
 * against a real listener. The alternative — the test writing its own HMAC — would assert that two
 * pieces of test code agree, which is not the property anybody cares about.
 */
export function signDelivery(
  secret: string,
  deliveryId: string,
  payload: unknown,
  nowMs: number = Date.now(),
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "QVM-Workflow/1",
      // Nothing about our records belongs in a receiver's cache or in an intermediary's log.
      "cache-control": "no-store",
      [HEADER_DELIVERY]: deliveryId,
      [HEADER_TIMESTAMP]: timestamp,
      [HEADER_SIGNATURE]: `v1=${signature}`,
    },
  };
}

/**
 * The verification a receiver performs, written here so the test can prove the scheme round-trips
 * and so there is one executable answer to "how do I check this" beside the prose in migration 0064.
 *
 * NOTHING IN THE API CALLS THIS. It is the other end of the conversation, kept next to the code that
 * produces what it consumes, because a signing scheme whose verifier lives only in a comment is a
 * scheme nobody can be sure works.
 *
 * timingSafeEqual, not `===`. Comparing HMACs with a short-circuiting comparison leaks, one byte at
 * a time, how much of a guess was right — which is enough to forge a signature without ever knowing
 * the secret.
 */
export function verifyDelivery(
  secret: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  nowMs: number = Date.now(),
  toleranceSeconds = 300,
): { ok: true } | { ok: false; reason: string } {
  const timestamp = headers[HEADER_TIMESTAMP];
  const presented = headers[HEADER_SIGNATURE];
  if (!timestamp || !presented) return { ok: false, reason: "the delivery carried no signature" };
  const skew = Math.abs(Math.floor(nowMs / 1000) - Number(timestamp));
  // Without this the signature is valid forever, so a captured request is a permanent licence to
  // repeat whatever it said.
  if (!Number.isFinite(skew) || skew > toleranceSeconds)
    return { ok: false, reason: `the timestamp is ${skew}s away from now` };
  const expected = Buffer.from(
    `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`,
  );
  const given = Buffer.from(presented);
  if (expected.length !== given.length) return { ok: false, reason: "the signature is the wrong shape" };
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: "the signature does not match" };
}

/** One claimed row, as the sender needs it. */
interface ClaimedDelivery {
  id: string;
  url: string;
  payload: unknown;
  attempts: number;
  transition_key: string | null;
  entity_type: string;
  entity_id: string;
}

@Injectable()
export class WorkflowWebhookDispatchService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("WorkflowWebhooks");
  private timer: NodeJS.Timeout | null = null;
  /** A pass that overruns its interval must not be joined by the next one. Not a substitute for
   *  `for update skip locked`, which is what protects a SECOND PROCESS — this keeps one process
   *  from opening two sockets for the same row. */
  private running = false;

  constructor(private readonly dbService: DbService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // unref() so the dispatcher is never the reason node stays alive. A killed process is how a
    // half-recorded delivery happens, and the way to avoid being killed is to not hang a shutdown.
    this.timer.unref();
    this.logger.log(`webhook dispatcher armed — checking every ${Math.round(TICK_MS / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const o of await this.runOnce()) {
        if (o.claimed === 0) continue;
        this.logger.log(
          `webhooks — ${o.tenant} (${o.environment}): ${o.delivered} delivered, ` +
            `${o.retrying} to retry, ${o.dead} gave up`,
        );
      }
    } catch (e) {
      this.logger.error(`webhook pass failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass over every workspace, in both environments. Public because the scheduler is not the
   * only legitimate caller: scripts/run-webhooks.ts drives exactly this, which is how the behaviour
   * is asserted without waiting for a clock.
   */
  async runOnce(): Promise<DispatchOutcome[]> {
    // `tenants` is globally readable (its policy is `using (true)`), so this needs no tenant
    // context — and must not have one, because it is asking about all of them. Same read the digest
    // opens with, for the same reason.
    const tenants = (await this.dbService.withContext(
      { tenantId: null, userId: null, isInternal: false },
      (tx) => tx.execute(sql`select id, slug from tenants where is_active order by slug`),
    )) as Array<{ id: string; slug: string }>;

    const results: DispatchOutcome[] = [];
    for (const t of tenants) {
      for (const environment of ["live", "sandbox"] as const) {
        try {
          results.push(await this.runForWorkspace(t.id, t.slug, environment));
        } catch (e) {
          this.logger.error(`webhooks for ${t.slug} (${environment}) failed: ${(e as Error).message}`);
        }
      }
    }
    return results;
  }

  /**
   * Claim what is due for one workspace, send it, and record what happened.
   *
   * THREE TRANSACTIONS PER DELIVERY, AND THE SPLIT IS THE DESIGN. Claiming commits before any
   * socket is opened, so no database transaction is ever held across a network call — a receiver
   * that hangs for its full timeout would otherwise hold one of ten pooled connections for that
   * long, and twenty five of them would take the API down while nobody was looking. Recording the
   * result is its own transaction afterwards.
   *
   * The cost of that split is the only honest one available: a process killed between the send and
   * the record has delivered something it did not write down, and will send it again after the
   * backoff. That is the at-least-once contract stated at the top of this file, and it is why the
   * delivery id is stable across attempts.
   */
  private async runForWorkspace(
    tenantId: string,
    slug: string,
    environment: Environment,
  ): Promise<DispatchOutcome> {
    const claimed = await this.claim(tenantId, environment);
    const outcome: DispatchOutcome = {
      tenant: slug,
      environment,
      claimed: claimed.length,
      delivered: 0,
      retrying: 0,
      dead: 0,
    };
    if (!claimed.length) return outcome;

    const secret = await this.secretFor(tenantId, environment);

    for (const row of claimed) {
      const attempt = await this.send(row, secret);
      const terminal = !attempt.ok && row.attempts >= MAX_ATTEMPTS;
      await this.record(tenantId, environment, row, attempt, terminal);
      if (attempt.ok) outcome.delivered++;
      else if (terminal) outcome.dead++;
      else outcome.retrying++;
    }
    return outcome;
  }

  /**
   * Take ownership of what is due, in ONE statement.
   *
   * `for update skip locked` is what makes two API processes safe — which is not hypothetical, it is
   * what pm2 with more than one instance produces. The loser of a race skips the row rather than
   * blocking on it, so the two processes divide the batch instead of serialising behind each other.
   *
   * THE ATTEMPT IS COUNTED AND THE BACKOFF APPLIED HERE, BEFORE THE SEND, not after it. A process
   * that dies mid-request has therefore already recorded that it tried, so the row comes back round
   * once and eventually dies, instead of being retried forever by a series of processes that each
   * crash before they can write anything down.
   */
  private async claim(tenantId: string, environment: Environment): Promise<ClaimedDelivery[]> {
    // Interpolated with sql.raw because a CASE arm cannot be a bound parameter. Every value comes
    // from BACKOFF_SECONDS, a literal in this file — nothing here has ever been near a request.
    const schedule = sql.raw(
      BACKOFF_SECONDS.map((seconds, i) => `when o.attempts = ${i} then ${seconds}`).join(" "),
    );
    return this.dbService.withContext(
      { tenantId, userId: null, isInternal: false, environment },
      async (tx) =>
        (await tx.execute(sql`
          update workflow_webhook_outbox o
             set attempts        = o.attempts + 1,
                 next_attempt_at = now() + make_interval(secs =>
                   (case ${schedule} else ${BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1]} end)),
                 updated_at      = now()
           where o.id in (
             select d.id from workflow_webhook_outbox d
              where d.tenant_id = ${tenantId}::uuid
                and d.environment = ${environment}::environment_type
                and d.status = 'pending'
                and d.next_attempt_at <= now()
              order by d.next_attempt_at
              limit ${BATCH}
              for update skip locked)
          returning o.id, o.url, o.payload, o.attempts, o.transition_key,
                    o.entity_type::text as entity_type, o.entity_id`)) as unknown as ClaimedDelivery[],
    );
  }

  /**
   * This workspace's signing key, minted if it has never had one.
   *
   * INSERT-ON-CONFLICT-DO-NOTHING then SELECT, rather than "select, and insert if missing": two
   * processes reaching a brand new workspace at the same moment would both find nothing and both
   * insert, and the unique key would fail one of their whole passes. Here the loser's insert is a
   * no-op and both read the same row.
   *
   * The INSERT names only the workspace and the environment. The value comes from the column
   * default, which is the database's own CSPRNG — see migration 0064 for why nothing in this system
   * is allowed to choose it.
   */
  private async secretFor(tenantId: string, environment: Environment): Promise<string> {
    return this.dbService.withContext(
      { tenantId, userId: null, isInternal: false, environment },
      async (tx) => {
        await tx.execute(sql`
          insert into workflow_webhook_secrets (tenant_id, environment)
          values (${tenantId}::uuid, ${environment}::environment_type)
          on conflict (tenant_id, environment) do nothing`);
        const [row] = (await tx.execute(sql`
          select secret from workflow_webhook_secrets
          where tenant_id = ${tenantId}::uuid and environment = ${environment}::environment_type`)) as
          Array<{ secret: string }>;
        if (!row) throw new Error("this workspace has no webhook signing secret");
        return row.secret;
      },
    );
  }

  /**
   * One attempt. Never throws — every way this can go wrong is a sentence somebody has to read.
   *
   * THE URL IS VALIDATED AGAIN HERE, not merely trusted from the row. The action checked it when
   * the flow was saved, and between then and now the row has sat in a table that a hand-fix on a
   * live database can reach. Re-checking costs a microsecond and closes the gap between "the code
   * that writes this column validates" and "this column is validated".
   */
  private async send(
    row: ClaimedDelivery,
    secret: string,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const verdict = validateWebhookUrl(row.url);
    if (!verdict.ok) return { ok: false, status: null, error: `refused: ${verdict.reason}` };

    const { body, headers } = signDelivery(secret, row.id, row.payload);
    try {
      const response = await postGuarded(verdict.url, body, headers, PUBLIC_ONLY);
      if (response.status >= 200 && response.status < 300)
        return { ok: true, status: response.status, error: null };
      // A 3xx is a failure with a specific cure, and saying which saves an afternoon: node:https
      // does not follow redirects and this system will not add that, because a check on the first
      // URL is worth nothing if hop two can be http://169.254.169.254. See postGuarded's header.
      if (response.status >= 300 && response.status < 400)
        return {
          ok: false,
          status: response.status,
          error:
            `the receiver answered ${response.status} — redirects are not followed, so the ` +
            `destination must be the final https URL`,
        };
      return {
        ok: false,
        status: response.status,
        error: `the receiver answered ${response.status}: ${response.body.slice(0, 200).replace(/\s+/g, " ").trim()}`,
      };
    } catch (e) {
      // "we would not call that" and "we called it and it did not answer" are different problems
      // for different people, so they are different sentences rather than one generic failure.
      const error = e as Error;
      return {
        ok: false,
        status: null,
        error:
          error instanceof WebhookRefusedError
            ? `refused: ${error.message}`
            : `could not reach it: ${error.message}`.slice(0, 300),
      };
    }
  }

  /**
   * Write down what happened, and — when it was the last attempt — put it where somebody will see
   * it without going to look.
   *
   * A DEAD DELIVERY IS RECORDED IN THE RUN LOG, NOT IN A THIRD PLACE. workflow_action_runs is
   * already the answer to "what did the engine do and did it work", the run-log screen already
   * renders it, and WorkflowDigestService already sweeps it every day and tells the workspace's
   * managers about the failures. Giving webhooks their own alerting would mean a workspace had two
   * places to look and no rule about which one was authoritative.
   *
   * IT IS FILED UNDER 'webhook_delivery', NOT 'webhook', AND THE DISTINCTION IS LOAD-BEARING.
   * `webhook` is the action a move ran: it validated a destination and queued a row, and it either
   * did that or it did not. This is a separate act by a background job minutes or hours later. Two
   * consequences follow, both wanted:
   *   • the daily ceiling counts what a FLOW did (refuseOverDailyCap filters on the catalog key), so
   *     a workspace's allowance is spent by queueing deliveries and not a second time by their
   *     outcome — otherwise a run of failures would silently halve the cap it had configured;
   *   • the run log tells the two apart, so "the flow queued it" and "it never arrived" are
   *     distinguishable, which is exactly the question somebody opens that screen with.
   * The digest names it from its own small table of labels; the fallback there is the raw key, so a
   * key it has not been taught still reads as itself rather than as "unknown".
   *
   * A SUCCESSFUL DELIVERY IS LOGGED TOO. Without it the run log's last word on a webhook is
   * "queued", which is a promise rather than an outcome, and a screen whose whole purpose is to say
   * whether the engine's work succeeded would be silent on the only part of it that leaves the
   * building. The intermediate retries are NOT logged: they are visible on the outbox row itself
   * (attempts, last_error, last_response_code) and one line per retry would bury the line that
   * matters under five that do not.
   */
  private async record(
    tenantId: string,
    environment: Environment,
    row: ClaimedDelivery,
    attempt: { ok: boolean; status: number | null; error: string | null },
    terminal: boolean,
  ): Promise<void> {
    const host = safeHost(row.url);
    await this.dbService.withContext(
      { tenantId, userId: null, isInternal: false, environment },
      async (tx) => {
        if (attempt.ok) {
          await tx.execute(sql`
            update workflow_webhook_outbox
               set status = 'delivered', delivered_at = now(), last_response_code = ${attempt.status},
                   last_error = null, updated_at = now()
             where id = ${row.id}::uuid`);
          await this.logRun(tx, tenantId, environment, row, "ok",
            `delivered to ${host} — ${attempt.status} on attempt ${row.attempts} of ${MAX_ATTEMPTS}`);
          return;
        }

        await tx.execute(sql`
          update workflow_webhook_outbox
             set status = ${terminal ? "dead" : "pending"},
                 last_error = ${attempt.error}, last_response_code = ${attempt.status},
                 updated_at = now()
           where id = ${row.id}::uuid`);
        if (terminal)
          await this.logRun(tx, tenantId, environment, row, "failed",
            `gave up calling ${host} after ${MAX_ATTEMPTS} attempts — ${attempt.error ?? "no reason recorded"}`);
      },
    );
  }

  /** One run-log row. `auto_advanced` is true because nobody clicked anything: a delivery happens on
   *  a timer, long after whoever caused it has gone home, and attributing it to them would be the
   *  false audit record 0059 exists to prevent. */
  private async logRun(
    tx: Tx,
    tenantId: string,
    environment: Environment,
    row: ClaimedDelivery,
    outcome: "ok" | "failed",
    detail: string,
  ): Promise<void> {
    await tx.execute(sql`
      insert into workflow_action_runs
        (tenant_id, environment, entity_type, entity_id, transition_key, action, params,
         outcome, detail, actor_user_id, auto_advanced)
      values (${tenantId}::uuid, ${environment}::environment_type, ${row.entity_type}::entity_type,
              ${row.entity_id}::uuid, ${row.transition_key}, 'webhook_delivery',
              jsonb_build_object('delivery', ${row.id}::text, 'attempts', ${row.attempts}::int),
              ${outcome}, ${detail.slice(0, 500)}, null::uuid, true)`);
  }
}

/** The host, for a message a person reads. Falls back to the whole string rather than throwing —
 *  this only ever runs on a URL that has already parsed, and a log line is not worth a stack. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}
