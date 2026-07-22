import { BadRequestException, Injectable } from "@nestjs/common";
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
      // branch must belong to THIS workspace (RLS already scopes; this also fetches its region)
      const branch = (
        (await tx.execute(sql`
          select wb.id, wb.region_id, r.code as region_code
          from workshop_branches wb
          left join regions r on r.id = wb.region_id
          where wb.id = ${dto.workshopBranchId}::uuid and wb.is_active = true
          limit 1`)) as Array<{ id: string; region_id: string | null; region_code: string | null }>
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
          orderNumber,
          workshopBranchId: dto.workshopBranchId,
          plateNumber: dto.plateNumber,
          vin: dto.vin,
          carBrandId: dto.carBrandId,
          model: dto.model,
          orderType: dto.orderType,
          deliveryType: dto.deliveryType,
          statusId: newStatusId,
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
               (select count(*) from rfq_items i where i.rfq_id = r.id) as items
        from rfqs r
        left join item_statuses s on s.id = r.status_id
        order by r.created_at desc
        limit 50`),
    );
    return { count: rows.length, rfqs: rows };
  }
}
