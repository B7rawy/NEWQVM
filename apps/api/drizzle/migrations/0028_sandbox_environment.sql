CREATE TYPE "public"."environment_type" AS ENUM('live', 'sandbox');--> statement-breakpoint
ALTER TABLE "rfqs" ADD COLUMN "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "environment" "environment_type" DEFAULT 'live' NOT NULL;