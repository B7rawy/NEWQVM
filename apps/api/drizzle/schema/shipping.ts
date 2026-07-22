import { integer, pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { audit, isActive, money, pk } from "./_shared";
import {
  carrierModel,
  carrierOwnerType,
  driverOwnerType,
  driverRequestStatus,
  shipmentStatus,
} from "./enums";
import { tenants } from "./tenancy";
import { users } from "./identity";
import { orders } from "./orders";

/** Shipping / logistics (QNEW-54/55). */

/** Admin carrier catalog (global). Each carrier product is its own row. */
export const shippingCarriers = pgTable("shipping_carriers", {
  id: pk(),
  carrierName: text("carrier_name").notNull(),
  carrierModel: carrierModel("carrier_model").notNull(),
  isActiveGlobally: isActive(),
  ...audit,
});

/** A carrier enabled for a vendor or client branch (tenant-scoped, admin-enabled). */
export const entityCarrierSettings = pgTable(
  "entity_carrier_settings",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ownerType: carrierOwnerType("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    carrierId: uuid("carrier_id")
      .notNull()
      .references(() => shippingCarriers.id),
    defaultPickupLocation: text("default_pickup_location"),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    index("entity_carrier_tenant_idx").on(t.tenantId),
    index("entity_carrier_owner_idx").on(t.tenantId, t.ownerType, t.ownerId),
    index("entity_carrier_carrier_idx").on(t.carrierId),
  ],
);

/** Independent / in-house drivers (QNEW-55). Ratings/coverage/pricing come later. */
export const drivers = pgTable(
  "drivers",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    ownerType: driverOwnerType("owner_type").notNull(),
    userId: uuid("user_id").references(() => users.id),
    vehicleDetails: text("vehicle_details"),
    verificationStatus: text("verification_status").notNull().default("pending"),
    completedOrdersCount: integer("completed_orders_count").notNull().default(0),
    isActive: isActive(),
    ...audit,
  },
  (t) => [
    index("drivers_tenant_idx").on(t.tenantId),
    index("drivers_user_idx").on(t.userId),
  ],
);

/** A shipment for an order — via a carrier setting or a driver. */
export const shipments = pgTable(
  "shipments",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    entityCarrierSettingId: uuid("entity_carrier_setting_id").references(() => entityCarrierSettings.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    trackingNumber: text("tracking_number"),
    status: shipmentStatus("status").notNull().default("created"),
    cost: money("cost"),
    ...audit,
  },
  (t) => [
    index("shipments_tenant_idx").on(t.tenantId),
    index("shipments_order_idx").on(t.orderId),
    index("shipments_carrier_setting_idx").on(t.entityCarrierSettingId),
    index("shipments_driver_idx").on(t.driverId),
  ],
);

/** Broadcast delivery offers to marketplace drivers; first to accept wins (details hidden until accept). */
export const driverDeliveryRequests = pgTable(
  "driver_delivery_requests",
  {
    id: pk(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id),
    status: driverRequestStatus("status").notNull().default("pending"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    ...audit,
  },
  (t) => [
    uniqueIndex("ddr_order_driver_uq").on(t.orderId, t.driverId),
    // at most ONE accepted driver per order — enforces first-accept-wins at the DB level
    uniqueIndex("ddr_one_accepted_per_order_uq")
      .on(t.orderId)
      .where(sql`status = 'accepted'`),
    index("ddr_tenant_idx").on(t.tenantId),
    index("ddr_order_idx").on(t.orderId),
    index("ddr_driver_idx").on(t.driverId),
  ],
);
