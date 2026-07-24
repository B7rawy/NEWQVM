-- 0039_name_snapshots — QNEW-71 §6.1 (6c): documents keep the counterparty name AS IT STOOD at
-- creation, so a later rename or Individual→Company upgrade never rewrites history.
-- RFQ/order/invoice lineage = the CUSTOMER (workshop); purchase order = the VENDOR.
ALTER TABLE "rfqs" ADD COLUMN IF NOT EXISTS "customer_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "vendor_name_snapshot" text;
