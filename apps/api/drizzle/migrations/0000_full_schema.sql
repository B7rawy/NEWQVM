CREATE TYPE "public"."delivery_type" AS ENUM('delivery', 'pickup');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('rfq', 'rfq_item', 'rfq_vendor', 'order', 'order_item', 'purchase_order', 'delivery', 'return', 'return_issue', 'invoice', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('pending', 'extracted', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('super_admin', 'staff', 'account_manager', 'purchasing', 'part_extractor', 'company_admin', 'branch_manager', 'service_advisor', 'vendor_admin', 'vendor_user');--> statement-breakpoint
CREATE TYPE "public"."order_category" AS ENUM('regular', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('regular', 'bulk');--> statement-breakpoint
CREATE TYPE "public"."pricing_source" AS ENUM('internal_erp', 'external_excel', 'external_api', 'manual', 'agency_catalog');--> statement-breakpoint
CREATE TYPE "public"."return_responsibility" AS ENUM('internal', 'vendor', 'client', 'delivery_agent');--> statement-breakpoint
CREATE TYPE "public"."vendor_type" AS ENUM('agency', 'commercial', 'external');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bonus_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brand_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cancellation_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "car_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"region_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_ranges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "part_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"label_en" text NOT NULL,
	"label_ar" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"legacy_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_url" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"plan_id" uuid,
	"is_sandbox" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"workshop_branch_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "tenant_memberships_tenant_user_role_uq" UNIQUE("tenant_id","user_id","role")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"full_name" text NOT NULL,
	"phone" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workshop_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workshop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"region_id" uuid,
	"city_id" uuid,
	"order_category" "order_category" DEFAULT 'regular' NOT NULL,
	"is_bulk" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workshops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tax_number" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"payment_terms" text,
	"classification" text,
	"agreement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"linked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"region_id" uuid,
	"city_id" uuid,
	"address" text,
	"location" text,
	"payment_method" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendor_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_vendor_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"commercial_registration_number" text,
	"tax_number" text,
	"primary_email" text,
	"primary_phone" text,
	"vendor_type" "vendor_type" DEFAULT 'commercial' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"part_number" text,
	"part_description" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"brand_class_id" uuid,
	"part_category_id" uuid,
	"part_photo_key" text,
	"vin" text,
	"status_id" uuid,
	"selling_price" numeric(14, 2),
	"discount_pct" numeric(5, 2),
	"agency_price" numeric(14, 2),
	"winning_vendor_quote_item_id" uuid,
	"extraction_status" "extraction_status",
	"extracted_by" uuid,
	"extracted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_vendor_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_vendor_id" uuid NOT NULL,
	"rfq_item_id" uuid NOT NULL,
	"offered_cost" numeric(14, 2),
	"discount_pct" numeric(5, 2),
	"sla_hours" integer,
	"available_qty" integer,
	"available_brand_class_id" uuid,
	"alternative_part_number" text,
	"status_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfq_vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_branch_id" uuid,
	"status_id" uuid,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rfqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"workshop_branch_id" uuid NOT NULL,
	"plate_number" text,
	"vin" text,
	"car_brand_id" uuid,
	"model" text,
	"order_type" "order_type" DEFAULT 'regular' NOT NULL,
	"delivery_type" "delivery_type" DEFAULT 'delivery' NOT NULL,
	"service_advisor_id" uuid,
	"account_manager_id" uuid,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"rfq_item_id" uuid NOT NULL,
	"final_part_number" text,
	"approved_qty" integer,
	"winning_vendor_quote_item_id" uuid,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"client_po" text,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pickup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pickup_id" uuid NOT NULL,
	"purchase_item_id" uuid NOT NULL,
	"qty" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pickups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"delivery_agent_id" uuid,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"vendor_quote_item_id" uuid,
	"qty" integer,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"payment_account_id" uuid,
	"status_id" uuid,
	"vendor_invoice_number" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"delivery_number" text,
	"client_po" text,
	"signature_id" uuid,
	"signed_by" uuid,
	"status_id" uuid,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"responsibility" "return_responsibility",
	"issue_type" text,
	"delivery_agent_id" uuid,
	"main_vendor_id" uuid,
	"part_number_source" text,
	"notes" text,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "return_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer,
	"return_reason_id" uuid,
	"responsibility" "return_responsibility",
	"credit_note_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"return_number" text,
	"signature_id" uuid,
	"signed_by" uuid,
	"status_id" uuid,
	"returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"image_key" text NOT NULL,
	"signed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_note_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer,
	"return_reason_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"credit_note_number" text,
	"issued_at" timestamp with time zone,
	"total" numeric(14, 2),
	"external_ref" text,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoice_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"qty" integer,
	"unit_price" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"invoice_number" text,
	"issued_at" timestamp with time zone,
	"due_date" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"total_before_vat" numeric(14, 2),
	"vat_amount" numeric(14, 2),
	"total_incl_vat" numeric(14, 2),
	"external_ref" text,
	"status_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_item_id" uuid,
	"vendor_id" uuid,
	"cost" numeric(14, 2),
	"pricing_source" "pricing_source",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pricing_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rfq_item_id" uuid,
	"price" numeric(14, 2),
	"pricing_source" "pricing_source",
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profit_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text,
	"part_category_id" uuid,
	"brand_class_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profit_margin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profit_margin_id" uuid,
	"old_value" numeric(5, 2),
	"new_value" numeric(5, 2),
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profit_margins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"profit_category_id" uuid NOT NULL,
	"cost_range_id" uuid,
	"margin_pct" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profit_margins_branch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workshop_branch_id" uuid NOT NULL,
	"profit_category_id" uuid NOT NULL,
	"cost_range_id" uuid,
	"margin_pct" numeric(5, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_date" timestamp with time zone,
	"part_number" text,
	"brand_class_id" uuid,
	"car_brand_id" uuid,
	"cost_before_discount" numeric(14, 2),
	"discount_pct" numeric(5, 2),
	"vendor_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text,
	"mime_type" text,
	"size_bytes" bigint,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "order_number_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"region_id" uuid,
	"prefix" text NOT NULL,
	"next_value" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_number_counters_scope_uq" UNIQUE("tenant_id","region_id","prefix")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"from_status_id" uuid,
	"to_status_id" uuid,
	"changed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cities" ADD CONSTRAINT "cities_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenants" ADD CONSTRAINT "tenants_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_workshop_branch_id_workshop_branches_id_fk" FOREIGN KEY ("workshop_branch_id") REFERENCES "public"."workshop_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_branches" ADD CONSTRAINT "workshop_branches_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_branches" ADD CONSTRAINT "workshop_branches_workshop_id_workshops_id_fk" FOREIGN KEY ("workshop_id") REFERENCES "public"."workshops"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_branches" ADD CONSTRAINT "workshop_branches_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshop_branches" ADD CONSTRAINT "workshop_branches_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workshops" ADD CONSTRAINT "workshops_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_vendors" ADD CONSTRAINT "tenant_vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_vendors" ADD CONSTRAINT "tenant_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_vendors" ADD CONSTRAINT "tenant_vendors_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_branches" ADD CONSTRAINT "vendor_branches_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_branches" ADD CONSTRAINT "vendor_branches_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_branches" ADD CONSTRAINT "vendor_branches_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "vendor_users" ADD CONSTRAINT "vendor_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_brand_class_id_brand_classes_id_fk" FOREIGN KEY ("brand_class_id") REFERENCES "public"."brand_classes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_part_category_id_part_categories_id_fk" FOREIGN KEY ("part_category_id") REFERENCES "public"."part_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_winning_vendor_quote_item_id_rfq_vendor_items_id_fk" FOREIGN KEY ("winning_vendor_quote_item_id") REFERENCES "public"."rfq_vendor_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_extracted_by_users_id_fk" FOREIGN KEY ("extracted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendor_items" ADD CONSTRAINT "rfq_vendor_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendor_items" ADD CONSTRAINT "rfq_vendor_items_rfq_vendor_id_rfq_vendors_id_fk" FOREIGN KEY ("rfq_vendor_id") REFERENCES "public"."rfq_vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendor_items" ADD CONSTRAINT "rfq_vendor_items_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendor_items" ADD CONSTRAINT "rfq_vendor_items_available_brand_class_id_brand_classes_id_fk" FOREIGN KEY ("available_brand_class_id") REFERENCES "public"."brand_classes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendor_items" ADD CONSTRAINT "rfq_vendor_items_status_id_vendor_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendors" ADD CONSTRAINT "rfq_vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendors" ADD CONSTRAINT "rfq_vendors_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendors" ADD CONSTRAINT "rfq_vendors_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendors" ADD CONSTRAINT "rfq_vendors_vendor_branch_id_vendor_branches_id_fk" FOREIGN KEY ("vendor_branch_id") REFERENCES "public"."vendor_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfq_vendors" ADD CONSTRAINT "rfq_vendors_status_id_vendor_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_workshop_branch_id_workshop_branches_id_fk" FOREIGN KEY ("workshop_branch_id") REFERENCES "public"."workshop_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_car_brand_id_car_brands_id_fk" FOREIGN KEY ("car_brand_id") REFERENCES "public"."car_brands"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_service_advisor_id_users_id_fk" FOREIGN KEY ("service_advisor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_winning_vendor_quote_item_id_rfq_vendor_items_id_fk" FOREIGN KEY ("winning_vendor_quote_item_id") REFERENCES "public"."rfq_vendor_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_items" ADD CONSTRAINT "order_items_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickup_items" ADD CONSTRAINT "pickup_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickup_items" ADD CONSTRAINT "pickup_items_pickup_id_pickups_id_fk" FOREIGN KEY ("pickup_id") REFERENCES "public"."pickups"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickup_items" ADD CONSTRAINT "pickup_items_purchase_item_id_purchase_items_id_fk" FOREIGN KEY ("purchase_item_id") REFERENCES "public"."purchase_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickups" ADD CONSTRAINT "pickups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickups" ADD CONSTRAINT "pickups_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickups" ADD CONSTRAINT "pickups_delivery_agent_id_users_id_fk" FOREIGN KEY ("delivery_agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pickups" ADD CONSTRAINT "pickups_status_id_vendor_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_vendor_quote_item_id_rfq_vendor_items_id_fk" FOREIGN KEY ("vendor_quote_item_id") REFERENCES "public"."rfq_vendor_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_status_id_vendor_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_payment_account_id_payment_accounts_id_fk" FOREIGN KEY ("payment_account_id") REFERENCES "public"."payment_accounts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_status_id_vendor_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."vendor_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_signature_id_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."signatures"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "delivery_items" ADD CONSTRAINT "delivery_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_issues" ADD CONSTRAINT "return_issues_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_issues" ADD CONSTRAINT "return_issues_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_issues" ADD CONSTRAINT "return_issues_delivery_agent_id_users_id_fk" FOREIGN KEY ("delivery_agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_issues" ADD CONSTRAINT "return_issues_main_vendor_id_vendors_id_fk" FOREIGN KEY ("main_vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_issues" ADD CONSTRAINT "return_issues_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_return_reason_id_return_reasons_id_fk" FOREIGN KEY ("return_reason_id") REFERENCES "public"."return_reasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "return_items" ADD CONSTRAINT "return_items_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_signature_id_signatures_id_fk" FOREIGN KEY ("signature_id") REFERENCES "public"."signatures"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "returns" ADD CONSTRAINT "returns_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signatures" ADD CONSTRAINT "signatures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_note_items" ADD CONSTRAINT "credit_note_items_return_reason_id_return_reasons_id_fk" FOREIGN KEY ("return_reason_id") REFERENCES "public"."return_reasons"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invoices" ADD CONSTRAINT "invoices_status_id_item_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_logs" ADD CONSTRAINT "cost_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_logs" ADD CONSTRAINT "cost_logs_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_logs" ADD CONSTRAINT "cost_logs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_logs" ADD CONSTRAINT "cost_logs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_logs" ADD CONSTRAINT "pricing_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_logs" ADD CONSTRAINT "pricing_logs_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pricing_logs" ADD CONSTRAINT "pricing_logs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_categories" ADD CONSTRAINT "profit_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_categories" ADD CONSTRAINT "profit_categories_part_category_id_part_categories_id_fk" FOREIGN KEY ("part_category_id") REFERENCES "public"."part_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_categories" ADD CONSTRAINT "profit_categories_brand_class_id_brand_classes_id_fk" FOREIGN KEY ("brand_class_id") REFERENCES "public"."brand_classes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margin_audit" ADD CONSTRAINT "profit_margin_audit_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margin_audit" ADD CONSTRAINT "profit_margin_audit_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins" ADD CONSTRAINT "profit_margins_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins" ADD CONSTRAINT "profit_margins_profit_category_id_profit_categories_id_fk" FOREIGN KEY ("profit_category_id") REFERENCES "public"."profit_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins" ADD CONSTRAINT "profit_margins_cost_range_id_cost_ranges_id_fk" FOREIGN KEY ("cost_range_id") REFERENCES "public"."cost_ranges"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins_branch" ADD CONSTRAINT "profit_margins_branch_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins_branch" ADD CONSTRAINT "profit_margins_branch_workshop_branch_id_workshop_branches_id_fk" FOREIGN KEY ("workshop_branch_id") REFERENCES "public"."workshop_branches"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins_branch" ADD CONSTRAINT "profit_margins_branch_profit_category_id_profit_categories_id_fk" FOREIGN KEY ("profit_category_id") REFERENCES "public"."profit_categories"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "profit_margins_branch" ADD CONSTRAINT "profit_margins_branch_cost_range_id_cost_ranges_id_fk" FOREIGN KEY ("cost_range_id") REFERENCES "public"."cost_ranges"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_files" ADD CONSTRAINT "stock_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_files" ADD CONSTRAINT "stock_files_brand_class_id_brand_classes_id_fk" FOREIGN KEY ("brand_class_id") REFERENCES "public"."brand_classes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_files" ADD CONSTRAINT "stock_files_car_brand_id_car_brands_id_fk" FOREIGN KEY ("car_brand_id") REFERENCES "public"."car_brands"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "stock_files" ADD CONSTRAINT "stock_files_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_from_status_id_item_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_to_status_id_item_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."item_statuses"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_logs" ADD CONSTRAINT "status_logs_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cities_region_idx" ON "cities" USING btree ("region_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "item_statuses_code_uq" ON "item_statuses" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_statuses_code_uq" ON "vendor_statuses" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_uq" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_tenant_idx" ON "tenant_memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_user_idx" ON "tenant_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_memberships_branch_idx" ON "tenant_memberships" USING btree ("workshop_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_branches_tenant_idx" ON "workshop_branches" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_branches_workshop_idx" ON "workshop_branches" USING btree ("workshop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_branches_region_idx" ON "workshop_branches" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshop_branches_city_idx" ON "workshop_branches" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workshops_tenant_idx" ON "workshops" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_vendors_tenant_vendor_uq" ON "tenant_vendors" USING btree ("tenant_id","vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_vendors_tenant_idx" ON "tenant_vendors" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_vendors_vendor_idx" ON "tenant_vendors" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_branches_vendor_idx" ON "vendor_branches" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_branches_region_idx" ON "vendor_branches" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_branches_city_idx" ON "vendor_branches" USING btree ("city_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_users_vendor_user_uq" ON "vendor_users" USING btree ("vendor_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_users_user_idx" ON "vendor_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_tenant_idx" ON "rfq_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_rfq_idx" ON "rfq_items" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_tenant_status_idx" ON "rfq_items" USING btree ("tenant_id","status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_brand_class_idx" ON "rfq_items" USING btree ("brand_class_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_items_part_category_idx" ON "rfq_items" USING btree ("part_category_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_vendor_items_vendor_item_uq" ON "rfq_vendor_items" USING btree ("rfq_vendor_id","rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendor_items_tenant_idx" ON "rfq_vendor_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendor_items_rfq_item_idx" ON "rfq_vendor_items" USING btree ("rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendor_items_brand_class_idx" ON "rfq_vendor_items" USING btree ("available_brand_class_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendor_items_status_idx" ON "rfq_vendor_items" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendors_tenant_idx" ON "rfq_vendors" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendors_rfq_idx" ON "rfq_vendors" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendors_vendor_idx" ON "rfq_vendors" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendors_branch_idx" ON "rfq_vendors" USING btree ("vendor_branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfq_vendors_status_idx" ON "rfq_vendors" USING btree ("status_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfqs_tenant_order_number_uq" ON "rfqs" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_tenant_idx" ON "rfqs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_tenant_branch_idx" ON "rfqs" USING btree ("tenant_id","workshop_branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_tenant_status_idx" ON "rfqs" USING btree ("tenant_id","status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_service_advisor_idx" ON "rfqs" USING btree ("service_advisor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_account_manager_idx" ON "rfqs" USING btree ("account_manager_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rfqs_car_brand_idx" ON "rfqs" USING btree ("car_brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_items_rfq_item_uq" ON "order_items" USING btree ("rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_tenant_idx" ON "order_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_tenant_status_idx" ON "order_items" USING btree ("tenant_id","status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_items_winning_quote_idx" ON "order_items" USING btree ("winning_vendor_quote_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tenant_order_number_uq" ON "orders" USING btree ("tenant_id","order_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_idx" ON "orders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_rfq_idx" ON "orders" USING btree ("rfq_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickup_items_tenant_idx" ON "pickup_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickup_items_pickup_idx" ON "pickup_items" USING btree ("pickup_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickup_items_purchase_item_idx" ON "pickup_items" USING btree ("purchase_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickups_tenant_idx" ON "pickups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickups_po_idx" ON "pickups" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pickups_agent_idx" ON "pickups" USING btree ("delivery_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_tenant_idx" ON "purchase_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_po_idx" ON "purchase_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_order_item_idx" ON "purchase_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_quote_idx" ON "purchase_items" USING btree ("vendor_quote_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_items_status_idx" ON "purchase_items" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_tenant_idx" ON "purchase_orders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_order_idx" ON "purchase_orders" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_vendor_idx" ON "purchase_orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_payment_account_idx" ON "purchase_orders" USING btree ("payment_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "purchase_orders_status_idx" ON "purchase_orders" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_tenant_idx" ON "deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_order_idx" ON "deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliveries_status_idx" ON "deliveries" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_items_tenant_idx" ON "delivery_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_items_delivery_idx" ON "delivery_items" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_items_order_item_idx" ON "delivery_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_items_invoice_idx" ON "delivery_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_issues_tenant_idx" ON "return_issues" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_issues_order_item_idx" ON "return_issues" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_issues_agent_idx" ON "return_issues" USING btree ("delivery_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_issues_vendor_idx" ON "return_issues" USING btree ("main_vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_issues_status_idx" ON "return_issues" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_items_tenant_idx" ON "return_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_items_return_idx" ON "return_items" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_items_order_item_idx" ON "return_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_items_reason_idx" ON "return_items" USING btree ("return_reason_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "return_items_credit_note_idx" ON "return_items" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_tenant_idx" ON "returns" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_order_idx" ON "returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "returns_status_idx" ON "returns" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signatures_tenant_idx" ON "signatures" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_items_tenant_idx" ON "credit_note_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_items_cn_idx" ON "credit_note_items" USING btree ("credit_note_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_note_items_order_item_idx" ON "credit_note_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_notes_tenant_idx" ON "credit_notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_notes_order_idx" ON "credit_notes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_notes_status_idx" ON "credit_notes" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_items_tenant_idx" ON "invoice_items" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_items_invoice_idx" ON "invoice_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_items_order_item_idx" ON "invoice_items" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_order_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON "invoices" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_logs_tenant_idx" ON "cost_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_logs_rfq_item_idx" ON "cost_logs" USING btree ("rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_logs_vendor_idx" ON "cost_logs" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_logs_tenant_idx" ON "pricing_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_logs_rfq_item_idx" ON "pricing_logs" USING btree ("rfq_item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_categories_tenant_idx" ON "profit_categories" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_categories_part_cat_idx" ON "profit_categories" USING btree ("part_category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_categories_brand_class_idx" ON "profit_categories" USING btree ("brand_class_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margin_audit_tenant_idx" ON "profit_margin_audit" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_tenant_idx" ON "profit_margins" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_category_idx" ON "profit_margins" USING btree ("profit_category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_cost_range_idx" ON "profit_margins" USING btree ("cost_range_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_branch_tenant_idx" ON "profit_margins_branch" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_branch_branch_idx" ON "profit_margins_branch" USING btree ("workshop_branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profit_margins_branch_category_idx" ON "profit_margins_branch" USING btree ("profit_category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_files_tenant_idx" ON "stock_files" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_files_part_number_idx" ON "stock_files" USING btree ("tenant_id","part_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_files_vendor_idx" ON "stock_files" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_files_brand_class_idx" ON "stock_files" USING btree ("brand_class_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_files_car_brand_idx" ON "stock_files" USING btree ("car_brand_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_tenant_idx" ON "attachments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_entity_idx" ON "attachments" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_tenant_idx" ON "notes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_entity_idx" ON "notes" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_number_counters_tenant_idx" ON "order_number_counters" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_logs_tenant_idx" ON "status_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_logs_entity_idx" ON "status_logs" USING btree ("tenant_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_logs_from_idx" ON "status_logs" USING btree ("from_status_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_logs_to_idx" ON "status_logs" USING btree ("to_status_id");