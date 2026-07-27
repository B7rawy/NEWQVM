import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, type Tx } from "../../db/db.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { Environment } from "../../common/env-guards.js";

/**
 * THE DAILY FAILURE DIGEST — QNEW-90 item 6.
 *
 * runActions() may never throw: the move has already happened and been judged legitimate, so a
 * follow-up that breaks must not fail somebody's correct click. The price of that rule is that a
 * failure is SILENT — the flow looks configured and quietly is not. The run log ended the silence
 * for anyone who opens it; this ends it for everyone who does not.
 *
 * ── WHY IT IS A DIGEST AND NOT AN ALERT ─────────────────────────────────────────────────────────
 * The ticket's own words: "digest, not one email per failure". The failure mode of one-per-failure
 * is not volume for its own sake — it is that a rule wired onto an arrow every order crosses breaks
 * two hundred times before lunch, and the one rule that broke once is buried under it. A digest
 * inverts that: one message, the day's failures grouped by which action broke, biggest first.
 *
 * ── WHY IT IS DELIVERED IN-APP ──────────────────────────────────────────────────────────────────
 * The ticket says "recipients", and everything else in this codebase would have read that as email.
 * NotificationsService.send() has no SMTP client behind it and dispatches nothing, so an emailed
 * digest would be a promise of a message that never arrives — strictly worse than telling somebody
 * to look at the run log, and the exact defect this codebase refuses to ship. In-app has no provider
 * to be missing (migration 0061), so the digest goes where the badge already is.
 *
 * ── WHY THERE IS A TIMER IN HERE AT ALL ─────────────────────────────────────────────────────────
 * There was no scheduler in this repo: no @Cron, no interval, no @nestjs/schedule. This is the
 * minimum that makes a daily job real rather than the beginning of a job framework — one interval,
 * one method, and a table that makes running it twice harmless. Everything that would normally
 * justify a scheduling library (retries, backoff, distributed locking) is answered here by the
 * unique key on workflow_failure_digests instead: a second run of the same day is refused by the
 * database, so at-least-once delivery and exactly-once reporting are the same thing.
 *
 * A TICK IS NOT A SEND. The interval is 15 minutes and the digest is daily; the tick only ASKS each
 * workspace whether its local day has rolled over since the last digest, and almost always the
 * answer is no. That is what lets one fixed interval serve workspaces in different timezones, and
 * what makes a restart harmless — a process that comes up at 00:07 still sends the 00:00 digest,
 * because the question is about the ledger and not about the clock.
 */

/** How often the tick asks. Overridable so a test does not have to wait a quarter of an hour. */
const TICK_MS = Number(process.env.WORKFLOW_DIGEST_TICK_MS ?? 15 * 60_000);

/** What one workspace's pass did, in the language the log line and the guard both read. */
export interface DigestOutcome {
  tenant: string;
  environment: Environment;
  /** 'sent' | 'quiet' (a window with no failures) | 'covered' (this day is already in the ledger) */
  result: "sent" | "quiet" | "covered";
  failures: number;
  recipients: number;
}

