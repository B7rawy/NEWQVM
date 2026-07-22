import { Injectable, Logger } from "@nestjs/common";
import { schema, type Tx } from "../../db/db.service.js";

export type Channel = "email" | "whatsapp" | "webhook";

export interface NotifyInput {
  tenantId: string;
  isSandbox: boolean;
  channel: Channel;
  recipient?: string;
  template?: string;
  payload?: Record<string, unknown>;
}

/**
 * The single side-effect boundary (ADR-0004 / CONVENTIONS §BE-3). NOTHING sends email/whatsapp/
 * webhooks except through here. In a sandbox tenant — or when a provider is disabled by env — the
 * message is recorded as 'suppressed' and NO real provider is called. Every attempt is written to
 * notification_log (the audit trail + the proof sandbox isolation held).
 *
 * Must be called inside a tenant-scoped tx (RLS) — takes the tx so the log row is written in the
 * same transaction as the action that triggered it.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger("Notifications");

  async send(tx: Tx, input: NotifyInput): Promise<{ status: "sent" | "suppressed" }> {
    const providerLive =
      !input.isSandbox &&
      process.env.NODE_ENV === "production" &&
      this.providerEnabled(input.channel);

    const status = providerLive ? "sent" : "suppressed";

    await tx.insert(schema.notificationLog).values({
      tenantId: input.tenantId,
      channel: input.channel,
      recipient: input.recipient,
      template: input.template,
      payload: input.payload ?? {},
      status,
    });

    if (status === "sent") {
      // real provider dispatch goes here (SMTP/WhatsApp/webhook). Console for now.
      this.logger.log(`SEND ${input.channel} → ${input.recipient} [${input.template}]`);
    } else {
      this.logger.log(
        `SUPPRESSED ${input.channel} → ${input.recipient} [${input.template}]` +
          (input.isSandbox ? " (sandbox tenant)" : " (provider off / non-prod)"),
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
