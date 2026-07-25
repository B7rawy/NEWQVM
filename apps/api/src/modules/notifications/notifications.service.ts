import { Injectable, Logger } from "@nestjs/common";
import { schema, type Tx } from "../../db/db.service.js";

export type Channel = "email" | "whatsapp" | "webhook";

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

/**
 * The single side-effect boundary (ADR-0004 / CONVENTIONS §BE-3). NOTHING sends email/whatsapp/
 * webhooks except through here. In the sandbox environment — or when a provider is disabled by env —
 * the message is recorded as 'suppressed' and NO real provider is called. Every attempt is written to
 * notification_log (the audit trail + the proof sandbox isolation held).
 *
 * Must be called inside a tenant-scoped tx (RLS) — takes the tx so the log row is written in the
 * same transaction as the action that triggered it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("Notifications");

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

  private providerEnabled(channel: Channel): boolean {
    if (channel === "email") return (process.env.EMAIL_PROVIDER ?? "console") !== "console";
    if (channel === "whatsapp") return process.env.WHATSAPP_ENABLED === "true";
    return true; // webhooks always allowed when live
  }
}
