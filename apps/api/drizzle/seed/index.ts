/**
 * Seed — realistic fake data for local dev (ADR-0007 / ADR-0004).
 * Runs as internal staff (app.is_internal = true) so RLS lets it write across tenants.
 * Idempotent-ish: truncates app data first (dev only), then re-seeds.
 *
 * This is a FOUNDATION seed (Phase 1c): reference vocabulary + plans + tenants
 * + org + a global vendor with links + one full RFQ→order chain, enough to prove the schema,
 * RLS isolation, and the atomic order-number function end to end. It grows in later phases.
 */
import postgres from "postgres";
import argon2 from "argon2";
import { ITEM_STATUSES, VENDOR_STATUSES } from "./reference-data";

const DSN =
  process.env.DATABASE_URL ?? "postgresql://qvm:change_me_in_local_env@localhost:5434/qvm_platform";

/**
 * This script TRUNCATES every table and reseeds fixtures with publicly-known passwords. The repo is
 * rsynced to the server, so both this file and a production .env sit on the prod box — one
 * `pnpm db:seed` in the wrong directory would replace production with fixtures. Refuse anything that
 * is not unmistakably a local database, unless the operator says so out loud.
 */
const host = (() => {
  try {
    return new URL(DSN).hostname;
  } catch {
    return "";
  }
})();
const isLocal = ["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"].includes(host);
if (!isLocal && process.env.SEED_I_KNOW_THIS_IS_NOT_LOCAL !== "yes") {
  console.error(
    `\nREFUSING TO SEED: '${host}' is not a local database, and seeding TRUNCATES everything.\n` +
      `If you really mean it, re-run with SEED_I_KNOW_THIS_IS_NOT_LOCAL=yes\n`,
  );
  process.exit(1);
}

const sql = postgres(DSN, { max: 1 });

