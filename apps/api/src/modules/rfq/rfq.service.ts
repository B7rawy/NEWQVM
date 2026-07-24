import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService } from "../../db/db.service.js";
import { schema } from "../../db/db.service.js";
import type { RlsContext } from "../../db/db.service.js";

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
  constructor(private readonly dbService: DbService) {}

  /**
   * Create an RFQ header + items in one tenant-scoped transaction. The order number is issued by
   * the atomic next_order_number() (no MAX()+1). RLS + the audit trigger apply automatically; the
   * customer lives at the header (workshop_branch_id), the winning-quote wiring comes later.
   */
  async create(ctx: RlsContext, dto: CreateRfqDto) {
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
          sql`select public.next_order_number(${ctx.tenantId}::uuid, ${prefix}, ${branch.region_id}) as n`,
        )) as Array<{ n: string }>
      )[0].n;

      const newStatusId = (
        (await tx.execute(
          sql`select id from item_statuses where code = 'new_rfq' limit 1`,
        )) as Array<{ id: string }>
      )[0].id;

      const [rfq] = await tx
        .insert(schema.rfqs)
        .values({
          tenantId: ctx.tenantId!,
          environment: ctx.environment ?? "live",
          orderNumber,
          workshopBranchId: dto.workshopBranchId,
          plateNumber: dto.plateNumber,
          vin: dto.vin,
          carBrandId: dto.carBrandId,
          model: dto.model,
          orderType: dto.orderType,
          deliveryType: dto.deliveryType,
          statusId: newStatusId,
          customerNameSnapshot: branch.workshop_name, // frozen at creation (QNEW-71 §6.1)
        })
        .returning({ id: schema.rfqs.id });

      await tx.insert(schema.rfqItems).values(
        dto.items.map((it) => ({
          tenantId: ctx.tenantId!,
          rfqId: rfq.id,
          partNumber: it.partNumber,
          partDescription: it.partDescription,
          quantity: it.quantity,
          brandClassId: it.brandClassId,
          partCategoryId: it.partCategoryId,
          statusId: newStatusId,
        })),
      );

      return { id: rfq.id, orderNumber, itemCount: dto.items.length };
    });
  }

  async list(ctx: RlsContext) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select r.id, r.order_number, r.plate_number, s.label_en as status,
               (select count(*)::int from rfq_items i where i.rfq_id = r.id) as items
        from rfqs r
        left join item_statuses s on s.id = r.status_id
        where r.environment = ${ctx.environment ?? "live"}
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
}
