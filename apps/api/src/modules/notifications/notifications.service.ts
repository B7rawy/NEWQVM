import { Injectable, Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext, type Tx } from "../../db/db.service.js";

/**
 * Channels that need a PROVIDER this system does not have. Everything here is recorded and
 * dispatched nowhere. Kept as its own type so `in_app` can never reach send() by mistake and end up
 * filed as an intention when it could have been a real delivery.
 */
export type Channel = "email" | "whatsapp" | "webhook";

/** Every value that may appear in notification_log.channel, including the one that really sends. */
export type LoggedChannel = Channel | "in_app";

export interface NotifyInput {
  tenantId: string;
  /**
   * Sandbox environment suppresses real dispatch — the ONE sandbox mechanism (ADR-0012). REQUIRED,
   * not defaulted: a default of 'live' inside a sandbox transaction writes a live notification_log
   * row, the RESTRICTIVE WITH CHECK rejects it, and the enclosing business transaction rolls back —
   * a failure that only ever appears in Sandbox, so Live tests never catch it.
   */
  environment: "live" | "sandbox";
  channel: Channel;
  recipient?: string;
  template?: string;
  payload?: Record<string, unknown>;
}

/** What one person is told, in the one channel this system can actually deliver. */
export interface InAppInput {
  tenantId: string;
  environment: "live" | "sandbox";
  /** The person. Delivery is per-user because "unread" is only meaningful for one pair of eyes. */
  recipientUserId: string;
  title: string;
  body?: string;
  /** IN-APP router path, e.g. "/approvals". A DB check refuses absolute/protocol-relative URLs. */
  link?: string;
  /** 'approval' | 'workflow' | 'digest' | 'system' — free text, see migration 0061. */
  kind?: string;
}

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  /** z.coerce.boolean() treats "false" as true, so the flag is matched as the literal string. */
  unreadOnly: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

