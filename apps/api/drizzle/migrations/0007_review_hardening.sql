DROP INDEX IF EXISTS "orders_rfq_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rfq_vendors_token_hash_uq" ON "rfq_vendors" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_rfq_uq" ON "orders" USING btree ("rfq_id");