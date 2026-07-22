DROP INDEX IF EXISTS "pricing_basis_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pricing_basis_scope_idx" ON "pricing_basis_settings" USING btree ("tenant_id","payer_scenario","insurance_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vendor_pricing_scope_idx" ON "vendor_pricing_policies" USING btree ("tenant_id","vendor_id","scope_type","region_id","workshop_branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ddr_one_accepted_per_order_uq" ON "driver_delivery_requests" USING btree ("order_id") WHERE status = 'accepted';