/**
 * The single side-effect boundary (ADR-0004 / CONVENTIONS §BE-3). NOTHING sends email/whatsapp/
 * webhooks except through here.
 *
 * TWO DELIVERY PATHS, AND THE DIFFERENCE BETWEEN THEM IS THE POINT OF THIS FILE:
 *
 *   send()       — email / whatsapp / webhook. RECORDED ONLY. There is no SMTP client and no
 *                  WhatsApp app behind it, so every call writes a notification_log row and
 *                  dispatches nothing. It is an audit trail of INTENTIONS, not of deliveries. This
 *                  is why `notify` is absent from the workflow action catalog (see actions.ts) and
 *                  why the Communications portal still says those channels are not connected.
 *
 *   sendInApp()  — REAL DELIVERY. No provider exists to be missing: the row it writes is read back
 *                  by this same application on a screen the recipient already has open. It is the
 *                  only channel anything in this system may claim to have sent.
 *
 * Both take the tx so what a person is told is written in the same transaction as the thing they are
 * being told about. If the business action rolls back so does the notification, and nobody is ever
 * told about something that did not happen.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("Notifications");

  constructor(private readonly dbService: DbService) {}

  /**
   * @param input   logged metadata (payload MUST NOT contain secrets — it is persisted).
   * @param secret  transient dispatch-only data (e.g. a tokenized link). Passed to the provider,
   *                NEVER written to notification_log.
   */
  async send(
    tx: Tx,
    input: NotifyInput,
    secret?: Record<string, unknown>,
  ): Promise<{ status: "sent" | "suppressed" }> {
    const providerLive =
      input.environment !== "sandbox" &&
      process.env.NODE_ENV === "production" &&
      this.providerEnabled(input.channel);

    const status = providerLive ? "sent" : "suppressed";

    await tx.insert(schema.notificationLog).values({
      tenantId: input.tenantId,
      environment: input.environment, // the log belongs to the environment that triggered it
      channel: input.channel,
      recipient: input.recipient,
      template: input.template,
      payload: input.payload ?? {}, // non-secret only
      status,
    });

    if (status === "sent") {
      // real provider dispatch goes here (SMTP/WhatsApp/webhook), using `secret` for the link.
      void secret;
      this.logger.log(`SEND ${input.channel} → ${input.recipient} [${input.template}]`);
    } else {
      this.logger.log(
        `SUPPRESSED ${input.channel} → ${input.recipient} [${input.template}]` +
          (input.environment === "sandbox" ? " (sandbox environment)" : " (provider off / non-prod)"),
      );
    }
    return { status };
  }

  /**
   * IN-APP DELIVERY — this one really arrives.
   *
   * NO SANDBOX SUPPRESSION, and that is not an oversight. Suppression exists so a Sandbox experiment
   * cannot reach a real customer's phone. In-app has no outside: the row is written with
   * environment='sandbox' and the RESTRICTIVE environment policy keeps it out of the same person's
   * Live inbox. The isolation belongs to the row, not to the dispatcher, so Sandbox gets a working
   * notification instead of a silently swallowed one — which is what makes rehearsing a flow in
   * Sandbox worth doing at all.
   *
   * NO `.returning()`. The addressee policy is RESTRICTIVE FOR SELECT and PostgreSQL re-checks
   * SELECT policies against rows an INSERT returns. Delivery is normally written by somebody OTHER
   * than the recipient — the approver's notification is inserted inside the requester's transaction
   * — so asking for a returned column would fail on exactly the notifications that matter. See the
   * header of migration 0061.
   */
  async sendInApp(tx: Tx, input: InAppInput): Promise<{ status: "delivered" }> {
    await tx.insert(schema.inAppNotifications).values({
      tenantId: input.tenantId,
      environment: input.environment,
      recipientUserId: input.recipientUserId,
      title: input.title,
      body: input.body,
      link: input.link,
      kind: input.kind ?? "system",
    });

    // The same audit trail as every other channel, so "what was this workspace told, and when" has
    // ONE answer instead of two half-answers. status='sent' is a true statement here and only here:
    // the row exists and its recipient can read it.
    await tx.insert(schema.notificationLog).values({
      tenantId: input.tenantId,
      environment: input.environment,
      channel: "in_app" satisfies LoggedChannel,
      recipient: input.recipientUserId,
      template: input.kind ?? "system",
      payload: { title: input.title, link: input.link ?? null },
      status: "sent",
    });

    this.logger.log(`DELIVERED in_app → ${input.recipientUserId} [${input.kind ?? "system"}]`);
    return { status: "delivered" };
  }

  // ── the read model ──────────────────────────────────────────────────────────────────────────
  // Every read below filters on tenant + environment + recipient IN THE QUERY as well as relying on
  // RLS. Belt and braces on purpose: the tenant policy carries an app_is_internal() escape, so a
  // platform admin's session is NOT tenant-limited by the database. Without the explicit scoping an
  // admin would see notifications addressed to them in workspaces they are not currently looking at,
  // and the badge would count things the page below it cannot show.

  /** My inbox, newest first, unread floated to the top so the badge and the list tell one story. */
  async list(ctx: RlsContext, q: z.infer<typeof listQuerySchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        select id, title, body, link, kind, read_at, created_at
        from in_app_notifications
        where tenant_id = ${ctx.tenantId}::uuid
          and environment = ${ctx.environment ?? "live"}
          and recipient_user_id = ${ctx.userId}::uuid
          ${q.unreadOnly ? sql`and read_at is null` : sql``}
        order by (read_at is null) desc, created_at desc
        limit ${q.limit}`)) as Array<Record<string, unknown>>;
      return { rows, count: rows.length };
    });
  }

  /**
   * The badge. ONE indexed count served by in_app_notifications_unread_idx — never a scan, because
   * this runs on every page load for every signed-in person for the life of the product.
   */
  async unreadCount(ctx: RlsContext): Promise<{ unread: number }> {
    return this.dbService.withContext(ctx, async (tx) => {
      const [row] = (await tx.execute(sql`
        select count(*)::int as unread
        from in_app_notifications
        where tenant_id = ${ctx.tenantId}::uuid
          and environment = ${ctx.environment ?? "live"}
          and recipient_user_id = ${ctx.userId}::uuid
          and read_at is null`)) as Array<{ unread: number }>;
      return { unread: row?.unread ?? 0 };
    });
  }

  /**
   * Mark one read. Reports how many rows it actually changed instead of throwing on a miss: the id
   * may belong to somebody else, and the honest answer to that is "nothing changed" — a 404 would
   * still confirm that the notification exists. Re-marking an already-read one is 0 as well, which
   * is what makes the button safe to press twice.
   */
  async markRead(ctx: RlsContext, id: string): Promise<{ updated: number }> {
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        update in_app_notifications
        set read_at = now()
        where id = ${id}::uuid
          and tenant_id = ${ctx.tenantId}::uuid
          and environment = ${ctx.environment ?? "live"}
          and recipient_user_id = ${ctx.userId}::uuid
          and read_at is null
        returning id`)) as Array<{ id: string }>;
      return { updated: rows.length };
    });
  }

  /** Clear the badge in one press. Same scoping — it can only ever empty MY inbox. */
  async markAllRead(ctx: RlsContext): Promise<{ updated: number }> {
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        update in_app_notifications
        set read_at = now()
        where tenant_id = ${ctx.tenantId}::uuid
          and environment = ${ctx.environment ?? "live"}
          and recipient_user_id = ${ctx.userId}::uuid
          and read_at is null
        returning id`)) as Array<{ id: string }>;
      return { updated: rows.length };
    });
  }

  private providerEnabled(channel: Channel): boolean {
    if (channel === "email") return (process.env.EMAIL_PROVIDER ?? "console") !== "console";
    if (channel === "whatsapp") return process.env.WHATSAPP_ENABLED === "true";
    return true; // webhooks always allowed when live
  }
}
