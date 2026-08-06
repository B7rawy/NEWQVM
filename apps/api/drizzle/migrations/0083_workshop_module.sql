-- 0083_workshop_module.sql — the backend enablers for the ported workshop module.
--
-- The port follows docs/legacy/workshop-logic.md. Three things the legacy flow needs that the
-- schema did not yet carry; everything else (approved_qty, final_part_number, client_po,
-- polymorphic notes with is_internal, returns with reasons, the full 26-status catalog) was
-- already anticipated by earlier migrations and is reused, not duplicated.
--
-- estimated_price is the workshop-facing guide price computed at creation by the ported engine
-- (same workshop bought the part+class in the last 60 days → that price; else the latest vendor
-- cost anywhere in the workspace, aged +1/3/7%; else NULL meaning "needs manual review"). It is
-- display data, never billed from — selling_price remains the priced amount.

alter table rfq_items add column if not exists estimated_price numeric(12,2);--> statement-breakpoint

-- `code` was never declared unique on the two reference tables (they were seeded once by inserts
-- that never expected a second run). The uniques belong there anyway — a duplicated reason code
-- would render twice in every dropdown — and they are what makes the idempotent seeds below legal.
create unique index if not exists cancellation_reasons_code_uq on cancellation_reasons (code);--> statement-breakpoint
create unique index if not exists brand_classes_code_uq on brand_classes (code);--> statement-breakpoint

-- The legacy cancellation-reason catalog (list 20), verbatim including the gap at 205 — legacy_id
-- is the import key, same contract as every other reference table. The table existed since 0001
-- and stayed EMPTY because nothing wrote it; the workshop cancel flow is its first consumer.
insert into cancellation_reasons (code, label_en, label_ar, sort_order, legacy_id) values
  ('wrong_part_number',   'Wrong part number',              'رقم قطعة خاطئ',        1,  196),
  ('wrong_part_class',    'Wrong part class',               'فئة قطعة خاطئة',       2,  197),
  ('damaged_part',        'Damaged part',                   'قطعة تالفة',           3,  198),
  ('extra_parts',         'Extra parts',                    'قطع زائدة',            4,  199),
  ('different_price',     'Different price',                'سعر مختلف',            5,  200),
  ('late_delivery',       'Late delivery',                  'تأخر التسليم',         6,  201),
  ('part_not_needed',     'Part not needed',                'القطعة غير مطلوبة',    7,  202),
  ('customer_cancelled',  'Customer canceled service',      'العميل ألغى الخدمة',   8,  203),
  ('self_purchased',      'Customer self-purchased parts',  'العميل اشترى بنفسه',   9,  204),
  ('price_too_high',      'Price too high',                 'السعر مرتفع',          10, 206)
on conflict (code) do nothing;--> statement-breakpoint

-- Legacy brand-class list has five entries; ours seeded four. 'Any' is how a workshop says
-- "whatever class you can source" and the legacy form offers it, so its absence would force a
-- false choice at request time.
insert into brand_classes (code, label_en, label_ar, sort_order, legacy_id)
values ('any', 'Any', 'أي فئة', 5, 111)
on conflict (code) do nothing;