async function main() {
  await sql`select set_config('app.is_internal','true',false)`;

  // ---- clean (dev only) ----
  await sql`
    truncate table
      order_items, orders, rfq_vendor_items, rfq_vendors, rfq_items, rfqs,
      tenant_vendors, vendor_users, vendor_branches, vendors,
      tenant_service_providers, service_provider_users, service_providers,
      workshop_users, workshop_branches, workshops, tenant_memberships, platform_members,
      tenants, plans, users, order_number_counters,
      item_statuses, vendor_statuses, car_brands, brand_classes, part_categories,
      regions, cities, cancellation_reasons, return_reasons, payment_accounts,
      cost_ranges, parts_master, part_synonyms, part_category_mapping,
      profit_categories, profit_margins, pricing_basis_settings, agency_price_reference,
      insurance_companies
    restart identity cascade`;

  // ---- reference vocabulary (statuses preserved exactly as old system) ----
  for (const s of ITEM_STATUSES) {
    await sql`insert into item_statuses (code,label_en,label_ar,sort_order,legacy_id)
      values (${s.code},${s.labelEn},${s.labelAr},${s.sortOrder},${s.legacyIds[0] ?? null})`;
  }
  for (const s of VENDOR_STATUSES) {
    await sql`insert into vendor_statuses (code,label_en,label_ar,sort_order,legacy_id)
      values (${s.code},${s.labelEn},${s.labelAr},${s.sortOrder},${s.legacyIds[0] ?? null})`;
  }
  const brandClasses = [
    ["genuine", "Genuine", "أصلي"],
    ["oem", "OEM", "أو إي إم"],
    ["aftermarket", "Aftermarket", "تجاري"],
    ["used", "Used", "مستعمل"],
  ];
  for (const [code, en, ar] of brandClasses) {
    await sql`insert into brand_classes (code,label_en,label_ar) values (${code},${en},${ar})`;
  }
  await sql`insert into car_brands (code,label_en,label_ar) values
    ('toyota','Toyota','تويوتا'),('nissan','Nissan','نيسان'),('hyundai','Hyundai','هيونداي')`;
  await sql`insert into part_categories (code,label_en,label_ar) values
    ('engine','Engine','محرك'),('body','Body','هيكل'),('electrical','Electrical','كهرباء'),
    ('brake','Brake','فرامل')`;
  // master-data foundation (QNEW-28): a few canonical parts + synonyms + category mapping
  const [brakeCat] = await sql`select id from part_categories where code='brake'`;
  const [engineCat] = await sql`select id from part_categories where code='engine'`;
  const [pad] = await sql`insert into parts_master (name_en,name_ar,part_category_id,source)
    values ('Brake Pad','تيل فرامل',${brakeCat.id},'dictionary_migration') returning id`;
  await sql`insert into part_synonyms (part_id,synonym) values
    (${pad.id},'brake pads'),(${pad.id},'تيل'),(${pad.id},'disc pad')`;
  await sql`insert into parts_master (name_en,name_ar,part_category_id,source)
    values ('Oil Filter','فلتر زيت',${engineCat.id},'dictionary_migration')`;
  await sql`insert into part_category_mapping (raw_variant,part_category_id) values
    ('Brakes',${brakeCat.id}),('BRAKE',${brakeCat.id})`;
  const [central] =
    await sql`insert into regions (code,label_en,label_ar) values ('central','Central','الوسطى') returning id`;
  await sql`insert into regions (code,label_en,label_ar) values
    ('western','Western','الغربية'),('eastern','Eastern','الشرقية')`;
  await sql`insert into cities (region_id,code,label_en,label_ar) values
    (${central.id},'riyadh','Riyadh','الرياض')`;
  await sql`insert into payment_accounts (code,label_en,label_ar) values ('cash','Cash','نقدي')`;
  await sql`insert into cost_ranges (code,label_en,label_ar,lower_bound,upper_bound) values
    ('r0_500','0–500','٠–٥٠٠',0,500),
    ('r500_2000','500–2000','٥٠٠–٢٠٠٠',500,2000),
    ('r2000_plus','2000+','٢٠٠٠+',2000,null)`;
  await sql`insert into return_reasons (side,code,label_en,label_ar) values
    ('client','wrong_part','Wrong Part','قطعة خاطئة'),
    ('client','defective','Defective','معيبة'),
    ('internal','wrong_pricing','Wrong Pricing','تسعير خاطئ'),
    ('internal','delay','Delay','تأخير')`;

  // ---- plans ----
  const [pro] =
    await sql`insert into plans (code,name) values ('pro','Professional') returning id`;

  // ---- users (real argon2 passwords so login works over HTTP) — one per persona ----
  const adminHash = await argon2.hash("admin1234");
  const staffHash = await argon2.hash("staff1234");
  const multiHash = await argon2.hash("multi1234");
  const managerHash = await argon2.hash("manager1234");
  const vendorHash = await argon2.hash("vendor1234");
  const workshopHash = await argon2.hash("workshop1234");
  // Logins are named by ROLE on one domain (@qparts.local) so each persona is obvious.
  const [admin] = await sql`insert into users (email,full_name,password_hash)
    values ('admin@qparts.local','Platform Admin',${adminHash}) returning id`;
  // regular workspace EMPLOYEE (role service_advisor) — raises RFQs, no admin/setup access
  const [staff] = await sql`insert into users (email,full_name,password_hash)
    values ('staff@qparts.local','Riyadh Staff',${staffHash}) returning id`;
  // workspace ADMIN (company_admin) — sees Setup + Settings
  const [manager] = await sql`insert into users (email,full_name,password_hash)
    values ('manager@qparts.local','Riyadh Manager',${managerHash}) returning id`;
  // VENDOR user — lands on the vendor portal
  const [vendorUser] = await sql`insert into users (email,full_name,password_hash)
    values ('vendor@qparts.local','Gulf Vendor Admin',${vendorHash}) returning id`;
  // WORKSHOP user — lands on the workshop (customer) portal
  const [workshopUser] = await sql`insert into users (email,full_name,password_hash)
    values ('workshop@qparts.local','Al Faisal Workshop Admin',${workshopHash}) returning id`;
  // a user who works with TWO workspaces — exercises workspace switching (ADR-0010)
  const [multi] = await sql`insert into users (email,full_name,password_hash)
    values ('multi@qparts.local','Multi Workspace User',${multiHash}) returning id`;
  await sql`select set_config('app.user_id', ${admin.id}, false)`;

  // ---- tenants: two workspaces. There is deliberately no "sandbox workspace": every workspace
  // has a Live/Sandbox environment toggle instead, which is a real DB-enforced boundary (ADR-0012).
  const [t1] = await sql`insert into tenants (name,slug,plan_id)
    values ('Qparts Riyadh','riyadh',${pro.id}) returning id`;
  const [t2] = await sql`insert into tenants (name,slug,plan_id)
    values ('Qparts Jeddah','jeddah',${pro.id}) returning id`;

  // ---- org: global workshops + branches, linked to workspaces via tenant_workshops (ADR-0011) ----
  const [ws] = await sql`insert into workshops (name) values ('Al Faisal Motors') returning id`;
  const [branch] = await sql`insert into workshop_branches (workshop_id,name,region_id)
    values (${ws.id},'Riyadh Main',${central.id}) returning id`;
  await sql`insert into tenant_workshops (tenant_id,workshop_id,status) values (${t1.id},${ws.id},'active')`;
  // a second global workshop for t2
  const [ws2] = await sql`insert into workshops (name) values ('Jeddah Auto') returning id`;
  const [branch2] = await sql`insert into workshop_branches (workshop_id,name)
    values (${ws2.id},'Jeddah Main') returning id`;
  await sql`insert into tenant_workshops (tenant_id,workshop_id,status) values (${t2.id},${ws2.id},'active')`;
  // Al Faisal Motors is ALSO shared into t2 (same global workshop, two workspaces — demonstrates ADR-0011)
  await sql`insert into tenant_workshops (tenant_id,workshop_id,status) values (${t2.id},${ws.id},'active')`;

  // ---- service providers (QNEW-71 AC11) — internal team + external partners, linked to t1 ----
  for (const p of [
    { name: "Qparts Logistics", scope: "internal", service: "Delivery & fulfillment", tax: "SP-INT-1" },
    { name: "SMSA Express", scope: "external", service: "Shipping", tax: "SP-EXT-1" },
    { name: "Najm Services", scope: "external", service: "Insurance & claims", tax: "SP-EXT-2" },
  ]) {
    const [sp] = await sql`insert into service_providers (legal_name, scope, service_type, tax_number)
      values (${p.name}, ${p.scope}, ${p.service}, ${p.tax}) returning id`;
    await sql`insert into tenant_service_providers (tenant_id, service_provider_id, status) values (${t1.id}, ${sp.id}, 'active')`;
  }

  // ---- access (ADR-0010 three layers) ----
  // admin = platform staff → sees ALL workspaces
  await sql`insert into platform_members (user_id,role) values (${admin.id},'super_admin')`;
  // staff = service_advisor, scoped to t1 (Riyadh Main branch) only
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t1.id},${staff.id},'service_advisor',${branch.id})`;
  // manager = WORKSPACE ADMIN of t1 (company_admin) → Setup + Settings
  await sql`insert into tenant_memberships (tenant_id,user_id,role)
    values (${t1.id},${manager.id},'company_admin')`;
  // multi = member of BOTH t1 and t2 (can switch between them)
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t1.id},${multi.id},'branch_manager',${branch.id})`;
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t2.id},${multi.id},'service_advisor',${branch2.id})`;

  // ---- global vendor linked to t1 (same global identity across workspaces, per ADR-0008) ----
  const [vendor] = await sql`insert into vendors (legal_name,vendor_type,primary_email)
    values ('Gulf Auto Parts Co.','commercial','vendor@gulf.example') returning id`;
  await sql`insert into vendor_branches (vendor_id,name,region_id) values (${vendor.id},'Riyadh Depot',${central.id})`;
  await sql`insert into tenant_vendors (tenant_id,vendor_id,status) values (${t1.id},${vendor.id},'active')`;
  // vendor-portal login: vendor@qparts.local is an admin of the Gulf vendor (persona = vendor)
  await sql`insert into vendor_users (vendor_id,user_id,is_vendor_admin) values (${vendor.id},${vendorUser.id},true)`;
  // workshop-portal login: workshop@qparts.local is an admin of Al Faisal Motors (persona = workshop);
  // that workshop is linked to BOTH riyadh + jeddah, so this user can switch between those workspaces.
  await sql`insert into workshop_users (workshop_id,user_id,is_workshop_admin) values (${ws.id},${workshopUser.id},true)`;

  // ---- one RFQ chain in t1, using the atomic order-number function ----
  const [num] = await sql`select public.next_order_number(${t1.id},'RYD-',${central.id}) as n`;
  const [newStatus] = await sql`select id from item_statuses where code='new_rfq'`;
  const [rfq] = await sql`insert into rfqs (tenant_id,order_number,workshop_branch_id,plate_number,status_id)
    values (${t1.id},${num.n},${branch.id},'ABC-1234',${newStatus.id}) returning id`;
  await sql`insert into rfq_items (tenant_id,rfq_id,part_number,part_description,quantity,status_id)
    values (${t1.id},${rfq.id},'12345-67890','Brake Pad Set',2,${newStatus.id})`;
  // send this RFQ to the Gulf vendor so the vendor portal has a real quotation request to price
  const [rvRow] = await sql`insert into rfq_vendors (tenant_id,rfq_id,vendor_id,status_id,sent_at)
    values (${t1.id},${rfq.id},${vendor.id},(select id from vendor_statuses where code='rfq'),now()) returning id`;
  // vendor quotes the item, wins it, and the workspace confirms → a real order for the portals
  const [rItem] = await sql`select id, quantity, part_number from rfq_items where rfq_id=${rfq.id} limit 1`;
  const [quote] = await sql`insert into rfq_vendor_items (tenant_id,rfq_vendor_id,rfq_item_id,offered_cost,sla_hours,available_qty,status_id)
    values (${t1.id},${rvRow.id},${rItem.id},130.00,24,${rItem.quantity},(select id from vendor_statuses where code='priced')) returning id`;
  await sql`update rfq_items set winning_vendor_quote_item_id=${quote.id} where id=${rItem.id}`;
  const [confIs] = await sql`select id from item_statuses where code='confirmed'`;
  const [order] = await sql`insert into orders (tenant_id,environment,rfq_id,order_number,status_id)
    values (${t1.id},'live',${rfq.id},${num.n},${confIs.id}) returning id`;
  await sql`insert into order_items (tenant_id,order_id,rfq_item_id,final_part_number,approved_qty,winning_vendor_quote_item_id,status_id)
    values (${t1.id},${order.id},${rItem.id},${rItem.part_number},${rItem.quantity},${quote.id},${confIs.id})`;
  // mirror exactly what OrdersService.confirm() writes: rfq + items + winning vendor all 'confirmed'
  await sql`update rfqs set status_id=${confIs.id} where id=${rfq.id}`;
  await sql`update rfq_items set status_id=${confIs.id} where id=${rItem.id}`;
  await sql`update rfq_vendors set status_id=(select id from vendor_statuses where code='confirmed') where id=${rvRow.id}`;

  // ---- pricing engine (QNEW-30): a margin matrix + a basis setting for t1 ----
  const [pcat] = await sql`insert into profit_categories (tenant_id,name,part_category_id,brand_class_id)
    select ${t1.id},'brake-genuine',(select id from part_categories where code='brake'),
           (select id from brand_classes where code='genuine') returning id`;
  const [cr] = await sql`select id from cost_ranges where code='r0_500'`;
  await sql`insert into profit_margins (tenant_id,profit_category_id,cost_range_id,margin_pct)
    values (${t1.id},${pcat.id},${cr.id},25)`;
  await sql`insert into pricing_basis_settings (tenant_id,payer_scenario,price_basis,adjustment_type,adjustment_pct)
    values (${t1.id},'cash_client','calculated_margin','markup',0)`;

  // ---- workflows are NOT seeded any more ----
  //
  // There used to be a hand-drawn "Insurance flow" fixture here so the builder was not empty on a
  // fresh database. It has been removed, for two reasons.
  //
  // THE FIRST IS THAT SOMETHING BETTER NOW FILLS THE GAP. Every workspace is provisioned with the
  // standard flow (apps/api/src/modules/workflow/template.ts) at API start and at workspace
  // creation, so the canvas and the Pages screen open on a real, complete, ACTIVE workflow rather
  // than on a demo.
  //
  // THE SECOND IS THAT THE FIXTURE WAS WRONG, and left in place it would have blocked its
  // replacement: provisioning deliberately never touches a workspace that already has a flow, so a
  // seeded item flow meant the standard one was never installed. It was also a live example of the
  // failure this whole feature exists to prevent — it drew new_rfq -> tendering -> priced, and
  // nothing in this product ever writes 'tendering'. Activating it would have refused the first
  // click on the first request.

  // ---- report ----
  const counts = await sql`select
    (select count(*) from item_statuses) item_statuses,
    (select count(*) from tenants) tenants,
    (select count(*) from rfqs) rfqs,
    (select order_number from rfqs limit 1) sample_order_number,
    (select count(*) from workflow_flows) workflow_flows`;
  console.log("seed complete:", counts[0]);
  console.log("tenant t1:", t1.id, "t2:", t2.id);
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
