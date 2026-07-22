/**
 * Seed — realistic fake data for local dev + the sandbox tenant (ADR-0007 / ADR-0004).
 * Runs as internal staff (app.is_internal = true) so RLS lets it write across tenants.
 * Idempotent-ish: truncates app data first (dev only), then re-seeds.
 *
 * This is a FOUNDATION seed (Phase 1c): reference vocabulary + plans + tenants (incl. a sandbox)
 * + org + a global vendor with links + one full RFQ→order chain, enough to prove the schema,
 * RLS isolation, and the atomic order-number function end to end. It grows in later phases.
 */
import postgres from "postgres";
import argon2 from "argon2";
import { ITEM_STATUSES, VENDOR_STATUSES } from "./reference-data";

const sql = postgres(
  process.env.DATABASE_URL ??
    "postgresql://qvm:change_me_in_local_env@localhost:5434/qvm_platform",
  { max: 1 },
);

async function main() {
  await sql`select set_config('app.is_internal','true',false)`;

  // ---- clean (dev only) ----
  await sql`
    truncate table
      order_items, orders, rfq_vendor_items, rfq_vendors, rfq_items, rfqs,
      tenant_vendors, vendor_users, vendor_branches, vendors,
      workshop_branches, workshops, tenant_memberships, platform_members,
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
  const advisorHash = await argon2.hash("advisor1234");
  const multiHash = await argon2.hash("multi1234");
  const managerHash = await argon2.hash("manager1234");
  const vendorHash = await argon2.hash("vendor1234");
  const [admin] = await sql`insert into users (email,full_name,password_hash)
    values ('admin@qvm.local','Platform Admin',${adminHash}) returning id`;
  const [advisor] = await sql`insert into users (email,full_name,password_hash)
    values ('advisor@riyadh.local','Riyadh Advisor',${advisorHash}) returning id`;
  // workspace ADMIN (company_admin) — sees Setup + Settings
  const [manager] = await sql`insert into users (email,full_name,password_hash)
    values ('manager@riyadh.local','Riyadh Manager',${managerHash}) returning id`;
  // VENDOR user — lands on the vendor portal
  const [vendorUser] = await sql`insert into users (email,full_name,password_hash)
    values ('gulf@vendor.local','Gulf Vendor Admin',${vendorHash}) returning id`;
  // a user who works with TWO workspaces — exercises workspace switching (ADR-0010)
  const [multi] = await sql`insert into users (email,full_name,password_hash)
    values ('multi@qvm.local','Multi Workspace User',${multiHash}) returning id`;
  await sql`select set_config('app.user_id', ${admin.id}, false)`;

  // ---- tenants: two real workspaces + one sandbox ----
  const [t1] = await sql`insert into tenants (name,slug,plan_id,is_sandbox)
    values ('Qparts Riyadh','riyadh',${pro.id},false) returning id`;
  const [t2] = await sql`insert into tenants (name,slug,plan_id,is_sandbox)
    values ('Qparts Jeddah','jeddah',${pro.id},false) returning id`;
  const [tSandbox] = await sql`insert into tenants (name,slug,plan_id,is_sandbox)
    values ('Sandbox Workspace','sandbox',${pro.id},true) returning id`;

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

  // ---- access (ADR-0010 three layers) ----
  // admin = platform staff → sees ALL workspaces
  await sql`insert into platform_members (user_id,role) values (${admin.id},'super_admin')`;
  // advisor = company-scoped to t1 only
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t1.id},${advisor.id},'service_advisor',${branch.id})`;
  // manager = WORKSPACE ADMIN of t1 (company_admin) → Setup + Settings
  await sql`insert into tenant_memberships (tenant_id,user_id,role)
    values (${t1.id},${manager.id},'company_admin')`;
  // multi = member of BOTH t1 and t2 (can switch between them)
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t1.id},${multi.id},'branch_manager',${branch.id})`;
  await sql`insert into tenant_memberships (tenant_id,user_id,role,workshop_branch_id)
    values (${t2.id},${multi.id},'service_advisor',${branch2.id})`;

  // ---- global vendor linked to t1 AND the sandbox (same global identity, per ADR-0008) ----
  const [vendor] = await sql`insert into vendors (legal_name,vendor_type,primary_email)
    values ('Gulf Auto Parts Co.','commercial','vendor@gulf.example') returning id`;
  await sql`insert into vendor_branches (vendor_id,name,region_id) values (${vendor.id},'Riyadh Depot',${central.id})`;
  await sql`insert into tenant_vendors (tenant_id,vendor_id,status) values (${t1.id},${vendor.id},'active')`;
  await sql`insert into tenant_vendors (tenant_id,vendor_id,status) values (${tSandbox.id},${vendor.id},'active')`;
  // vendor-portal login: gulf@vendor.local is an admin of the Gulf vendor (persona = vendor)
  await sql`insert into vendor_users (vendor_id,user_id,is_vendor_admin) values (${vendor.id},${vendorUser.id},true)`;

  // ---- sandbox org so the sandbox guard can be exercised end-to-end ----
  const [sbWs] = await sql`insert into workshops (name) values ('Sandbox Motors') returning id`;
  await sql`insert into workshop_branches (workshop_id,name,region_id)
    values (${sbWs.id},'Sandbox Branch',${central.id})`;
  await sql`insert into tenant_workshops (tenant_id,workshop_id,status) values (${tSandbox.id},${sbWs.id},'active')`;

  // ---- one RFQ chain in t1, using the atomic order-number function ----
  const [num] = await sql`select public.next_order_number(${t1.id},'RYD-',${central.id}) as n`;
  const [newStatus] = await sql`select id from item_statuses where code='new_rfq'`;
  const [rfq] = await sql`insert into rfqs (tenant_id,order_number,workshop_branch_id,plate_number,status_id)
    values (${t1.id},${num.n},${branch.id},'ABC-1234',${newStatus.id}) returning id`;
  await sql`insert into rfq_items (tenant_id,rfq_id,part_number,part_description,quantity)
    values (${t1.id},${rfq.id},'12345-67890','Brake Pad Set',2)`;

  // ---- pricing engine (QNEW-30): a margin matrix + a basis setting for t1 ----
  const [pcat] = await sql`insert into profit_categories (tenant_id,name,part_category_id,brand_class_id)
    select ${t1.id},'brake-genuine',(select id from part_categories where code='brake'),
           (select id from brand_classes where code='genuine') returning id`;
  const [cr] = await sql`select id from cost_ranges where code='r0_500'`;
  await sql`insert into profit_margins (tenant_id,profit_category_id,cost_range_id,margin_pct)
    values (${t1.id},${pcat.id},${cr.id},25)`;
  await sql`insert into pricing_basis_settings (tenant_id,payer_scenario,price_basis,adjustment_type,adjustment_pct)
    values (${t1.id},'cash_client','calculated_margin','markup',0)`;

  // ---- report ----
  const counts = await sql`select
    (select count(*) from item_statuses) item_statuses,
    (select count(*) from tenants) tenants,
    (select count(*) from rfqs) rfqs,
    (select order_number from rfqs limit 1) sample_order_number`;
  console.log("seed complete:", counts[0]);
  console.log("tenant t1:", t1.id, "sandbox:", tSandbox.id);
  await sql.end();
}

main().catch(async (e) => {
  console.error(e);
  await sql.end();
  process.exit(1);
});
