import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

export const createCarrierSchema = z.object({
  carrierName: z.string().min(1),
  carrierModel: z.enum(["on_demand_same_city", "hub_dropoff_pickup", "hub_and_spoke", "independent_driver"]),
});
export const createShipmentSchema = z.object({
  orderId: z.string().uuid(),
  carrierSettingId: z.string().uuid().optional(),
  cost: z.number().finite().nonnegative().optional(),
});
export const registerDriverSchema = z.object({
  ownerType: z.enum(["private", "marketplace"]),
  userId: z.string().uuid().optional(),
  vehicleDetails: z.string().optional(),
});

@Injectable()
export class ShippingService {
  constructor(private readonly dbService: DbService) {}

  async createCarrier(ctx: RlsContext, dto: z.infer<typeof createCarrierSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const [c] = await tx
        .insert(schema.shippingCarriers)
        .values({ carrierName: dto.carrierName, carrierModel: dto.carrierModel })
        .returning({ id: schema.shippingCarriers.id });
      return { id: c.id };
    });
  }

  async listCarriers(ctx: RlsContext) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`select id, carrier_name, carrier_model from shipping_carriers where is_active = true order by carrier_name`),
    );
    return { count: rows.length, carriers: rows };
  }

  async createShipment(ctx: RlsContext, dto: z.infer<typeof createShipmentSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const order = (
        (await tx.execute(sql`select id from orders where id = ${dto.orderId}::uuid limit 1`)) as Array<{ id: string }>
      )[0];
      if (!order) throw new NotFoundException("order not found in this workspace");
      const tracking = "TRK-" + randomBytes(5).toString("hex").toUpperCase();
      const [s] = await tx
        .insert(schema.shipments)
        .values({
          tenantId: ctx.tenantId!,
          orderId: dto.orderId,
          entityCarrierSettingId: dto.carrierSettingId,
          trackingNumber: tracking,
          status: "created",
          cost: dto.cost?.toFixed(2),
        })
        .returning({ id: schema.shipments.id });
      return { shipmentId: s.id, trackingNumber: tracking, status: "created" };
    });
  }

  async registerDriver(ctx: RlsContext, dto: z.infer<typeof registerDriverSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const [d] = await tx
        .insert(schema.drivers)
        .values({ tenantId: ctx.tenantId!, ownerType: dto.ownerType, userId: dto.userId, vehicleDetails: dto.vehicleDetails })
        .returning({ id: schema.drivers.id });
      return { driverId: d.id, verificationStatus: "pending" };
    });
  }

  /** Broadcast a delivery to all active marketplace drivers (QNEW-55). */
  async broadcast(ctx: RlsContext, orderId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const drivers = (await tx.execute(sql`
        select id from drivers where tenant_id = ${ctx.tenantId}::uuid and owner_type = 'marketplace' and is_active`)) as Array<{ id: string }>;
      if (drivers.length === 0) throw new BadRequestException("no marketplace drivers available");
      await tx
        .insert(schema.driverDeliveryRequests)
        .values(drivers.map((d) => ({ tenantId: ctx.tenantId!, orderId, driverId: d.id, status: "pending" as const })))
        .onConflictDoNothing();
      return { orderId, broadcastTo: drivers.length };
    });
  }

  /** First driver to accept wins; the rest expire (QNEW-55). */
  async accept(ctx: RlsContext, requestId: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const req = (
        (await tx.execute(sql`select id, order_id, driver_id, status from driver_delivery_requests where id = ${requestId}::uuid limit 1`)) as Array<{ id: string; order_id: string; driver_id: string; status: string }>
      )[0];
      if (!req) throw new NotFoundException("delivery request not found");
      // is it still open (no one accepted for this order yet)?
      const taken = (
        (await tx.execute(sql`select 1 from driver_delivery_requests where order_id = ${req.order_id}::uuid and status = 'accepted' limit 1`)) as Array<unknown>
      )[0];
      if (taken) throw new BadRequestException("delivery already accepted by another driver");

      await tx.execute(sql`update driver_delivery_requests set status = 'accepted', responded_at = now() where id = ${requestId}::uuid`);
      await tx.execute(sql`update driver_delivery_requests set status = 'expired' where order_id = ${req.order_id}::uuid and id <> ${requestId}::uuid and status = 'pending'`);
      return { requestId, orderId: req.order_id, status: "accepted" };
    });
  }
}
