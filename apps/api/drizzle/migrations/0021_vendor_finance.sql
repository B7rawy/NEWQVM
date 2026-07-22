CREATE TYPE "public"."financing_status" AS ENUM('pending', 'approved', 'rejected', 'disbursed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_financing_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"requested_amount" numeric(14, 2) NOT NULL,
	"interest_rate_pct" numeric(5, 2) NOT NULL,
	"interest_amount" numeric(14, 2) NOT NULL,
	"status" "financing_status" DEFAULT 'pending' NOT NULL,
	"sla_due_date" timestamp with time zone,
	"approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"allocated_amount" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reference" text,
	"upload_source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "payment_terms_days" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "invoice_amount" numeric(14, 2);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_financing_requests" ADD CONSTRAINT "vendor_financing_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_financing_requests" ADD CONSTRAINT "vendor_financing_requests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_financing_requests" ADD CONSTRAINT "vendor_financing_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_payment_id_vendor_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vfr_tenant_idx" ON "vendor_financing_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vfr_vendor_idx" ON "vendor_financing_requests" USING btree ("tenant_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vfr_approved_by_idx" ON "vendor_financing_requests" USING btree ("approved_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vpa_tenant_idx" ON "vendor_payment_allocations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vpa_payment_idx" ON "vendor_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vpa_po_idx" ON "vendor_payment_allocations" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_payments_tenant_idx" ON "vendor_payments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_payments_vendor_idx" ON "vendor_payments" USING btree ("tenant_id","vendor_id");