import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";

const TOKEN_TTL_DAYS = 7;

export const sendRfqSchema = z.object({ vendorIds: z.array(z.string().uuid()).min(1) });
export type SendRfqDto = z.infer<typeof sendRfqSchema>;

export const submitQuoteSchema = z.object({
  items: z
    .array(
      z.object({
        rfqItemId: z.string().uuid(),
        offeredCost: z.number().nonnegative(),
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

      const results: Array<{ vendorId: string; token: string; notify: string }> = [];
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

        const notify = await this.notifications.send(tx, {
          tenantId: ctx.tenantId!,
          isSandbox,
          channel: "email",
          recipient: link.primary_email ?? undefined,
          template: "vendor_rfq_invite",
          payload: { rfqId, quoteUrl: `/quote-access/${rawToken}` },
        });

        results.push({ vendorId, token: rawToken, notify: notify.status });
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
    return this.dbService.withContext(
      { tenantId: rv.tenant_id, userId: null, isInternal: false },
      async (tx) => {
        const pricedStatusId = (
          (await tx.execute(
            sql`select id from vendor_statuses where code = 'priced' limit 1`,
          )) as Array<{ id: string }>
        )[0].id;

        // only items that actually belong to this RFQ
        const validItemIds = new Set(
          (
            (await tx.execute(
              sql`select id from rfq_items where rfq_id = ${rv.rfq_id}::uuid`,
            )) as Array<{ id: string }>
          ).map((r) => r.id),
        );
        const items = dto.items.filter((i) => validItemIds.has(i.rfqItemId));
        if (items.length === 0) throw new BadRequestException("no valid items for this RFQ");

        for (const it of items) {
          await tx
            .insert(schema.rfqVendorItems)
            .values({
              tenantId: rv.tenant_id,
              rfqVendorId: rv.id,
              rfqItemId: it.rfqItemId,
              offeredCost: it.offeredCost.toFixed(2),
              slaHours: it.slaHours,
              availableQty: it.availableQty,
              alternativePartNumber: it.alternativePartNumber,
              notes: it.notes,
              statusId: pricedStatusId,
            })
            .onConflictDoNothing();
        }
        await tx.execute(
          sql`update rfq_vendors set status_id = ${pricedStatusId} where id = ${rv.id}::uuid`,
        );
        return { quoted: items.length };
      },
    );
  }
}
