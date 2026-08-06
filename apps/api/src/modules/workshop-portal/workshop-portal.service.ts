import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { queuePredicate } from "../workflow/routing.js";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { RfqService } from "../rfq/rfq.service.js";
import { OrdersService } from "../orders/orders.service.js";
import { WorkflowExceptionsService } from "../workflow/exceptions.service.js";
import { StatusService } from "../../common/status.service.js";
import { requireCounterparty } from "../../common/counterparty.helpers.js";
import { envOf } from "../../common/env-guards.js";

/**
 * Workshop self-service portal (cross-workspace). A workshop is a GLOBAL customer linked to many
 * workspaces; these endpoints scope by workshop OWNERSHIP (via workshop_users) across every linked
 * workspace — so a workshop only ever sees ITS OWN requests, never other customers' (unlike the
 * tenant-wide /rfqs which is for workspace staff).
 */
export const createRequestSchema = z.object({
  tenantId: z.string().uuid(), // which linked workspace should serve this request
  workshopBranchId: z.string().uuid(),
  plateNumber: z.string().max(32).optional(),
  vin: z.string().max(32).optional(),
  model: z.string().max(64).optional(),
  orderType: z.enum(["regular", "bulk"]).default("regular"),
  items: z
    .array(
      z.object({
        partNumber: z.string().max(64).optional(),
        partDescription: z.string().max(256).optional(),
        quantity: z.number().int().positive().default(1),
        brandClassId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

@Injectable()
export class WorkshopPortalService {
  constructor(
    private readonly dbService: DbService,
    private readonly rfqService: RfqService,
    private readonly ordersService: OrdersService,
    private readonly exceptions: WorkflowExceptionsService,
    private readonly status: StatusService,
  ) {}

  /**
   * Ownership resolution for every mutating endpoint: the rfq/order must belong to a branch of a
   * workshop THIS USER is a member of. Returns the record's tenant so the action can then run in a
   * TENANT-scoped context — the portal validates cross-workspace, but every write happens inside
   * the one workspace that owns the record, under its RLS and its workflow.
   */
  private async resolveOwnedRfq(tx: Tx, userId: string | null, rfqId: string, env: string) {
    const row = (await tx.execute(sql`
      select r.id, r.tenant_id, ist.code as status
      from rfqs r
      join workshop_branches wb on wb.id = r.workshop_branch_id
      join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${userId}::uuid
      left join item_statuses ist on ist.id = r.status_id
      where r.id = ${rfqId}::uuid and r.environment = ${env}::environment_type limit 1`))[0] as
      | { id: string; tenant_id: string; status: string | null }
      | undefined;
    if (!row) throw new NotFoundException("request not found");
    return row;
  }

  private async resolveOwnedOrder(tx: Tx, userId: string | null, orderId: string, env: string) {
    const row = (await tx.execute(sql`
      select o.id, o.tenant_id
      from orders o
      join rfqs r on r.id = o.rfq_id
      join workshop_branches wb on wb.id = r.workshop_branch_id
      join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${userId}::uuid
      where o.id = ${orderId}::uuid and o.environment = ${env}::environment_type limit 1`))[0] as
      | { id: string; tenant_id: string }
      | undefined;
    if (!row) throw new NotFoundException("order not found");
    return row;
  }

  private async requireWorkshopUser(tx: Tx, userId: string | null) {
    await requireCounterparty(tx, userId, "workshop");
  }

  /** KPI counts over the workshop's own requests (across every linked workspace). */
  async overview(ctx: RlsContext) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const c = (await tx.execute(sql`
        select
          count(*) as total,
          count(*) filter (where not exists (select 1 from orders o where o.rfq_id = r.id)
            and coalesce(ist.code, '') not in ('cancelled', 'unavailable', 'settled')) as open,
          count(*) filter (where exists (select 1 from orders o where o.rfq_id = r.id)) as ordered
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        left join item_statuses ist on ist.id = r.status_id
        where r.environment = ${env}::environment_type`))[0] as { total: number; open: number; ordered: number };
      return { total: Number(c.total), open: Number(c.open), ordered: Number(c.ordered) };
    });
  }

  /** The workshop's requests (RFQs) across workspaces. */
  async requests(ctx: RlsContext, queue?: string) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, r.created_at,
          ist.code as status, ist.label_en as status_label, t.name as workspace, wb.name as branch,
          (select count(*)::int from rfq_items ri where ri.rfq_id = r.id) as item_count,
          (select count(*)::int from rfq_vendors rv where rv.rfq_id = r.id) as vendor_count
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = r.tenant_id
        left join item_statuses ist on ist.id = r.status_id
        where r.environment = ${env}::environment_type
          and ${queuePredicate(sql`ist.code`, queue, sql`r.tenant_id`)}
        order by r.created_at desc`);
      return { count: rows.length, requests: rows };
    });
  }

  /** One request: header + items + invited-vendor progress (names + responded, NO prices). */
  async requestDetail(ctx: RlsContext, rfqId: string) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const head = (await tx.execute(sql`
        select r.id, r.order_number, r.plate_number, r.vin, r.model, r.created_at,
          ist.code as status, ist.label_en as status_label, t.name as workspace, wb.name as branch
        from rfqs r
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = r.tenant_id
        left join item_statuses ist on ist.id = r.status_id
        where r.id = ${rfqId}::uuid and r.environment = ${env}::environment_type limit 1`))[0] as { id: string } | undefined;
      if (!head) throw new NotFoundException("request not found");
      const items = await tx.execute(sql`
        select i.id, i.part_number, i.part_description, i.quantity,
               s.code as status, s.label_en as status_label,
               i.estimated_price, i.selling_price, i.discount_pct, i.alternative_part_number,
               (oi.id is not null) as ordered
        from rfq_items i
        left join item_statuses s on s.id = i.status_id
        left join order_items oi on oi.rfq_item_id = i.id
        where i.rfq_id = ${rfqId}::uuid order by i.created_at`);
      const vendors = await tx.execute(sql`
        select v.legal_name as vendor, vs.code as status, vs.label_en as status_label,
          (select count(*)::int from rfq_vendor_items vi where vi.rfq_vendor_id = rv.id) as quoted_items
        from rfq_vendors rv join vendors v on v.id = rv.vendor_id join vendor_statuses vs on vs.id = rv.status_id
        where rv.rfq_id = ${rfqId}::uuid order by v.legal_name`);
      return { ...(head as object), items, vendors };
    });
  }

  /** Data for the New Request form: the workshop's linked workspaces + its branches. */
  async context(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const workspaces = await tx.execute(sql`
        select distinct t.id, t.name from tenant_workshops tw
        join tenants t on t.id = tw.tenant_id
        join workshop_users wu on wu.workshop_id = tw.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where tw.status = 'active' order by t.name`);
      const branches = await tx.execute(sql`
        select wb.id, wb.name, w.name as workshop from workshop_branches wb
        join workshops w on w.id = wb.workshop_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where wb.is_active = true order by wb.name`);
      return { workspaces, branches };
    });
  }

  /** The workshop's branches + the workspaces it works with (read-only account page). */
  async branches(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const branches = await tx.execute(sql`
        select wb.id, wb.name, w.name as workshop, r.label_en as region, wb.order_category
        from workshop_branches wb
        join workshops w on w.id = wb.workshop_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        left join regions r on r.id = wb.region_id
        where wb.is_active = true order by wb.name`);
      const ws = (await tx.execute(sql`
        select distinct t.name from tenant_workshops tw
        join tenants t on t.id = tw.tenant_id
        join workshop_users wu on wu.workshop_id = tw.workshop_id and wu.user_id = ${ctx.userId}::uuid
        where tw.status = 'active' order by t.name`)) as Array<{ name: string }>;
      return { branches, workspaces: ws.map((w) => w.name) };
    });
  }

  /** The workshop's confirmed orders (across linked workspaces). */
  async orders(ctx: RlsContext, queue?: string) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select o.id, o.order_number, o.created_at, s.label_en as status, s.code as status_code,
          t.name as workspace, wb.name as branch,
          (select count(*)::int from order_items oi where oi.order_id = o.id) as items
        from orders o
        join rfqs r on r.id = o.rfq_id
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = o.tenant_id
        left join item_statuses s on s.id = o.status_id
        where o.environment = ${env}::environment_type
          and ${queuePredicate(sql`s.code`, queue, sql`o.tenant_id`)}
        order by o.created_at desc`);
      return { count: rows.length, orders: rows };
    });
  }

  /** Create a request (RFQ) in a chosen linked workspace, for one of the workshop's own branches. */
  async createRequest(ctx: RlsContext, dto: z.infer<typeof createRequestSchema>) {
    // ownership + link check (internal read)
    await this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const ok = (await tx.execute(sql`
        select w.activation_status from workshop_users wu
        join workshops w on w.id = wu.workshop_id
        join workshop_branches wb on wb.workshop_id = wu.workshop_id and wb.id = ${dto.workshopBranchId}::uuid
        join tenant_workshops tw on tw.workshop_id = wu.workshop_id and tw.tenant_id = ${dto.tenantId}::uuid and tw.status = 'active'
        where wu.user_id = ${ctx.userId}::uuid limit 1`))[0] as { activation_status: string } | undefined;
      if (!ok) throw new ForbiddenException("branch not owned by your workshop, or workspace not linked");
      // QNEW-71 §3.4: gate transactional actions until the account is activated.
      if (ok.activation_status !== "active") throw new ForbiddenException("activate your account before creating requests");
    });
    // reuse the workspace RFQ-create (atomic order number + header + items) in the chosen tenant.
    // The request is created in the environment the WORKSHOP is working in — hard-coding "live" here
    // meant a workshop testing in Sandbox silently filed a real request (ADR-0012).
    return this.rfqService.create(
      { tenantId: dto.tenantId, userId: ctx.userId, isInternal: false, environment: envOf(ctx) },
      {
        workshopBranchId: dto.workshopBranchId,
        plateNumber: dto.plateNumber,
        vin: dto.vin,
        model: dto.model,
        orderType: dto.orderType,
        deliveryType: "delivery",
        items: dto.items.map((i) => ({ partNumber: i.partNumber, partDescription: i.partDescription, quantity: i.quantity, brandClassId: i.brandClassId })),
      },
    );
  }
  /* ════════════════════════════════════════════════════════════════════════════════════════════
     The ported workshop actions (docs/legacy/workshop-logic.md). Reads validate ownership through
     workshop_users; writes then run TENANT-scoped so RLS, the workflow guard chain and status_logs
     all see the workspace that owns the record. Cancel and return are EXCEPTIONS, not status jumps
     — QNEW-89 moved "somebody asked" out of the status column so the record keeps its real status
     while internal staff review, which is the governance the legacy system lacked (its RPCs let
     any authenticated user cancel anything, including delivered items — documented, not copied).
     ════════════════════════════════════════════════════════════════════════════════════════════ */

  /** Reference lists the portal forms need. One call, cached client-side. */
  async lists(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const brandClasses = await tx.execute(sql`
        select id, code, label_en, label_ar from brand_classes where is_active order by sort_order`);
      const cancellationReasons = await tx.execute(sql`
        select id, code, label_en, label_ar from cancellation_reasons where is_active order by sort_order`);
      const returnReasons = await tx.execute(sql`
        select id, code, label_en, label_ar from return_reasons where is_active order by sort_order`);
      return { brandClasses, cancellationReasons, returnReasons };
    });
  }

  /** Add a line to an existing request — legacy add_rfq_item_inline. Enters at 'new_rfq'. */
  async addItem(
    ctx: RlsContext,
    rfqId: string,
    dto: { partNumber?: string; partDescription?: string; quantity: number; brandClassId?: string },
  ) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        const r = await this.resolveOwnedRfq(tx, ctx.userId, rfqId, env);
        if (["cancelled", "settled"].includes(r.status ?? ""))
          throw new BadRequestException(`this request is ${r.status} — open a new request instead`);
        return r;
      },
    );
    const tenantCtx: RlsContext = { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env };
    return this.dbService.withContext(tenantCtx, async (tx) => {
      const [item] = (await tx.execute(sql`
        insert into rfq_items (tenant_id, environment, rfq_id, part_number, part_description, quantity, brand_class_id)
        values (${owned.tenant_id}::uuid, ${env}::environment_type, ${rfqId}::uuid,
                ${dto.partNumber ?? null}, ${dto.partDescription ?? null}, ${dto.quantity}, ${dto.brandClassId ?? null}::uuid)
        returning id`)) as Array<{ id: string }>;
      await this.status.enter(tx, tenantCtx, { entity: "rfq_item", id: item.id, toCode: "new_rfq" });
      await this.rfqService.applyEstimatedPrices(tx, rfqId, [item.id]);
      const est = (await tx.execute(sql`select estimated_price from rfq_items where id = ${item.id}::uuid`))[0] as {
        estimated_price: string | null;
      };
      return { id: item.id, estimatedPrice: est?.estimated_price ?? null };
    });
  }

  /** Ask to cancel a line (pre-delivery). Files a governed cancellation EXCEPTION — the line keeps
   *  its status until internal staff approve, which is what turns it 'cancelled'. */
  async requestCancel(ctx: RlsContext, rfqId: string, itemId: string, dto: { reasonId?: string; note?: string }) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        const r = await this.resolveOwnedRfq(tx, ctx.userId, rfqId, env);
        const item = (await tx.execute(sql`
          select id from rfq_items where id = ${itemId}::uuid and rfq_id = ${rfqId}::uuid limit 1`))[0];
        if (!item) throw new NotFoundException("item not found on this request");
        return r;
      },
    );
    const reason = await this.reasonText(dto.reasonId, dto.note, "cancellation_reasons");
    /**
     * WHICH RECORD CARRIES THE REQUEST. Once the line is confirmed onto an order, delivery state
     * lives on the ORDER ITEM — the rfq item stays at 'confirmed' forever. Filing the exception on
     * the order item lets the §7.5 gate see the truth: a delivered line answers "raise a return
     * instead", exactly the legacy rule, enforced by the gate that already existed.
     */
    const line = (await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      (tx) => tx.execute(sql`select id from order_items where rfq_item_id = ${itemId}::uuid limit 1`),
    )) as Array<{ id: string }>;
    return this.exceptions.open(
      { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env },
      line[0]
        ? { entityType: "order_item", entityId: line[0].id, kind: "cancellation", reason }
        : { entityType: "rfq_item", entityId: itemId, kind: "cancellation", reason },
    );
  }

  /** Ask to return a delivered order line. Files a governed return EXCEPTION carrying qty+reason;
   *  the authoritative return document is recorded by staff on approval. */
  async requestReturn(ctx: RlsContext, orderId: string, orderItemId: string, dto: { qty: number; reasonId?: string; note?: string }) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        const o = await this.resolveOwnedOrder(tx, ctx.userId, orderId, env);
        const line = (await tx.execute(sql`
          select approved_qty from order_items where id = ${orderItemId}::uuid and order_id = ${orderId}::uuid limit 1`))[0] as
          | { approved_qty: number }
          | undefined;
        if (!line) throw new NotFoundException("line not found on this order");
        if (dto.qty < 1 || dto.qty > line.approved_qty)
          throw new BadRequestException(`return quantity must be between 1 and the approved ${line.approved_qty}`);
        return o;
      },
    );
    const base = await this.reasonText(dto.reasonId, dto.note, "return_reasons");
    return this.exceptions.open(
      { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env },
      { entityType: "order_item", entityId: orderItemId, kind: "return", reason: `qty ${dto.qty} — ${base}` },
    );
  }

  /** The cart checkout — legacy confirm_cart_items. Delegates to the ONE confirm implementation. */
  async confirmItems(ctx: RlsContext, rfqId: string, items: Array<{ rfqItemId: string; approvedQty?: number }>) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        return this.resolveOwnedRfq(tx, ctx.userId, rfqId, env);
      },
    );
    return this.ordersService.confirm(
      { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env },
      rfqId,
      { items },
    );
  }

  /** One order, the workshop's view: lines, statuses, deliveries, invoice, credit notes, PO. */
  async orderDetail(ctx: RlsContext, orderId: string) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: env }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      await this.resolveOwnedOrder(tx, ctx.userId, orderId, env);
      const head = (await tx.execute(sql`
        select o.id, o.order_number, o.client_po, o.created_at, s.code as status, s.label_en as status_label,
               t.name as workspace, wb.name as branch
        from orders o
        join rfqs r on r.id = o.rfq_id
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join tenants t on t.id = o.tenant_id
        left join item_statuses s on s.id = o.status_id
        where o.id = ${orderId}::uuid limit 1`))[0] as object;
      const lines = await tx.execute(sql`
        select oi.id, oi.final_part_number, oi.approved_qty, s.code as status, s.label_en as status_label,
               ri.part_description, ri.selling_price, ri.discount_pct,
               (select coalesce(sum(di.qty), 0)::int from delivery_items di where di.order_item_id = oi.id) as delivered_qty,
               exists (select 1 from workflow_exceptions e
                        where e.entity_type = 'order_item' and e.entity_id = oi.id and e.status = 'open') as has_open_request
        from order_items oi
        join rfq_items ri on ri.id = oi.rfq_item_id
        left join item_statuses s on s.id = oi.status_id
        where oi.order_id = ${orderId}::uuid order by oi.created_at`);
      const deliveries = await tx.execute(sql`
        select d.id, d.delivered_at, d.created_at,
               (select coalesce(sum(di.qty), 0)::int from delivery_items di where di.delivery_id = d.id) as qty
        from deliveries d where d.order_id = ${orderId}::uuid order by d.created_at`);
      const invoices = await tx.execute(sql`
        select id, invoice_number, issued_at, total_before_vat, vat_amount, total_incl_vat
        from invoices where order_id = ${orderId}::uuid order by issued_at`);
      const creditNotes = await tx.execute(sql`
        select id, credit_note_number, issued_at, total from credit_notes
        where order_id = ${orderId}::uuid order by issued_at`);
      return { ...(head as object), lines, deliveries, invoices, creditNotes };
    });
  }

  /** Attach the workshop's own PO number — plain data, not a status. */
  async setClientPo(ctx: RlsContext, orderId: string, clientPo: string | null) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        return this.resolveOwnedOrder(tx, ctx.userId, orderId, env);
      },
    );
    await this.dbService.withContext(
      { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env },
      (tx) => tx.execute(sql`update orders set client_po = ${clientPo}, updated_at = now() where id = ${orderId}::uuid`),
    );
    return { ok: true };
  }

  /** Every invoice across the workshop's orders (the workshop-side billing view). */
  async invoices(ctx: RlsContext) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: env }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        select i.id, i.invoice_number, i.issued_at, i.total_before_vat, i.vat_amount, i.total_incl_vat, i.paid_at,
               o.id as order_id, o.order_number, t.name as workspace, wb.name as branch
        from invoices i
        join orders o on o.id = i.order_id
        join rfqs r on r.id = o.rfq_id
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = i.tenant_id
        where i.environment = ${env}::environment_type
        order by i.issued_at desc`);
      return { count: rows.length, invoices: rows };
    });
  }

  /** Statement: invoiced − credited per workspace, plus the rows behind the numbers. */
  async statement(ctx: RlsContext) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: env }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = (await tx.execute(sql`
        select t.name as workspace,
               coalesce(sum(i.total_incl_vat), 0) as invoiced,
               coalesce((select sum(cn.total) from credit_notes cn
                          join orders o2 on o2.id = cn.order_id
                          join rfqs r2 on r2.id = o2.rfq_id
                          join workshop_branches wb2 on wb2.id = r2.workshop_branch_id
                          join workshop_users wu2 on wu2.workshop_id = wb2.workshop_id and wu2.user_id = ${ctx.userId}::uuid
                          where cn.tenant_id = t.id and cn.environment = ${env}::environment_type), 0) as credited,
               count(distinct i.id)::int as invoice_count
        from invoices i
        join orders o on o.id = i.order_id
        join rfqs r on r.id = o.rfq_id
        join workshop_branches wb on wb.id = r.workshop_branch_id
        join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
        join tenants t on t.id = i.tenant_id
        where i.environment = ${env}::environment_type
        group by t.id, t.name order by t.name`)) as Array<{ workspace: string; invoiced: string; credited: string; invoice_count: number }>;
      return {
        rows,
        totals: rows.reduce(
          (a, r) => ({ invoiced: a.invoiced + Number(r.invoiced), credited: a.credited + Number(r.credited) }),
          { invoiced: 0, credited: 0 },
        ),
      };
    });
  }

  /** External notes on the workshop's own records; is_internal notes never cross this boundary. */
  async notes(ctx: RlsContext, entityType?: "rfq" | "order", entityId?: string) {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: env }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      if (entityType && entityId) {
        if (entityType === "rfq") await this.resolveOwnedRfq(tx, ctx.userId, entityId, env);
        else await this.resolveOwnedOrder(tx, ctx.userId, entityId, env);
      }
      const rows = await tx.execute(sql`
        select n.id, n.entity_type, n.entity_id, n.body, n.created_at,
               coalesce(u.full_name, 'Qparts') as author,
               coalesce(r.order_number, o.order_number) as order_number
        from notes n
        left join users u on u.id = n.created_by
        left join rfqs r on n.entity_type = 'rfq' and r.id = n.entity_id
        left join orders o on n.entity_type = 'order' and o.id = n.entity_id
        where n.is_internal = false and n.environment = ${env}::environment_type
          and (
            (n.entity_type = 'rfq' and n.entity_id in (
               select r2.id from rfqs r2
               join workshop_branches wb on wb.id = r2.workshop_branch_id
               join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid))
            or
            (n.entity_type = 'order' and n.entity_id in (
               select o2.id from orders o2
               join rfqs r3 on r3.id = o2.rfq_id
               join workshop_branches wb2 on wb2.id = r3.workshop_branch_id
               join workshop_users wu2 on wu2.workshop_id = wb2.workshop_id and wu2.user_id = ${ctx.userId}::uuid))
          )
          and (${entityType ? sql`n.entity_type = ${entityType}::entity_type and n.entity_id = ${entityId}::uuid` : sql`true`})
        order by n.created_at desc limit 200`);
      return { count: rows.length, notes: rows };
    });
  }

  async addNote(ctx: RlsContext, dto: { entityType: "rfq" | "order"; entityId: string; body: string }) {
    const env = envOf(ctx);
    const owned = await this.dbService.withContext(
      { tenantId: null, userId: ctx.userId, isInternal: true, environment: env },
      async (tx) => {
        await this.requireWorkshopUser(tx, ctx.userId);
        return dto.entityType === "rfq"
          ? this.resolveOwnedRfq(tx, ctx.userId, dto.entityId, env)
          : this.resolveOwnedOrder(tx, ctx.userId, dto.entityId, env);
      },
    );
    return this.dbService.withContext(
      { tenantId: owned.tenant_id, userId: ctx.userId, isInternal: false, environment: env },
      async (tx) => {
        const [row] = (await tx.execute(sql`
          insert into notes (tenant_id, environment, entity_type, entity_id, body, is_internal)
          values (${owned.tenant_id}::uuid, ${env}::environment_type, ${dto.entityType}::entity_type,
                  ${dto.entityId}::uuid, ${dto.body}, false)
          returning id, created_at`)) as Array<{ id: string; created_at: string }>;
        return row;
      },
    );
  }

  /** The workshop's own identity page: entity, activation, branches, workspaces, teammates. */
  async profile(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: envOf(ctx) }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const entity = (await tx.execute(sql`
        select w.id, w.name, w.tax_number, w.primary_email, w.primary_phone, w.activation_status,
               w.counterparty_type, wu.is_workshop_admin
        from workshops w join workshop_users wu on wu.workshop_id = w.id and wu.user_id = ${ctx.userId}::uuid
        limit 1`))[0] as object;
      const teammates = await tx.execute(sql`
        select u.full_name, u.email, wu2.is_workshop_admin
        from workshop_users wu join workshop_users wu2 on wu2.workshop_id = wu.workshop_id
        join users u on u.id = wu2.user_id
        where wu.user_id = ${ctx.userId}::uuid order by wu2.is_workshop_admin desc, u.full_name`);
      return { ...(entity as object), teammates };
    });
  }

  /** reasonId → its label; free note appended. Kept server-side so the exception's reason text is
   *  always the catalog's wording, not whatever a client sent. */
  private async reasonText(reasonId: string | undefined, note: string | undefined, table: "cancellation_reasons" | "return_reasons") {
    let label: string | null = null;
    if (reasonId) {
      label = (
        (await this.dbService.withContext({ tenantId: null, userId: null, isInternal: true }, (tx) =>
          tx.execute(sql`select label_en from ${sql.raw(table)} where id = ${reasonId}::uuid limit 1`),
        )) as Array<{ label_en: string }>
      )[0]?.label_en ?? null;
      if (!label) throw new BadRequestException("unknown reason");
    }
    const text = [label, note?.trim()].filter(Boolean).join(" — ");
    if (text.length < 3) throw new BadRequestException("a reason is required");
    return text.slice(0, 500);
  }

  /** The workshop's own cancellation/return requests — pending and decided — so the portal can
   *  show "طلبك تحت المراجعة/اتوافق عليه/اترفض" instead of a black hole after asking. */
  async myExceptions(ctx: RlsContext, kind?: "cancellation" | "return") {
    const env = envOf(ctx);
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true, environment: env }, async (tx) => {
      await this.requireWorkshopUser(tx, ctx.userId);
      const rows = await tx.execute(sql`
        with mine as (
          select ri.id, 'rfq_item' as etype, r.order_number, coalesce(ri.part_number, ri.part_description) as part
          from rfq_items ri
          join rfqs r on r.id = ri.rfq_id
          join workshop_branches wb on wb.id = r.workshop_branch_id
          join workshop_users wu on wu.workshop_id = wb.workshop_id and wu.user_id = ${ctx.userId}::uuid
          union all
          select oi.id, 'order_item', o.order_number, oi.final_part_number
          from order_items oi
          join orders o on o.id = oi.order_id
          join rfqs r2 on r2.id = o.rfq_id
          join workshop_branches wb2 on wb2.id = r2.workshop_branch_id
          join workshop_users wu2 on wu2.workshop_id = wb2.workshop_id and wu2.user_id = ${ctx.userId}::uuid
        )
        select e.id, e.kind, e.status, e.reason, e.created_at, e.resolved_at, e.resolution_note,
               m.order_number, m.part
        from workflow_exceptions e
        join mine m on m.id = e.entity_id and m.etype = e.entity_type::text
        where e.environment = ${env}::environment_type
          and e.kind <> 'hold'
          and (${kind ? sql`e.kind = ${kind}` : sql`true`})
        order by case e.status when 'open' then 0 else 1 end, e.created_at desc
        limit 200`);
      return { count: rows.length, requests: rows };
    });
  }

}