@Injectable()
export class WorkflowDigestService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("WorkflowDigest");
  private timer: NodeJS.Timeout | null = null;
  /**
   * A pass that overruns its interval must not be joined by the next one. Not a substitute for the
   * unique key — that is what protects a SECOND PROCESS — but it keeps one process from doing the
   * same work twice and writing two log lines about it.
   */
  private running = false;

  constructor(
    private readonly dbService: DbService,
    private readonly notifications: NotificationsService,
  ) {}

  onApplicationBootstrap(): void {
    // unref() so the timer is never the reason node stays alive. A scheduled report must not be able
    // to keep a process up that everything else has finished with — that turns a clean shutdown into
    // a hang somebody eventually kills, and a killed process is how a half-written digest happens.
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.logger.log(`daily failure digest armed — checking every ${Math.round(TICK_MS / 1000)}s`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const done = (await this.runOnce()).filter((o) => o.result === "sent");
      for (const o of done)
        this.logger.log(
          `digest sent — ${o.tenant} (${o.environment}): ${o.failures} failures to ${o.recipients} recipients`,
        );
    } catch (e) {
      // A scheduled job that throws into an interval callback is an unhandled rejection, which in a
      // Node process is a crash waiting to be configured. The digest is a report; nothing about the
      // product should stop because a report could not be produced.
      this.logger.error(`digest pass failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One pass over every workspace, in both environments. Public because the scheduler is not the
   * only legitimate caller: scripts/run-digest.ts drives exactly this, which is how the behaviour
   * is asserted without waiting for a clock.
   *
   * EVERY WORKSPACE, EVERY TIME. There is no "active tenants only" filter and no cursor: two
   * workspaces today, and the pass is two indexed lookups each. When that stops being true the fix
   * is a query that selects the workspaces whose day has rolled over, not a scheduler library.
   *
   * ONE WORKSPACE'S FAILURE DOES NOT STOP THE NEXT. Each pass is its own transaction and its own
   * try/catch, because a digest is a report about failures and the least useful thing it could do is
   * stop reporting when one workspace has a problem.
   */
  async runOnce(): Promise<DigestOutcome[]> {
    // `tenants` is globally readable (its policy is `using (true)`), so this needs no tenant context
    // — and must not have one, because it is asking about all of them.
    const tenants = (await this.dbService.withContext(
      { tenantId: null, userId: null, isInternal: false },
      (tx) => tx.execute(sql`select id, slug from tenants where is_active order by slug`),
    )) as Array<{ id: string; slug: string }>;

    const results: DigestOutcome[] = [];
    for (const t of tenants) {
      for (const environment of ["live", "sandbox"] as const) {
        try {
          results.push(await this.runForWorkspace(t.id, t.slug, environment));
        } catch (e) {
          this.logger.error(`digest for ${t.slug} (${environment}) failed: ${(e as Error).message}`);
        }
      }
    }
    return results;
  }

  /**
   * The window, the failures in it, and the message — for ONE workspace in ONE environment.
   *
   * Everything happens in a single transaction so the ledger row and the notifications it explains
   * cannot come apart: a digest people were told about but that the ledger does not record would be
   * sent again tomorrow, and a ledger row with no delivery behind it would swallow a day of
   * failures for good.
   */
  private async runForWorkspace(
    tenantId: string,
    slug: string,
    environment: Environment,
  ): Promise<DigestOutcome> {
    return this.dbService.withContext({ tenantId, userId: null, isInternal: false, environment }, async (tx) => {
      const window = await this.windowFor(tx, tenantId, environment);
      if (!window) return { tenant: slug, environment, result: "covered", failures: 0, recipients: 0 };

      const breakdown = (await tx.execute(sql`
        select action, count(*)::int as n
        from workflow_action_runs
        where tenant_id = ${tenantId}::uuid and environment = ${environment}::environment_type
          -- ONLY 'failed'. 'capped' is a refusal the engine made on purpose and 'skipped' is an
          -- action declining itself; neither is a thing that broke, and folding them in would make
          -- the number at the top of the message mean "things that were not done", which is a
          -- different and much less alarming fact.
          and outcome = 'failed'
          and ran_at >= ${window.start}::timestamptz and ran_at < ${window.end}::timestamptz
        group by action
        order by n desc, action`)) as Array<{ action: string; n: number }>;

      const failures = breakdown.reduce((sum, b) => sum + b.n, 0);

      // The recipients: this workspace's managers. Resolved at SEND time from the membership table
      // rather than from a configured list, for the same reason the notify action resolves its
      // recipients from the record — a list of names is correct on the day it is written and wrong
      // the first time somebody leaves.
      //
      // NO JOIN TO `users`, deliberately. Its policy is `app_is_internal() OR id = app_user_id()`,
      // and this job has neither: it runs with no signed-in user and is NOT internal, because
      // "Qparts platform staff" is a claim about a person and a background job is not one. Joining
      // would therefore have returned zero recipients on every workspace, forever, while every
      // other part of the digest went on looking correct. tenant_memberships.is_active is the
      // workspace's own statement about who works here, and it is the same source custody itself
      // uses when it decides who may hold a record (see bindOnEntry in status.service.ts).
      const admins = failures
        ? ((await tx.execute(sql`
            select user_id from tenant_memberships
            where tenant_id = ${tenantId}::uuid and is_active and role = 'company_admin'`)) as Array<{
            user_id: string;
          }>)
        : [];

      // ── CLAIM THE DAY BEFORE TELLING ANYBODY ABOUT IT ─────────────────────────────────────────
      // Written before the notifications, not after, and the order is the point. ON CONFLICT DO
      // NOTHING against the unique key means a second process that reached this day first leaves
      // this one with no row — and because nothing has been delivered yet, this pass can simply
      // stop, having written nothing at all.
      //
      // The reverse order would have to roll back deliveries it had already made, and a rollback
      // that also has to undo a notification is a rollback that will one day not.
      //
      // A ROW IS WRITTEN ON A QUIET DAY TOO, because this row is what moves the window forward.
      // Skipping quiet days would reopen them tomorrow and report a failure on a day it did not
      // happen. Nothing is delivered — a digest of nothing is an inbox people stop reading.
      const claimed = (await tx.execute(sql`
        insert into workflow_failure_digests
          (tenant_id, environment, window_start, window_end, failures, recipients)
        values (${tenantId}::uuid, ${environment}::environment_type,
                ${window.start}::timestamptz, ${window.end}::timestamptz,
                ${failures}, ${admins.length})
        on conflict (tenant_id, environment, window_end) do nothing
        returning id`)) as Array<{ id: string }>;
      if (claimed.length === 0)
        return { tenant: slug, environment, result: "covered", failures: 0, recipients: 0 };

      if (failures) {
        // THE HEADLINE NAMES THE WINDOW IT ACTUALLY COVERS. "Yesterday" is true on the ordinary day
        // and a lie after an outage, when the window spans everything since the last digest — and a
        // message that misstates WHEN by two days is a message somebody will go looking for in the
        // wrong place. The window is the authority here, not the schedule it was meant to run on.
        const title =
          `${failures} workflow ${failures === 1 ? "action" : "actions"} failed ` +
          WorkflowDigestService.windowInWords(window.start, window.end);
        const body =
          breakdown.map((b) => `${WorkflowDigestService.actionName(b.action)} — ${b.n}`).join(", ") +
          ". Open the run log to see each one and what it said.";
        for (const a of admins) {
          await this.notifications.sendInApp(tx, {
            tenantId,
            environment,
            recipientUserId: a.user_id,
            title,
            body,
            // The screen that can actually answer "which ones, and why". A digest that says
            // something broke and does not say where to look is an alarm with no map.
            link: "/status-logs",
            kind: "digest",
          });
        }
      }

      return {
        tenant: slug,
        environment,
        result: failures ? "sent" : "quiet",
        failures,
        recipients: admins.length,
      };
    });
  }

  /**
   * The window this pass should cover, or null when today's has already been reported.
   *
   * WHERE THE DAY ENDS: the last local midnight in the workspace's own business-calendar timezone,
   * falling back to 'Asia/Riyadh' — the same boundary, resolved the same way, as the action daily
   * cap in actions.ts. One definition of "a day" for the ceiling and for the report of what hit it,
   * so a workspace never has to hold two.
   *
   * The join to pg_timezone_names is not decoration: `at time zone` RAISES on a name postgres does
   * not know, and nothing in the API can write that column, so the only way a bad one arrives is a
   * hand-fix on a live database. The join makes an unrecognised name fall back instead of aborting
   * the pass for that workspace.
   *
   * WHERE IT STARTS: where the last one ended. On a workspace's very first digest there is no last
   * one, so it starts one day back — which reports yesterday and nothing older. That is not
   * "retroactive": the guarantee this table exists for is that no failure is reported TWICE, and a
   * first digest has nothing to duplicate. Reaching further back would mean a workspace that
   * switched the feature on got a message about a fortnight it has already dealt with.
   */
  private async windowFor(
    tx: Tx,
    tenantId: string,
    environment: Environment,
  ): Promise<{ start: string; end: string } | null> {
    // COMPUTED ENTIRELY IN SQL, and handed back as explicit UTC ISO-8601 strings. Doing the
    // arithmetic in JavaScript meant depending on how the driver decided to hand back a timestamptz,
    // and a window boundary is the last value in this system that should be settled by a coercion
    // nobody wrote down. `to_char(… at time zone 'UTC', …Z)` is the same rendering the run log uses
    // for the one column that leaves the app.
    const [row] = (await tx.execute(sql`
      with zone as (
        select coalesce(
          (select n.name from business_calendar_settings b
             join pg_timezone_names n on n.name = b.timezone
            where b.tenant_id = ${tenantId}::uuid),
          'Asia/Riyadh') as name
      ),
      day as (
        select (date_trunc('day', now() at time zone z.name) at time zone z.name) as ends
        from zone z
      ),
      last as (
        select max(window_end) as ended from workflow_failure_digests
         where tenant_id = ${tenantId}::uuid and environment = ${environment}::environment_type
      )
      select
        to_char(d.ends at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as window_end,
        to_char(coalesce(l.ended, d.ends - interval '1 day') at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as window_start,
        -- Greater-than-OR-EQUAL, not strictly greater: an ended equal to this midnight is today's
        -- digest, already sent, and a strict comparison would send it again on the very next tick —
        -- the one failure mode this whole table exists to prevent.
        (l.ended is not null and l.ended >= d.ends) as covered
      from day d, last l`)) as Array<{ window_end: string; window_start: string; covered: boolean }>;
    if (!row || row.covered) return null;
    return { start: row.window_start, end: row.window_end };
  }

  /**
   * The period this digest covers, said the way a person would say it.
   *
   * ONE DAY IS THE NORMAL CASE and gets the word people expect. Anything longer means the job did
   * not run for a while — a restart that took a day, a machine that was off — and the window
   * stretched to cover it, which is the behaviour that stops failures being dropped. Saying
   * "yesterday" about a three-day window would spend that correctness on a sentence that then sends
   * the reader to the wrong day of the run log.
   */
  private static windowInWords(startIso: string, endIso: string): string {
    const days = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 86_400_000);
    return days <= 1 ? "yesterday" : `in the ${days} days since the last digest`;
  }

  /**
   * The name an admin picked the action by, rather than the key the engine stores it under.
   *
   * A SMALL DUPLICATE OF THE CATALOG, ON PURPOSE. Importing ACTIONS here to look labels up would
   * make a message that has already been delivered change wording when the catalog is edited, and
   * would silently rename an action in a digest about a version of the flow that used the old name.
   * An action removed from the catalog still has to be nameable in a digest about the day it broke,
   * which is why the fallback is the raw key rather than "unknown".
   */
  private static actionName(key: string): string {
    const NAMES: Record<string, string> = {
      set_field: "Fill in a field",
      lock_record: "Put it on hold",
      unlock_record: "Take it off hold",
      notify: "Tell somebody",
    };
    return NAMES[key] ?? key;
  }
}
