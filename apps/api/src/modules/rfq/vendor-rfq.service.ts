import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext, type Tx } from "../../db/db.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { assertRfqNotConfirmed } from "../../common/rfq-guards.js";

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
  ) {}

  /** Send an RFQ to selected vendors: create rfq_vendors (hashed token) + a guarded notification each. */
  async send(ctx: RlsContext, rfqId: string, dto: SendRfqDto) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(
          sql`select id from rfqs where id = ${rfqId}::uuid limit 1`,
        )) as Array<{ id: string }>
      )[0];
      if (!rfq) throw new NotFoundException("RFQ not found in this workspace");

      const isSandbox = (
        (await tx.execute(
          sql`select is_sandbox from tenants where id = ${ctx.tenantId}::uuid`,
        )) as Array<{ is_sandbox: boolean }>
      )[0].is_sandbox;

      const sentStatusId = (
        (await tx.execute(
          sql`select id from vendor_statuses where code = 'rfq' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const results: Array<{ vendorId: string; notify: string; token?: string }> = [];
      for (const vendorId of dto.vendorIds) {
        // vendor must be linked to THIS workspace
        const link = (
          (await tx.execute(sql`
            select v.primary_email
            from tenant_vendors tv join vendors v on v.id = tv.vendor_id
            where tv.tenant_id = ${ctx.tenantId}::uuid and tv.vendor_id = ${vendorId}::uuid
              and tv.status = 'active' limit 1`)) as Array<{ primary_email: string | null }>
        )[0];
        if (!link) throw new BadRequestException(`vendor ${vendorId} is not linked to this workspace`);

        const rawToken = randomBytes(24).toString("base64url");
        const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86400_000);

        await tx.insert(schema.rfqVendors).values({
          tenantId: ctx.tenantId!,
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
            isSandbox,
            environment: ctx.environment,
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
    // 1) resolve token as internal (no tenant context yet) — the hash match is the secret gate
    const rv = await this.dbService.withContext(
      { tenantId: null, userId: null, isInternal: true },
      async (tx) =>
        (
          (await tx.execute(sql`
            select id, tenant_id, rfq_id, token_expires_at
            from rfq_vendors where token_hash = ${hashToken(rawToken)} limit 1`)) as Array<{
            id: string;
            tenant_id: string;
            rfq_id: string;
            token_expires_at: string | null;
          }>
        )[0],
    );
    if (!rv) throw new NotFoundException("invalid quote link");
    if (rv.token_expires_at && new Date(rv.token_expires_at) < new Date()) {
      throw new BadRequestException("quote link expired");
    }

    // 2) writes scoped to the token's tenant (RLS applies for that tenant)
    return this.dbService.withContext({ tenantId: rv.tenant_id, userId: null, isInternal: false }, (tx) =>
      this.writeQuoteItems(tx, { tenantId: rv.tenant_id, rfqVendorId: rv.id, rfqId: rv.rfq_id }, dto),
    );
  }

  /**
   * The ONE quote-write path (shared by the public token flow and the authed vendor portal, so the
   * two can never diverge): reject if the RFQ is confirmed, keep only items of this RFQ, UPSERT each
   * line (a vendor may revise its quote until confirmation), flip rfq_vendors → 'priced'.
   */
  async writeQuoteItems(tx: Tx, ids: { tenantId: string; rfqVendorId: string; rfqId: string }, dto: SubmitQuoteDto) {
    await assertRfqNotConfirmed(tx, ids.rfqId, "this RFQ is already confirmed");

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
          (tenant_id, rfq_vendor_id, rfq_item_id, offered_cost, sla_hours, available_qty, alternative_part_number, notes, status_id)
        values (${ids.tenantId}::uuid, ${ids.rfqVendorId}::uuid, ${it.rfqItemId}::uuid, ${it.offeredCost.toFixed(2)},
          ${it.slaHours ?? null}, ${it.availableQty ?? null}, ${it.alternativePartNumber ?? null}, ${it.notes ?? null}, ${pricedStatusId}::uuid)
        on conflict (rfq_vendor_id, rfq_item_id) do update set
          offered_cost = excluded.offered_cost, sla_hours = excluded.sla_hours, available_qty = excluded.available_qty,
          alternative_part_number = excluded.alternative_part_number, notes = excluded.notes,
          status_id = excluded.status_id, updated_at = now()`);
    }
    await tx.execute(sql`update rfq_vendors set status_id = ${pricedStatusId}, updated_at = now() where id = ${ids.rfqVendorId}::uuid`);
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
      // can't change winners after the RFQ is confirmed (order_items already snapshotted — review #4)
      await assertRfqNotConfirmed(tx, rfqId, "RFQ already confirmed — winners are locked");

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
        update rfq_items set winning_vendor_quote_item_id = ${quoteItemId}::uuid,
               status_id = ${pricedStatusId}
        where id = ${itemId}::uuid and rfq_id = ${rfqId}::uuid`);
      return { itemId, winningQuoteId: quoteItemId };
    });
  }
}
