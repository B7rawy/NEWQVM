import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { queuePredicate } from "../workflow/routing.js";
import { z } from "zod";
import { DbService } from "../../db/db.service.js";
import { schema } from "../../db/db.service.js";
import type { RlsContext, Tx } from "../../db/db.service.js";
import { StatusService } from "../../common/status.service.js";

export const createRfqSchema = z.object({
  workshopBranchId: z.string().uuid(),
  plateNumber: z.string().max(32).optional(),
  vin: z.string().max(32).optional(),
  carBrandId: z.string().uuid().optional(),
  model: z.string().max(64).optional(),
  orderType: z.enum(["regular", "bulk"]).default("regular"),
  deliveryType: z.enum(["delivery", "pickup"]).default("delivery"),
  items: z
    .array(
      z.object({
        partNumber: z.string().max(64).optional(),
        partDescription: z.string().max(256).optional(),
        quantity: z.number().int().positive().default(1),
        brandClassId: z.string().uuid().optional(),
        partCategoryId: z.string().uuid().optional(),
      }),
    )
    .min(1, "an RFQ needs at least one item"),
});
export type CreateRfqDto = z.infer<typeof createRfqSchema>;

@Injectable()
export class RfqService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

  /**
   * Create an RFQ header + items in one tenant-scoped transaction. The order number is issued by
   * the atomic next_order_number() (no MAX()+1). RLS + the audit trigger apply automatically; the
   * customer lives at the header (workshop_branch_id), the winning-quote wiring comes later.
   *
   * CREATION IS AN ENTRY EVENT (QNEW-90 item 7). The rows are inserted with NO status and the status
   * is then written by StatusService.enter(), so a new request begins its history properly: a
   * status_logs row saying it arrived at new_rfq from nothing, and a binding to the flow version
   * that was live at the moment it was raised. Writing status_id in the INSERT — as this did until
   * now — made the first status of every record the one status that left no trace.
   */
  async create(ctx: RlsContext, dto: CreateRfqDto) {
    const env = ctx.environment ?? "live";
    return this.dbService.withContext(ctx, async (tx) => {
      // branch's workshop must be LINKED to THIS workspace (workshops are global now, ADR-0011).
      // tenant_workshops is tenant-scoped, so the join enforces the branch belongs to a linked workshop.
      const branch = (
        (await tx.execute(sql`
          select wb.id, wb.region_id, r.code as region_code, w.name as workshop_name
          from workshop_branches wb
          join workshops w on w.id = wb.workshop_id
          join tenant_workshops tw on tw.workshop_id = wb.workshop_id and tw.status <> 'archived'
          left join regions r on r.id = wb.region_id
          where wb.id = ${dto.workshopBranchId}::uuid and wb.is_active = true
          limit 1`)) as Array<{ id: string; region_id: string | null; region_code: string | null; workshop_name: string }>
      )[0];
      if (!branch) throw new BadRequestException("workshop branch not found in this workspace");

      // per-(tenant, prefix) sequence; prefix derived from region (placeholder — configurable later)
      const prefix = branch.region_code
        ? `${branch.region_code.slice(0, 3).toUpperCase()}-`
        : "RFQ-";
      const orderNumber = (
        (await tx.execute(
          sql`select public.next_order_number(${ctx.tenantId}::uuid, ${prefix}, ${branch.region_id}, ${env}) as n`,
        )) as Array<{ n: string }>
      )[0].n;

      // status_id is deliberately absent from both INSERTs: it is written below by the status
      // gateway, which is the only thing in this system allowed to write it (QNEW-75). The column is
      // nullable and the NULL never leaves this transaction.
      const [rfq] = await tx
        .insert(schema.rfqs)
        .values({
          tenantId: ctx.tenantId!,
          environment: env,
          orderNumber,
          workshopBranchId: dto.workshopBranchId,
          plateNumber: dto.plateNumber,
          vin: dto.vin,
          carBrandId: dto.carBrandId,
          model: dto.model,
          orderType: dto.orderType,
          deliveryType: dto.deliveryType,
          customerNameSnapshot: branch.workshop_name, // frozen at creation (QNEW-71 §6.1)
        })
        .returning({ id: schema.rfqs.id });

      const items = await tx
        .insert(schema.rfqItems)
        .values(
          dto.items.map((it) => ({
            tenantId: ctx.tenantId!,
            environment: env, // a line always lives in the same environment as its RFQ
            rfqId: rfq.id,
            partNumber: it.partNumber,
            partDescription: it.partDescription,
            quantity: it.quantity,
            brandClassId: it.brandClassId,
            partCategoryId: it.partCategoryId,
          })),
        )
        .returning({ id: schema.rfqItems.id });

      // The workshop-facing guide price, ported from the legacy get_estimated_price engine
      // (docs/legacy/workshop-logic.md §3.5). Computed in the SAME transaction so the creation
      // response can already show it.
      await this.applyEstimatedPrices(tx, rfq.id);

      // LINES ENTER BEFORE THE HEADER, on purpose. Entering runs the same auto-advance pass every
      // move does, and a gate on an arrow out of new_rfq asks a question about the lines
      // ("every line has reached a status"). With the header first, that pass would judge a request
      // whose lines still had no status at all and answer for a record that does not exist yet.
      await this.status.enterMany(tx, ctx, {
        entity: "rfq_item",
        ids: items.map((i) => i.id),
        toCode: "new_rfq",
      });
      await this.status.enter(tx, ctx, { entity: "rfq", id: rfq.id, toCode: "new_rfq" });

      return { id: rfq.id, orderNumber, itemCount: dto.items.length };
    });
  }

  async list(ctx: RlsContext, queue?: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select r.id, r.order_number, r.plate_number, s.label_en as status,
               (select count(*)::int from rfq_items i where i.rfq_id = r.id) as items
        from rfqs r
        left join item_statuses s on s.id = r.status_id
        where r.environment = ${ctx.environment ?? "live"}
          and ${queuePredicate(sql`s.code`, queue)}
        order by r.created_at desc
        limit 50`),
    );
    return { count: rows.length, rfqs: rows };
  }

  /** Full RFQ detail: header + items + invited vendors. Scoped to workspace + environment. */
  async detail(ctx: RlsContext, id: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rfq = (
        (await tx.execute(sql`
          select r.id, r.order_number, r.plate_number, r.vin, r.model, r.order_type, r.delivery_type,
                 r.payer_type, r.environment, r.created_at, s.label_en as status,
                 s.code as status_code, coalesce(r.customer_name_snapshot, w.name) as workshop, wb.name as branch
          from rfqs r
          left join item_statuses s on s.id = r.status_id
          left join workshop_branches wb on wb.id = r.workshop_branch_id
          left join workshops w on w.id = wb.workshop_id
          where r.id = ${id}::uuid and r.environment = ${ctx.environment ?? "live"} limit 1`)) as Array<Record<string, unknown>>
      )[0];
      if (!rfq) throw new NotFoundException("RFQ not found in this workspace / environment");

      const items = await tx.execute(sql`
        select i.id, i.part_number, i.part_description, i.quantity, s.label_en as status
        from rfq_items i left join item_statuses s on s.id = i.status_id
        where i.rfq_id = ${id}::uuid order by i.created_at`);

      const vendors = await tx.execute(sql`
        select rv.id, v.legal_name as vendor, rv.sent_at, vs.label_en as status,
               (select count(*)::int from rfq_vendor_items vi
                where vi.rfq_vendor_id = rv.id and vi.offered_cost is not null) as quoted
        from rfq_vendors rv
        join vendors v on v.id = rv.vendor_id
        left join vendor_statuses vs on vs.id = rv.status_id
        where rv.rfq_id = ${id}::uuid order by rv.sent_at desc nulls last`);

      return { rfq, items, vendors };
    });
  }
  /**
   * ESTIMATED PRICE — the legacy engine, ported (docs/legacy/workshop-logic.md §3.5).
   *
   * Per item, in strict order:
   *   (a) the same WORKSHOP bought the same part_number + brand_class in the last 60 days and it
   *       was priced → that selling price, verbatim (their own recent price is the best guide);
   *   (b) else the latest VENDOR cost for the part+class anywhere in this workspace, aged like the
   *       legacy table: ≤90d as-is, ≤180d +1%, ≤360d +3%, older +7%;
   *   (c) else NULL — which the UI renders as "needs manual review", never as zero.
   *
   * It is a guide, not a price: selling_price remains the only amount anything is billed from.
   * One UPDATE for the whole RFQ rather than a query per item, because creation calls this inline.
   */
  async applyEstimatedPrices(tx: Tx, rfqId: string, onlyItemIds?: string[]): Promise<void> {
    await tx.execute(sql`
      update rfq_items ri
      set estimated_price = est.price, updated_at = now()
      from (
        select i.id,
          coalesce(
            (select ri2.selling_price
               from rfq_items ri2
               join rfqs r2 on r2.id = ri2.rfq_id
               join workshop_branches wb2 on wb2.id = r2.workshop_branch_id
              where wb2.workshop_id = (select wb.workshop_id from workshop_branches wb
                                        join rfqs r on r.workshop_branch_id = wb.id
                                        where r.id = ${rfqId}::uuid)
                and ri2.part_number = i.part_number
                and ri2.brand_class_id is not distinct from i.brand_class_id
                and ri2.selling_price is not null
                and ri2.id <> i.id
                and r2.created_at >= now() - interval '60 days'
              order by r2.created_at desc limit 1),
            (select round(vi.offered_cost * (1 + case
                     when now() - vi.created_at <= interval '90 days' then 0
                     when now() - vi.created_at <= interval '180 days' then 0.01
                     when now() - vi.created_at <= interval '360 days' then 0.03
                     else 0.07 end), 2)
               from rfq_vendor_items vi
               join rfq_items ri3 on ri3.id = vi.rfq_item_id
              where ri3.part_number = i.part_number
                and ri3.brand_class_id is not distinct from i.brand_class_id
                and vi.offered_cost is not null
              order by vi.created_at desc limit 1)
          ) as price
        from rfq_items i
        where i.rfq_id = ${rfqId}::uuid and i.part_number is not null
          and (${onlyItemIds?.length ? sql`i.id = any(array[${sql.join(onlyItemIds.map((x) => sql`${x}::uuid`), sql`, `)}])` : sql`true`})
      ) est
      where est.id = ri.id and est.price is not null`);
  }

}
