-- 0040_environment_isolation — make Live/Sandbox a REAL boundary.
--
-- Before this, only rfqs + orders carried `environment`: 18 of 20 operational tables were untagged,
-- reads filtered inconsistently, writes never checked at all (a sandbox session could mutate live
-- records), and the document-number counter was shared so a sandbox test burned a live order number.
--
-- Model: every OPERATIONAL row carries its own environment, backfilled from its parent chain so
-- existing data keeps its true value. Master/config data (vendors, workshops, users, branches,
-- price lists, reference vocabulary) stays deliberately SHARED — a sandbox is a parallel set of
-- TRANSACTIONS against the same catalogue, not a second company.

-- ── 1. the column, on every operational table ────────────────────────────────
ALTER TABLE "rfq_items"                 ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "rfq_vendors"               ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "rfq_vendor_items"          ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_items"               ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_orders"           ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_items"            ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices"                  ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_items"             ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_notes"              ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_note_items"         ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries"                ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_items"            ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "returns"                   ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "return_items"              ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments"                 ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "driver_delivery_requests"  ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "pickups"                   ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_items"              ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments"           ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_credit_notes"       ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_credit_note_items"  ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_financing_requests" ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests"         ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_actions"          ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_log"          ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log"                 ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint

-- ── 2. backfill from the parent chain (existing rows keep their TRUE environment) ──
UPDATE rfq_items i        SET environment = r.environment FROM rfqs r        WHERE r.id = i.rfq_id;--> statement-breakpoint
UPDATE rfq_vendors rv     SET environment = r.environment FROM rfqs r        WHERE r.id = rv.rfq_id;--> statement-breakpoint
UPDATE rfq_vendor_items vi SET environment = rv.environment FROM rfq_vendors rv WHERE rv.id = vi.rfq_vendor_id;--> statement-breakpoint
UPDATE order_items oi     SET environment = o.environment FROM orders o      WHERE o.id = oi.order_id;--> statement-breakpoint
UPDATE purchase_orders po SET environment = o.environment FROM orders o      WHERE o.id = po.order_id;--> statement-breakpoint
UPDATE purchase_items pi  SET environment = po.environment FROM purchase_orders po WHERE po.id = pi.purchase_order_id;--> statement-breakpoint
UPDATE invoices inv       SET environment = o.environment FROM orders o      WHERE o.id = inv.order_id;--> statement-breakpoint
UPDATE invoice_items ii   SET environment = inv.environment FROM invoices inv WHERE inv.id = ii.invoice_id;--> statement-breakpoint
UPDATE credit_notes cn    SET environment = o.environment FROM orders o      WHERE o.id = cn.order_id;--> statement-breakpoint
UPDATE credit_note_items ci SET environment = cn.environment FROM credit_notes cn WHERE cn.id = ci.credit_note_id;--> statement-breakpoint
UPDATE deliveries d       SET environment = o.environment FROM orders o      WHERE o.id = d.order_id;--> statement-breakpoint
UPDATE delivery_items di  SET environment = d.environment FROM deliveries d  WHERE d.id = di.delivery_id;--> statement-breakpoint
UPDATE returns rt         SET environment = o.environment FROM orders o      WHERE o.id = rt.order_id;--> statement-breakpoint
UPDATE return_items ri    SET environment = rt.environment FROM returns rt   WHERE rt.id = ri.return_id;--> statement-breakpoint
UPDATE shipments s        SET environment = o.environment FROM orders o      WHERE o.id = s.order_id;--> statement-breakpoint
UPDATE driver_delivery_requests ddr SET environment = o.environment FROM orders o WHERE o.id = ddr.order_id;--> statement-breakpoint

-- ── 3. document numbering must not be shared: a sandbox test may never burn a live number ──
ALTER TABLE "order_number_counters" ADD COLUMN IF NOT EXISTS "environment" "environment_type" DEFAULT 'live' NOT NULL;--> statement-breakpoint
-- the scope key gains environment so each environment keeps its own sequence
ALTER TABLE "order_number_counters" DROP CONSTRAINT IF EXISTS "order_number_counters_scope_uq";--> statement-breakpoint
ALTER TABLE "order_number_counters" ADD CONSTRAINT "order_number_counters_scope_uq"
  UNIQUE ("tenant_id", "prefix", "environment");--> statement-breakpoint

-- Replace (not overload) the old 3-arg function: keeping both would make a 3-arg call ambiguous.
DROP FUNCTION IF EXISTS public.next_order_number(uuid, text, uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.next_order_number(
  p_tenant uuid, p_prefix text, p_region uuid DEFAULT NULL::uuid, p_environment text DEFAULT 'live'
) RETURNS text LANGUAGE plpgsql SET search_path = '' AS $$
declare v_value int;
begin
  insert into public.order_number_counters (tenant_id, region_id, prefix, environment, next_value)
    values (p_tenant, p_region, p_prefix, p_environment::public.environment_type, 2)
  on conflict (tenant_id, prefix, environment)
    do update set next_value = public.order_number_counters.next_value + 1, updated_at = now()
  returning next_value into v_value;
  -- sandbox documents are visibly marked so a test can never be mistaken for a real document
  return p_prefix || case when p_environment = 'sandbox' then 'SBX-' else '' end || (v_value - 1)::text;
end $$;
