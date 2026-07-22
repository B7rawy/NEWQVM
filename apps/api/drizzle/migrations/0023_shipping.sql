CREATE TYPE "public"."carrier_model" AS ENUM('on_demand_same_city', 'hub_dropoff_pickup', 'hub_and_spoke', 'independent_driver');--> statement-breakpoint
CREATE TYPE "public"."carrier_owner_type" AS ENUM('vendor', 'client_branch');--> statement-breakpoint
CREATE TYPE "public"."driver_owner_type" AS ENUM('private', 'marketplace');--> statement-breakpoint
CREATE TYPE "public"."driver_request_status" AS ENUM('pending', 'accepted', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."shipment_status" AS ENUM('created', 'assigned', 'in_transit', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "driver_delivery_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"status" "driver_request_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_type" "driver_owner_type" NOT NULL,
	"user_id" uuid,
	"vehicle_details" text,
	"verification_status" text DEFAULT 'pending' NOT NULL,
	"completed_orders_count" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_carrier_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_type" "carrier_owner_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"carrier_id" uuid NOT NULL,
	"default_pickup_location" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"entity_carrier_setting_id" uuid,
	"driver_id" uuid,
	"tracking_number" text,
	"status" "shipment_status" DEFAULT 'created' NOT NULL,
	"cost" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shipping_carriers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carrier_name" text NOT NULL,
	"carrier_model" "carrier_model" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_delivery_requests" ADD CONSTRAINT "driver_delivery_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_delivery_requests" ADD CONSTRAINT "driver_delivery_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "driver_delivery_requests" ADD CONSTRAINT "driver_delivery_requests_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drivers" ADD CONSTRAINT "drivers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "drivers" ADD CONSTRAINT "drivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_carrier_settings" ADD CONSTRAINT "entity_carrier_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_carrier_settings" ADD CONSTRAINT "entity_carrier_settings_carrier_id_shipping_carriers_id_fk" FOREIGN KEY ("carrier_id") REFERENCES "public"."shipping_carriers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_entity_carrier_setting_id_entity_carrier_settings_id_fk" FOREIGN KEY ("entity_carrier_setting_id") REFERENCES "public"."entity_carrier_settings"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shipments" ADD CONSTRAINT "shipments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ddr_order_driver_uq" ON "driver_delivery_requests" USING btree ("order_id","driver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ddr_tenant_idx" ON "driver_delivery_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ddr_order_idx" ON "driver_delivery_requests" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ddr_driver_idx" ON "driver_delivery_requests" USING btree ("driver_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drivers_tenant_idx" ON "drivers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "drivers_user_idx" ON "drivers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_carrier_tenant_idx" ON "entity_carrier_settings" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_carrier_owner_idx" ON "entity_carrier_settings" USING btree ("tenant_id","owner_type","owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_carrier_carrier_idx" ON "entity_carrier_settings" USING btree ("carrier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_tenant_idx" ON "shipments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_order_idx" ON "shipments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_carrier_setting_idx" ON "shipments" USING btree ("entity_carrier_setting_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipments_driver_idx" ON "shipments" USING btree ("driver_id");