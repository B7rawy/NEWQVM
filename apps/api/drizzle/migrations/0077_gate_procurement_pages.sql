-- 0077_gate_procurement_pages.sql — an empty workspace stops advertising work it cannot do.
--
-- THE COMPLAINT, and it is correct: a workspace with zero workshops, zero vendors, zero providers
-- and zero users still showed RFQs Dashboard, Orders Dashboard, Delivered Orders, Pricing Engine,
-- Profit Percentages, Performance Reports. 0069 gated only the pages ABOUT a counterparty
-- (Vendors, Workshops, Providers, Internal) and left everything else core, which was too timid.
-- Those menus are not merely empty — they are unreachable states dressed up as features.
--
-- THE RULE IS TAKEN FROM THE SCHEMA, NOT FROM AN OPINION. rfqs.workshop_branch_id is NOT NULL with
-- a foreign key to workshop_branches, and orders.rfq_id is NOT NULL. So a workspace with no
-- workshop linked cannot hold a single request, and therefore cannot hold an order, a delivery, an
-- invoice, a return, a statement or a number in a performance report. The whole chain is
-- structurally impossible, so the whole chain is module='workshop'.
--
-- The pricing pages price VENDOR quotes — a margin over a supplier's cost, a parts-price history
-- across suppliers — so they are module='vendor'. A workspace can sensibly set its pricing up with
-- suppliers before it has a single customer, and can take requests before it has priced anything,
-- so the two gates are independent rather than "all or nothing".
--
-- WHAT DELIBERATELY STAYS CORE, so an empty workspace is still usable:
--   My work, Overview, Management Overview   — where you land; they show zeros, they do not lie
--   Add supplier / workshop                  — the way OUT of being empty; gating it is a deadlock
--   Users & Permissions, Settings, Status Logs, Account Managers  — configure and audit
-- plus every platform-administration page, which is about the platform and not this workspace.
--
-- An empty workspace therefore keeps 8 of its 26 pages, and each linked counterparty brings its own
-- back. Nothing is deleted; a page hidden here reappears the moment the link exists.

update app_pages set module = 'workshop', updated_at = now() where key in (
  'workspace.rfq-new', 'workspace.rfqs', 'workspace.orders', 'workspace.delivered', 'workspace.closed',
  'workspace.purchase-invoices', 'workspace.returns', 'workspace.notes', 'workspace.statements',
  'workspace.reports', 'workspace.targets',
  'platform.rfqs', 'platform.orders', 'platform.delivered', 'platform.reports'
);--> statement-breakpoint

update app_pages set module = 'vendor', updated_at = now() where key in (
  'workspace.parts-pricing-report', 'workspace.profit', 'workspace.pricing',
  'platform.pricing', 'platform.profit'
);--> statement-breakpoint

do $$
declare core_left int; escape_hatch int;
begin
  -- What an empty workspace would be left with. Named here so the number is a decision on the
  -- record rather than whatever happens to fall out of the updates above.
  select count(*) into core_left from app_pages where persona = 'workspace' and module = 'core';
  if core_left <> 8 then
    raise exception 'an empty workspace would keep % core pages, expected 8', core_left;
  end if;

  -- The one that would be a deadlock: no workshops, and no way to add one.
  select count(*) into escape_hatch from app_pages
   where persona = 'workspace' and path = '/onboarding' and module = 'core';
  if escape_hatch <> 1 then
    raise exception 'Add supplier / workshop must stay core or an empty workspace can never fill itself';
  end if;
end $$;
