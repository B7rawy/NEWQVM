import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext, type Tx } from "../../db/db.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { assertItemNotOrdered, assertRfqHasOpenItems } from "../../common/rfq-guards.js";
import { assertEnvironment } from "../../common/env-guards.js";
import { StatusService } from "../../common/status.service.js";

const TOKEN_TTL_DAYS = 7;

export const sendRfqSchema = z.object({ vendorIds: z.array(z.string().uuid()).min(1) });
export type SendRfqDto = z.infer<typeof sendRfqSchema>;

export const submitQuoteSchema = z.object({
  items: z
    .array(
      z.object({
        rfqItemId: z.string().uuid(),
        offeredCost: z.number().finite().nonnegative().max(100_000_000),
        slaHours: z.number().int().positive().optional(),
        availableQty: z.number().int().nonnegative().optional(),
        alternativePartNumber: z.string().max(64).optional(),
        notes: z.string().max(256).optional(),
      }),
    )
    .min(1),
});
export type SubmitQuoteDto = z.infer<typeof submitQuoteSchema>;

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

@Injectable()
export class VendorRfqService {
  constructor(
    private readonly dbService: DbService,
    private readonly notifications: NotificationsService,
    private readonly status: StatusService,
  ) {}

  /** Send an RFQ to selected vendors: create rfq_vendors (hashed token) + a guarded notification each. */
  async send(ctx: RlsContext, rfqId: string, dto: SendRfqDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(
          sql`select id, environment from rfqs where id = ${rfqId}::uuid limit 1`,
        )) as Array<{ id: string; environment: "live" | "sandbox" }>
      )[0];
      // a Sandbox session may not send a Live RFQ to vendors, nor the reverse (ADR-0012)
      assertEnvironment(ctx, rfq, "RFQ");

      // Dispatch is suppressed by the ENVIRONMENT now (ADR-0012) — a workspace-level "sandbox"
      // flag no longer exists, because it isolated nothing.
      const isSandbox = rfq.environment === "sandbox";

      const sentStatusId = (
        (await tx.execute(
          sql`select id from vendor_statuses where code = 'rfq' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const results: Array<{ vendorId: string; notify: string; token?: string }> = [];
      for (const vendorId of dto.vendorIds) {
        // vendor must be linked to THIS workspace AND be a live directory identity (not suspended /
        // pending activation) — mirrors the auto-assignment pool filter.
        const link = (
          (await tx.execute(sql`
            select v.primary_email
            from tenant_vendors tv join vendors v on v.id = tv.vendor_id
            where tv.tenant_id = ${ctx.tenantId}::uuid and tv.vendor_id = ${vendorId}::uuid
              and tv.status = 'active' and v.is_active and v.activation_status = 'active' limit 1`)) as Array<{ primary_email: string | null }>
        )[0];
        if (!link) throw new BadRequestException(`vendor ${vendorId} is not an active supplier in this workspace`);

        const rawToken = randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400_000);

        await tx.insert(schema.rfqVendors).values({
          tenantId: ctx.tenantId!,
          environment: rfq.environment, // the invitation lives in the RFQ's environment
          rfqId,
          vendorId,
          statusId: sentStatusId,
          tokenHash: hashToken(rawToken),
          tokenExpiresAt: expiresAt,
          sentAt: new Date(),
        });

        // The real quote link (with the raw token) is handed to the provider for dispatch but is
        // NEVER persisted — notification_log stores only non-secret metadata (review #2).
        const notify = await this.notifications.send(
          tx,
          {
            tenantId: ctx.tenantId!,
            environment: rfq.environment,
            channel: "email",
            recipient: link.primary_email ?? undefined,
            template: "vendor_rfq_invite",
            payload: { rfqId, vendorId },
          },
          { quoteUrl: `/quote-access/${rawToken}` },
        );

        // Raw token is returned only in non-prod (test/dev convenience); in prod it lives only in
        // the outbound email, never in an API response or a log.
        const exposeToken = process.env.NODE_ENV !== "production";
        results.push({
          vendorId,
          notify: notify.status,
          ...(exposeToken ? { token: rawToken } : {}),
        });
      }
      return { rfqId, sent: results.length, isSandbox, results };
    });
  }

  /**
   * PUBLIC (token-gated, unauthenticated) vendor quote submission. The token IS the authorization:
   * we resolve it as internal, then scope the writes to the resolved tenant so RLS still applies.
   */
  async submitQuoteByToken(rawToken: string, dto: SubmitQuoteDto) {
    // 1) resolve the token as internal (no tenant context yet) — the hash match is the secret gate.
    //
    // A quote link is an EMAILED URL: it carries no X-Environment header, so we cannot know which
    // environment it belongs to before we have read the row — and the restrictive policy (ADR-0012)
    // filters by the environment GUC, which defaults to 'live'. A single lookup would therefore make
    // every sandbox link 404 as "invalid token". So we look in each environment in turn. Two cheap
    // reads on a rare path, and no SECURITY DEFINER escape hatch — the old system's 156 open
    // definer functions are exactly the sin this rebuild exists to undo.
    let rv:
      | { id: string; tenant_id: string; rfq_id: string; token_expires_at: string | null; environment: "live" | "sandbox" }
      | undefined;
    for (const env of ["live", "sandbox"] as const) {
      rv = await this.dbService.withContext(
        { tenantId: null, userId: null, isInternal: true, environment: env },
        async (tx) =>
          (
            (await tx.execute(sql`
              select rv.id, rv.tenant_id, rv.rfq_id, rv.token_expires_at, r.environment
              from rfq_vendors rv join rfqs r on r.id = rv.rfq_id
              where rv.token_hash = ${hashToken(rawToken)} limit 1`)) as Array<{
              id: string;
              tenant_id: string;
              rfq_id: string;
              token_expires_at: string | null;
              environment: "live" | "sandbox";
            }>
          )[0],
      );
      if (rv) break;
    }
    if (!rv) throw new NotFoundException("invalid quote link");
    if (rv.token_expires_at && new Date(rv.token_expires_at) < new Date()) {
      throw new BadRequestException("quote link expired");
    }

    // 2) writes scoped to the token's tenant (RLS applies for that tenant)
    // the LINK carries no X-Environment header, so the RFQ's own environment is authoritative:
    // a sandbox quote link can only ever write sandbox rows.
    return this.dbService.withContext(
      { tenantId: rv.tenant_id, userId: null, isInternal: false, environment: rv.environment },
      (tx) =>
        this.writeQuoteItems(
          tx,
          { tenantId: rv.tenant_id, rfqVendorId: rv.id, rfqId: rv.rfq_id, environment: rv.environment, actorUserId: null },
          dto,
        ),
    );
  }

  /**
   * The ONE quote-write path (shared by the public token flow and the authed vendor portal, so the
   * two can never diverge): reject if the RFQ is confirmed, keep only items of this RFQ, UPSERT each
   * line (a vendor may revise its quote until confirmation), flip rfq_vendors → 'priced'.
   */
  async writeQuoteItems(
    tx: Tx,
    ids: {
      tenantId: string;
      rfqVendorId: string;
      rfqId: string;
      environment: "live" | "sandbox";
      /** Who is quoting. NULL on the public token path — the vendor is not a logged-in user there,
       *  and the token itself is the credential. status_logs records that honestly rather than
       *  attributing the change to whoever happened to send the RFQ. */
      actorUserId: string | null;
    },
    dto: SubmitQuoteDto,
  ) {
    // partial confirmation (0083): a batch confirming SOME lines must not freeze quoting on the
    // rest, so the guard is "any line still open", not "no order exists".
    await assertRfqHasOpenItems(tx, ids.rfqId, "this RFQ is fully confirmed or closed — nothing left to quote");

    const pricedStatusId = (
      (await tx.execute(sql`select id from vendor_statuses where code = 'priced' limit 1`)) as Array<{ id: string }>
    )[0].id;

    // only items that actually belong to this RFQ
    const validItemIds = new Set(
      ((await tx.execute(sql`select id from rfq_items where rfq_id = ${ids.rfqId}::uuid`)) as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    const items = dto.items.filter((i) => validItemIds.has(i.rfqItemId));
    if (items.length === 0) throw new BadRequestException("no valid items for this RFQ");

    for (const it of items) {
      await tx.execute(sql`
        insert into rfq_vendor_items
          (tenant_id, environment, rfq_vendor_id, rfq_item_id, offered_cost, sla_hours, available_qty, alternative_part_number, notes, status_id)
        values (${ids.tenantId}::uuid, ${ids.environment}, ${ids.rfqVendorId}::uuid, ${it.rfqItemId}::uuid, ${it.offeredCost.toFixed(2)},
          ${it.slaHours ?? null}, ${it.availableQty ?? null}, ${it.alternativePartNumber ?? null}, ${it.notes ?? null}, ${pricedStatusId}::uuid)
        on conflict (rfq_vendor_id, rfq_item_id) do update set
          offered_cost = excluded.offered_cost, sla_hours = excluded.sla_hours, available_qty = excluded.available_qty,
          alternative_part_number = excluded.alternative_part_number, notes = excluded.notes,
          status_id = excluded.status_id, updated_at = now()`);
    }
    const statusCtx = { tenantId: ids.tenantId, userId: ids.actorUserId, environment: ids.environment };
    await this.status.transitionMany(tx, statusCtx, {
      entity: "rfq_vendor",
      ids: [ids.rfqVendorId],
      toCode: "priced",
    });

    /**
     * A QUOTE LANDING IS A CHILD EVENT (QNEW-90 item 7).
     *
     * The rows written just above are exactly what min_quotes_per_item counts, and the invitation
     * moving to 'priced' says nothing about the REQUEST — the request is a different record in a
     * different status vocabulary, and nothing was re-examining it. So a workspace could configure
     * "move on by itself once every line has three quotes", watch the third quote arrive, and see
     * the request sit still until somebody opened it. The rule was right, the moment to apply it
     * simply never came.
     *
     * Lines first, then the header, for the same reason creation does it that way: a gate on the
     * header asks a question about the lines.
     */
    await this.status.reevaluate(tx, statusCtx, "rfq_item", items.map((i) => i.rfqItemId));
    await this.status.reevaluate(tx, statusCtx, "rfq", [ids.rfqId]);
    return { quoted: items.length, status: "priced" as const };
  }

  /** Comparison view: every item with its vendor quotes (for purchasing to pick the winner). */
  async getQuotes(ctx: RlsContext, rfqId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select i.id as item_id, i.part_number, i.part_description,
               i.winning_vendor_quote_item_id,
               vi.id as quote_id, vi.offered_cost, vi.sla_hours, v.legal_name as vendor
        from rfq_items i
        left join rfq_vendor_items vi on vi.rfq_item_id = i.id
        left join rfq_vendors rv on rv.id = vi.rfq_vendor_id
        left join vendors v on v.id = rv.vendor_id
        where i.rfq_id = ${rfqId}::uuid
        order by i.id, vi.offered_cost asc nulls last`),
    );
    return { rfqId, rows };
  }

  /** Pick the winning quote for an item (old cost_id). Validates the quote belongs to this RFQ+item. */
  async selectWinner(ctx: RlsContext, rfqId: string, itemId: string, quoteItemId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      // can't change THIS item's winner once its line is snapshotted onto an order (review #4);
      // other items stay selectable — that is the whole point of partial confirmation (0083).
      await assertItemNotOrdered(tx, itemId, "this item is already on an order — its winner is locked");

      const ok = (
        (await tx.execute(sql`
          select vi.id from rfq_vendor_items vi
          join rfq_vendors rv on rv.id = vi.rfq_vendor_id
          where vi.id = ${quoteItemId}::uuid and vi.rfq_item_id = ${itemId}::uuid
            and rv.rfq_id = ${rfqId}::uuid limit 1`)) as Array<{ id: string }>
      )[0];
      if (!ok) throw new BadRequestException("quote does not belong to this RFQ item");

      const pricedStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'priced' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      await tx.execute(sql`
        update rfq_items set winning_vendor_quote_item_id = ${quoteItemId}::uuid
        where id = ${itemId}::uuid and rfq_id = ${rfqId}::uuid`);
      await this.status.transition(tx, ctx, { entity: "rfq_item", id: itemId, toCode: "priced" });
      return { itemId, winningQuoteId: quoteItemId };
    });
  }
}
