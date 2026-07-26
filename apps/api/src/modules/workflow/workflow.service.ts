import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { envOf } from "../../common/env-guards.js";
import { AiService } from "../../common/ai.service.js";
import { ROUTABLE_PAGES, isPageKey, pageByKey } from "./pages.js";

/**
 * Workflow authoring API (QNEW-64). Super-admin only for now — owner's decision: build the module
 * first, decide who else sees it later.
 *
 * THE GRAPH IS ONE DOCUMENT, KEYED BY STATUS CODE — not by uuid. That single choice is what makes
 * "draw it myself / let the AI draw it / do half each" one feature:
 *   - the canvas sends the whole graph on save,
 *   - the AI assistant returns exactly the same shape,
 *   - the server resolves codes → ids, validates, and replaces the graph atomically.
 * A uuid-keyed API would force the model to invent identifiers it cannot know.
 *
 * Editing is only ever possible on a DRAFT. The database enforces that with triggers (0047), so
 * these checks are for good error messages, not for safety.
 */

const conditionSchema = z.record(z.unknown());

const stepSchema = z.object({
  /** status CODE from the governed catalog (item_statuses / vendor_statuses), never a uuid. */
  status: z.string().min(1).max(64),
  isEntry: z.boolean().optional().default(false),
  isTerminal: z.boolean().optional().default(false),
  slaHours: z.number().int().positive().max(8760).nullish(),
  x: z.number().finite().default(0),
  y: z.number().finite().default(0),
  sortOrder: z.number().int().min(0).default(0),
  /**
   * The stations this step appears on. A page is not just a location — it plays a ROLE:
   *   action   — this desk owns the work and its buttons are live
   *   watch    — read-only tracking; the record is visible but untouchable here
   *   optional — may intervene, possibly only after `afterHours` at the step
   * [] = appears wherever it already appears (the routing safety rule).
   *
   * A bare string is accepted and read as `action`, which is exactly what it meant before 0050.
   */
  pages: z
    .array(
      z.union([
        z.string().max(40),
        z.object({
          page: z.string().max(40),
          mode: z.enum(["action", "watch", "optional"]).default("action"),
          afterHours: z.number().int().positive().max(8760).nullish(),
        }),
      ]),
    )
    .optional()
    .default([])
    .transform((arr) =>
      arr.map((p) => (typeof p === "string" ? { page: p, mode: "action" as const, afterHours: null } : p)),
    ),
  /** Roles responsible while a record sits here. [] = unrestricted. */
  ownerRoles: z.array(z.string().max(40)).optional().default([]),
});

const transitionSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  labelEn: z.string().max(120).nullish(),
  labelAr: z.string().max(120).nullish(),
  requiresApproval: z.boolean().optional().default(false),
  allowedRoles: z.array(z.string().max(40)).optional().default([]),
  condition: conditionSchema.optional().default({}),
  priority: z.number().int().min(0).max(999).optional().default(0),
  /** What this move does to custody — see 0049. */
  handoff: z.enum(["pool", "keep", "actor"]).optional().default("pool"),
});

/** One station a step sits on, and what that station may do about it. */
export interface PageRef { page: string; mode: "action" | "watch" | "optional"; afterHours?: number | null }

export const placementSchema = z.object({
  status: z.string().min(1).max(64),
  pages: z
    .array(
      z.union([
        z.string().max(40),
        z.object({
          page: z.string().max(40),
          mode: z.enum(["action", "watch", "optional"]).default("action"),
          afterHours: z.number().int().positive().max(8760).nullish(),
        }),
      ]),
    )
    .max(20)
    .transform((arr) =>
      arr.map((p) => (typeof p === "string" ? { page: p, mode: "action" as const, afterHours: null } : p)),
    ),
});

export const createFlowSchema = z.object({
  flowKey: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "flow key: lowercase letters, numbers, - or _"),
  nameEn: z.string().min(2).max(120),
  nameAr: z.string().min(2).max(120),
  statusDomain: z.enum(["item", "vendor"]).default("item"),
  isDefault: z.boolean().optional().default(false),
});

export const assistSchema = z.object({
  /** The whole exchange so far. A workflow is decided by talking it through, not by one sentence —
   *  the model needs to be able to ask "who approves that?" and use the answer. */
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) }))
    .min(1)
    .max(40),
  /** The canvas as it stands now, so "add a step after pricing" has something to add to. */
  graph: z.object({ steps: z.array(stepSchema), transitions: z.array(transitionSchema) }).optional(),
});

export const saveGraphSchema = z.object({
  nameEn: z.string().min(2).max(120).optional(),
  nameAr: z.string().min(2).max(120).optional(),
  /** null = never auto-selected; {} = matches every record; {...} = a real condition. */
  selectionCondition: conditionSchema.nullable().optional(),
  canvas: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema).min(1).max(200),
  transitions: z.array(transitionSchema).max(1000).default([]),
});

export type SaveGraphDto = z.infer<typeof saveGraphSchema>;

@Injectable()
export class WorkflowService {
  constructor(
    private readonly dbService: DbService,
    private readonly ai: AiService,
  ) {}

  private requireSuperAdmin(ctx: RlsContext & { platformRole?: string | null }) {
    if (ctx.platformRole !== "super_admin")
      throw new ForbiddenException("only a super admin can manage workflows");
  }

  private requireTenant(ctx: RlsContext): string {
    if (!ctx.tenantId)
      throw new BadRequestException("pick a workspace first — a flow belongs to one workspace");
    return ctx.tenantId;
  }

  /**
   * Everything the canvas and the AI are allowed to reference. Both must be constrained to the SAME
   * governed vocabulary — otherwise the model invents statuses that look plausible and fail on save.
   */
  async catalog(ctx: RlsContext) {
    return this.dbService.withContext(ctx, async (tx) => {
      const item = await tx.execute(sql`
        select code, label_en, label_ar from item_statuses where is_active order by sort_order, code`);
      const vendor = await tx.execute(sql`
        select code, label_en, label_ar from vendor_statuses where is_active order by sort_order, code`);
      const roles = await tx.execute(sql`
        select unnest(enum_range(null::membership_role))::text as code`);
      const holders = (await tx.execute(sql`
        select role::text as code, count(*)::int as n from tenant_memberships
        where tenant_id = ${ctx.tenantId}::uuid and is_active group by role`)) as Array<
        { code: string; n: number }
      >;
      return {
        itemStatuses: item,
        vendorStatuses: vendor,
        roles: roles.map((r) => (r as { code: string }).code),
        pages: ROUTABLE_PAGES,
        holders: Object.fromEntries(holders.map((h) => [h.code, h.n])),
      };
    });
  }

  /**
   * MY WORK — every record currently resting on this user, plus the pool their roles may claim.
   *
   * This is the payoff for custody. Before it, "what am I supposed to be doing" meant opening each
   * list page and reading statuses, because responsibility was implicit in the status rather than
   * recorded against a person. It reads only workflow_record_state, so a workspace with no active
   * flow gets an empty result rather than a wrong one.
   *
   * `mine` is what has been claimed by or handed to this user. `pool` is unclaimed work their roles
   * are entitled to pick up — kept separate because "yours" and "available" are different prompts.
   */
  async myWork(ctx: RlsContext) {
    return this.dbService.withContext(ctx, async (tx) => {
      const roles = (await tx.execute(sql`
        select role::text as code from tenant_memberships
        where user_id = ${ctx.userId}::uuid and tenant_id = ${ctx.tenantId}::uuid and is_active
        union
        select role::text from platform_members where user_id = ${ctx.userId}::uuid and is_active`)) as Array<
        { code: string }
      >;
      const codes = roles.map((r) => r.code);

      // one row per held record, resolved to something displayable regardless of entity type
      const rows = await tx.execute(sql`
        select rs.entity_type, rs.entity_id, rs.assignee_role, rs.step_entered_at, rs.due_at,
               rs.assignee_user_id is not null as claimed,
               rs.due_at is not null and rs.due_at < now() as overdue,
               coalesce(r.order_number, o.order_number, ir.order_number, oo.order_number) as reference,
               coalesce(si.label_en, so.label_en, sii.label_en, soi.label_en) as status,
               coalesce(ii.part_number, oi.final_part_number) as part,
               f.name_en as flow
        from workflow_record_state rs
        join workflow_flows f on f.id = rs.flow_id
        left join rfqs       r  on rs.entity_type = 'rfq'        and r.id  = rs.entity_id
        left join orders     o  on rs.entity_type = 'order'      and o.id  = rs.entity_id
        left join rfq_items  ii on rs.entity_type = 'rfq_item'   and ii.id = rs.entity_id
        left join order_items oi on rs.entity_type = 'order_item' and oi.id = rs.entity_id
        left join rfqs   ir on ir.id = ii.rfq_id
        left join orders oo on oo.id = oi.order_id
        left join item_statuses si  on si.id  = r.status_id
        left join item_statuses so  on so.id  = o.status_id
        left join item_statuses sii on sii.id = ii.status_id
        left join item_statuses soi on soi.id = oi.status_id
        where rs.assignee_user_id = ${ctx.userId}::uuid
           or (rs.assignee_user_id is null and rs.assignee_role in (${
             codes.length ? sql.join(codes.map((c) => sql`${c}`), sql`, `) : sql`null`
           }))
        order by rs.due_at asc nulls last, rs.step_entered_at asc
        limit 100`);

      const mine = rows.filter((r) => (r as { claimed: boolean }).claimed);
      const pool = rows.filter((r) => !(r as { claimed: boolean }).claimed);
      return { mine, pool, overdue: rows.filter((r) => (r as { overdue: boolean }).overdue).length };
    });
  }

  /**
   * Take an unclaimed record, or hand one to someone else.
   *
   * Deliberately does NOT move the status: claiming is about responsibility, not progress, and
   * conflating the two would mean you could not pick something up without also advancing it.
   */
  async claim(ctx: RlsContext, entity: string, id: string, toUserId?: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const row = (await tx.execute(sql`
        select rs.assignee_role, rs.assignee_user_id from workflow_record_state rs
        where rs.entity_type = ${entity}::entity_type and rs.entity_id = ${id}::uuid limit 1`))[0] as
        { assignee_role: string | null; assignee_user_id: string | null } | undefined;
      if (!row) throw new NotFoundException("this record is not being tracked by a workflow");

      const target = toUserId ?? ctx.userId;
      // handing it to someone who cannot hold it would strand the record where nobody looks
      if (row.assignee_role) {
        const ok = (await tx.execute(sql`
          select 1 from tenant_memberships
          where user_id = ${target}::uuid and tenant_id = ${ctx.tenantId}::uuid and is_active
            and role::text = ${row.assignee_role}
          union
          select 1 from platform_members
          where user_id = ${target}::uuid and is_active and role::text = ${row.assignee_role}
          limit 1`))[0];
        if (!ok)
          throw new BadRequestException(
            `this step is held by ${row.assignee_role}; that person does not have the role`,
          );
      }
      await tx.execute(sql`
        update workflow_record_state set assignee_user_id = ${target}::uuid, updated_at = now()
        where entity_type = ${entity}::entity_type and entity_id = ${id}::uuid`);
      return { entity, id, assignedTo: target };
    });
  }

  /**
   * THE PAGE VIEW — the same workflow, read as screens instead of as a graph.
   *
   * Nothing here is stored. A page's composition is derived every time: the statuses placed on it,
   * who handles them, and — by looking up where each destination status is placed — which screen an
   * order moves to next. Deriving rather than duplicating is deliberate: `pages` is many-to-many
   * (a status legitimately sits on two screens), and the three things that actually read it at
   * runtime all read the STEPS. A page record holding its own copy would be a second truth that
   * nothing enforces, in the screen that is about to become the main view of the engine.
   */
  async pageView(ctx: RlsContext) {
    return this.dbService.withContext(ctx, async (tx) => {
      const flows = (await tx.execute(sql`
        select f.id, f.name_en, f.name_ar, f.version, f.status, f.is_default,
               (select count(*)::int from workflow_steps s where s.flow_id = f.id) as steps
        from workflow_flows f
        where f.tenant_id = ${ctx.tenantId}::uuid and f.environment = ${envOf(ctx)}
          and f.status_domain = 'item'
        order by case f.status when 'active' then 0 when 'draft' then 1 else 2 end,
                 f.is_default desc, f.version desc`)) as Array<{
        id: string; name_en: string; name_ar: string; version: number; status: string;
        is_default: boolean; steps: number;
      }>;
      // A flow with no steps has nothing to lay out, so prefer one that does — otherwise the screen
      // looks broken when a perfectly good flow exists next to an empty stub.
      const flow = flows.find((f) => f.steps > 0) ?? flows[0];

      if (!flow) return { flow: null, flows: [], pages: [], unplaced: [], holders: {} };

      const steps = (await tx.execute(sql`
        select s.id, coalesce(i.code, v.code) as code,
               coalesce(i.label_en, v.label_en) as label_en, coalesce(i.label_ar, v.label_ar) as label_ar,
               s.pages, s.owner_roles, s.is_entry, s.is_terminal, s.sla_hours
        from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.flow_id = ${flow.id}::uuid
        order by s.sort_order, s.created_at`)) as Array<Record<string, unknown>>;

      const moves = (await tx.execute(sql`
        select coalesce(fi.code, fv.code) as from_code, coalesce(ti.code, tv.code) as to_code,
               t.label_en, t.requires_approval, t.allowed_roles, t.handoff
        from workflow_transitions t
        join workflow_steps fs on fs.id = t.from_step_id
        join workflow_steps ts on ts.id = t.to_step_id
        left join item_statuses fi on fi.id = fs.item_status_id
        left join vendor_statuses fv on fv.id = fs.vendor_status_id
        left join item_statuses ti on ti.id = ts.item_status_id
        left join vendor_statuses tv on tv.id = ts.vendor_status_id
        where t.flow_id = ${flow.id}::uuid
        order by t.priority desc`)) as Array<Record<string, unknown>>;

      const holders = Object.fromEntries(
        ((await tx.execute(sql`
          select role::text as code, count(*)::int as n from tenant_memberships
          where tenant_id = ${ctx.tenantId}::uuid and is_active group by role`)) as Array<
          { code: string; n: number }
        >).map((h) => [h.code, h.n]),
      );

      const placedOn = (code: string) =>
        ((steps.find((s) => s.code === code)?.pages as PageRef[]) ?? []).map((p) => p.page);

      const pages = ROUTABLE_PAGES.map((p) => {
        const here = steps.filter((s) =>
          ((s.pages as PageRef[]) ?? []).some((x) => x.page === p.key),
        );
        const codes = new Set(here.map((s) => s.code as string));
        return {
          ...p,
          statuses: here.map((s) => {
            const pl = ((s.pages as PageRef[]) ?? []).find((x) => x.page === p.key);
            return {
              code: s.code, labelEn: s.label_en, labelAr: s.label_ar,
              ownerRoles: (s.owner_roles as string[]) ?? [],
              isEntry: s.is_entry, isTerminal: s.is_terminal, slaHours: s.sla_hours,
              mode: pl?.mode ?? "action",
              afterHours: pl?.afterHours ?? null,
            };
          }),
          // What can happen to work sitting here, and which screen it lands on afterwards. The
          // destination page is NOT a stored choice — it follows where the destination status is
          // placed, so there is exactly one place to change it.
          exits: moves
            .filter((m) => codes.has(m.from_code as string))
            .map((m) => ({
              from: m.from_code, to: m.to_code, action: m.label_en,
              requiresApproval: m.requires_approval, allowedRoles: (m.allowed_roles as string[]) ?? [],
              handoff: m.handoff,
              goesTo: placedOn(m.to_code as string),
              staysHere: placedOn(m.to_code as string).includes(p.key),
            })),
          owners: [...new Set(here.flatMap((s) => (s.owner_roles as string[]) ?? []))],
        };
      });

      return {
        flow: {
          id: flow.id, name: flow.name_en, nameAr: flow.name_ar,
          version: flow.version, status: flow.status, isDefault: flow.is_default,
          steps: flow.steps,
        },
        // every flow in the workspace, so the screen can say what it is showing and why
        flows: flows.map((f) => ({
          id: f.id, name: f.name_en, version: f.version, status: f.status, steps: f.steps,
        })),
        pages,
        // The safety rule made visible: a status placed nowhere shows on EVERY screen. It is the
        // most counter-intuitive behaviour in the system and today it is invisible everywhere.
        unplaced: steps
          .filter((s) => (((s.pages as PageRef[]) ?? []).length === 0))
          .map((s) => ({ code: s.code, labelEn: s.label_en, labelAr: s.label_ar })),
        holders,
      };
    });
  }

  /**
   * Move statuses onto and off a screen — WITHOUT publishing a new version.
   *
   * This is the one write that must work on an ACTIVE flow. Migration 0048 deliberately left `pages`
   * out of the freeze tuple precisely so a mis-routed status could be fixed in seconds, because a
   * status routed to the wrong screen makes live work vanish from the queue people watch. But
   * saveGraph — the only writer until now — refuses a non-draft flow and works by delete-and-
   * reinsert, which the freeze trigger blocks anyway. So the promise was unreachable.
   *
   * A targeted UPDATE of one column keeps it: the semantics stay frozen, the view stays tunable.
   */
  async setPlacement(
    ctx: RlsContext,
    id: string,
    dto: z.infer<typeof placementSchema>,
  ) {
    const bad = dto.pages.filter((p) => !isPageKey(p.page)).map((p) => p.page);
    if (bad.length) throw new BadRequestException(`unknown page(s): ${bad.join(", ")}`);

    return this.dbService.withContext(ctx, async (tx) => {
      const [step] = (await tx.execute(sql`
        select s.id from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.flow_id = ${id}::uuid and coalesce(i.code, v.code) = ${dto.status}
        limit 1`)) as Array<{ id: string }>;
      // Placing a status the flow does not contain would silently do nothing, and the screen would
      // show the change until it was reloaded. Refuse instead.
      if (!step)
        throw new BadRequestException(
          `'${dto.status}' is not part of this workflow, so it cannot be placed on a screen`,
        );

      await tx.execute(sql`
        update workflow_steps set pages = ${JSON.stringify(dto.pages)}::jsonb, updated_at = now()
        where id = ${step.id}::uuid`);
      return { status: dto.status, pages: dto.pages };
    });
  }

  /** All flows in the active workspace + environment, newest first. */
  async list(ctx: RlsContext) {
    const tenantId = this.requireTenant(ctx);
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select f.id, f.flow_key, f.version, f.name_en, f.name_ar, f.status, f.is_default,
               f.status_domain, f.selection_condition, f.created_at, f.updated_at,
               (select count(*)::int from workflow_steps s where s.flow_id = f.id) as steps,
               (select count(*)::int from workflow_transitions t where t.flow_id = f.id) as transitions,
               (select count(*)::int from workflow_record_state r where r.flow_id = f.id) as records
        from workflow_flows f
        where f.tenant_id = ${tenantId}::uuid and f.environment = ${envOf(ctx)}
        order by f.flow_key, f.version desc`),
    );
    return { count: rows.length, flows: rows };
  }

  /** One flow with its full graph — the canvas payload, and what the AI is shown as "current". */
  async get(ctx: RlsContext, id: string) {
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const flow = (await tx.execute(sql`
        select id, flow_key, version, name_en, name_ar, status, is_default, status_domain,
               selection_condition, canvas, created_at, updated_at
        from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as Record<string, unknown> | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");

      const steps = await tx.execute(sql`
        select s.id, coalesce(i.code, v.code) as status, coalesce(i.label_en, v.label_en) as label_en,
               coalesce(i.label_ar, v.label_ar) as label_ar,
               s.is_entry, s.is_terminal, s.sla_hours, s.canvas_x as x, s.canvas_y as y, s.sort_order,
               s.pages, s.owner_roles
        from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.flow_id = ${id}::uuid
        order by s.sort_order, s.created_at`);

      const transitions = await tx.execute(sql`
        select t.id,
               coalesce(fi.code, fv.code) as "from", coalesce(ti.code, tv.code) as "to",
               t.label_en, t.label_ar, t.requires_approval, t.allowed_roles, t.condition, t.priority,
               t.handoff
        from workflow_transitions t
        join workflow_steps fs on fs.id = t.from_step_id
        join workflow_steps ts on ts.id = t.to_step_id
        left join item_statuses fi on fi.id = fs.item_status_id
        left join vendor_statuses fv on fv.id = fs.vendor_status_id
        left join item_statuses ti on ti.id = ts.item_status_id
        left join vendor_statuses tv on tv.id = ts.vendor_status_id
        where t.flow_id = ${id}::uuid
        order by t.priority, t.created_at`);

      return { ...flow, steps, transitions };
    });
  }

  /** Create an empty draft. The graph arrives separately via saveGraph. */
  async create(ctx: RlsContext & { platformRole?: string | null }, dto: z.infer<typeof createFlowSchema>) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const next = (await tx.execute(sql`
        select coalesce(max(version), 0) + 1 as v from workflow_flows
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)} and flow_key = ${dto.flowKey}`))[0] as { v: number };
      const [row] = (await tx.execute(sql`
        insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
                                    status_domain, is_default)
        values (${tenantId}::uuid, ${envOf(ctx)}, ${dto.flowKey}, ${next.v}, ${dto.nameEn}, ${dto.nameAr},
                ${dto.statusDomain}, ${dto.isDefault})
        returning id, version`)) as Array<{ id: string; version: number }>;
      return { id: row.id, flowKey: dto.flowKey, version: row.version, status: "draft" };
    });
  }

  /**
   * Replace a draft's whole graph in one transaction. Idempotent by construction: the incoming
   * document is the complete desired state, so the canvas and the AI both just send what they have.
   */
  async saveGraph(ctx: RlsContext & { platformRole?: string | null }, id: string, dto: SaveGraphDto) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const flow = (await tx.execute(sql`
        select id, status, status_domain from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as { id: string; status: string; status_domain: "item" | "vendor" } | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");
      if (flow.status !== "draft")
        throw new ConflictException(
          `this flow is ${flow.status} — records are executing it. Create a new version to change it.`,
        );

      const codeToId = await this.resolveStatusCodes(tx, flow.status_domain, dto);
      this.validateGraph(dto);

      // full replace: the document IS the desired state
      await tx.execute(sql`delete from workflow_transitions where flow_id = ${id}::uuid`);
      await tx.execute(sql`delete from workflow_steps where flow_id = ${id}::uuid`);

      const stepIds = new Map<string, string>();
      for (const [i, s] of dto.steps.entries()) {
        const statusId = codeToId.get(s.status)!;
        const col = flow.status_domain === "item" ? sql`item_status_id` : sql`vendor_status_id`;
        const [row] = (await tx.execute(sql`
          insert into workflow_steps (tenant_id, environment, flow_id, status_domain, ${col},
                                      is_entry, is_terminal, sla_hours, canvas_x, canvas_y, sort_order,
                                      pages, owner_roles)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${id}::uuid, ${flow.status_domain}, ${statusId}::uuid,
                  ${s.isEntry}, ${s.isTerminal}, ${s.slaHours ?? null}, ${s.x}, ${s.y}, ${s.sortOrder || i},
                  ${JSON.stringify(s.pages)}::jsonb, ${JSON.stringify(s.ownerRoles)}::jsonb)
          returning id`)) as Array<{ id: string }>;
        stepIds.set(s.status, row.id);
      }

      for (const t of dto.transitions) {
        await tx.execute(sql`
          insert into workflow_transitions (tenant_id, environment, flow_id, from_step_id, to_step_id,
                                            label_en, label_ar, requires_approval, allowed_roles,
                                            condition, priority, handoff)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${id}::uuid, ${stepIds.get(t.from)!}::uuid,
                  ${stepIds.get(t.to)!}::uuid, ${t.labelEn ?? null}, ${t.labelAr ?? null},
                  ${t.requiresApproval}, ${JSON.stringify(t.allowedRoles)}::jsonb,
                  ${JSON.stringify(t.condition)}::jsonb, ${t.priority}, ${t.handoff})`);
      }

      await tx.execute(sql`
        update workflow_flows set
          name_en = coalesce(${dto.nameEn ?? null}, name_en),
          name_ar = coalesce(${dto.nameAr ?? null}, name_ar),
          selection_condition = ${dto.selectionCondition === undefined ? sql`selection_condition` : dto.selectionCondition === null ? sql`null` : sql`${JSON.stringify(dto.selectionCondition)}::jsonb`},
          canvas = coalesce(${dto.canvas ? JSON.stringify(dto.canvas) : null}::jsonb, canvas)
        where id = ${id}::uuid`);

      return { id, steps: dto.steps.length, transitions: dto.transitions.length };
    });
  }

  /** draft → active. This is the gate: everything that would wedge a record is checked HERE. */
  async activate(ctx: RlsContext & { platformRole?: string | null }, id: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const flow = (await tx.execute(sql`
        select id, flow_key, status, is_default, selection_condition from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as
        | { id: string; flow_key: string; status: string; is_default: boolean; selection_condition: unknown }
        | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");
      if (flow.status !== "draft") throw new ConflictException(`flow is already ${flow.status}`);

      await this.assertActivatable(tx, id, flow);

      // retire the predecessor FIRST — the partial unique index permits only one active version and
      // is not deferrable, so the other order fails.
      await tx.execute(sql`
        update workflow_flows set status = 'retired'
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and flow_key = ${flow.flow_key} and status = 'active'`);
      await tx.execute(sql`update workflow_flows set status = 'active' where id = ${id}::uuid`);
      return { id, status: "active" };
    });
  }

  async retire(ctx: RlsContext & { platformRole?: string | null }, id: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const r = await tx.execute(sql`
        update workflow_flows set status = 'retired'
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and status <> 'retired'
        returning id`);
      if (r.length === 0) throw new NotFoundException("flow not found, or already retired");
      return { id, status: "retired" };
    });
  }

  /** Clone any flow into a fresh draft — the supported way to change an active flow. */
  async newVersion(ctx: RlsContext & { platformRole?: string | null }, id: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const src = (await tx.execute(sql`
        select * from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as Record<string, unknown> | undefined;
      if (!src) throw new NotFoundException("flow not found in this workspace");

      const next = (await tx.execute(sql`
        select coalesce(max(version), 0) + 1 as v from workflow_flows
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)} and flow_key = ${src.flow_key as string}`))[0] as { v: number };

      // is_default stays FALSE on the clone: two active defaults is the failure the partial index
      // exists to prevent, and activate() hands the flag over deliberately instead.
      const [copy] = (await tx.execute(sql`
        insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
                                    status_domain, is_default, selection_condition, canvas)
        values (${tenantId}::uuid, ${envOf(ctx)}, ${src.flow_key as string}, ${next.v},
                ${src.name_en as string}, ${src.name_ar as string}, ${src.status_domain as string},
                false, ${src.selection_condition === null ? sql`null` : sql`${JSON.stringify(src.selection_condition)}::jsonb`},
                ${JSON.stringify(src.canvas)}::jsonb)
        returning id`)) as Array<{ id: string }>;

      // copy the graph, remapping step ids
      const steps = (await tx.execute(sql`
        select id, status_domain, item_status_id, vendor_status_id, is_entry, is_terminal, sla_hours,
               canvas_x, canvas_y, sort_order, pages, owner_roles
        from workflow_steps where flow_id = ${id}::uuid`)) as Array<Record<string, unknown>>;
      const map = new Map<string, string>();
      for (const s of steps) {
        const [ns] = (await tx.execute(sql`
          insert into workflow_steps (tenant_id, environment, flow_id, status_domain, item_status_id,
                                      vendor_status_id, is_entry, is_terminal, sla_hours,
                                      canvas_x, canvas_y, sort_order, pages, owner_roles)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${copy.id}::uuid, ${s.status_domain as string},
                  ${(s.item_status_id as string) ?? null}, ${(s.vendor_status_id as string) ?? null},
                  ${s.is_entry as boolean}, ${s.is_terminal as boolean}, ${(s.sla_hours as number) ?? null},
                  ${s.canvas_x as number}, ${s.canvas_y as number}, ${s.sort_order as number},
                  ${JSON.stringify(s.pages ?? [])}::jsonb, ${JSON.stringify(s.owner_roles ?? [])}::jsonb)
          returning id`)) as Array<{ id: string }>;
        map.set(s.id as string, ns.id);
      }
      const trs = (await tx.execute(sql`
        select from_step_id, to_step_id, label_en, label_ar, requires_approval, allowed_roles,
               condition, priority, handoff
        from workflow_transitions where flow_id = ${id}::uuid`)) as Array<Record<string, unknown>>;
      for (const t of trs) {
        await tx.execute(sql`
          insert into workflow_transitions (tenant_id, environment, flow_id, from_step_id, to_step_id,
                                            label_en, label_ar, requires_approval, allowed_roles,
                                            condition, priority, handoff)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${copy.id}::uuid,
                  ${map.get(t.from_step_id as string)!}::uuid, ${map.get(t.to_step_id as string)!}::uuid,
                  ${(t.label_en as string) ?? null}, ${(t.label_ar as string) ?? null},
                  ${t.requires_approval as boolean}, ${JSON.stringify(t.allowed_roles)}::jsonb,
                  ${JSON.stringify(t.condition)}::jsonb, ${t.priority as number},
                  ${(t.handoff as string) ?? 'pool'})`);
      }
      return { id: copy.id, flowKey: src.flow_key, version: next.v, status: "draft", copiedFrom: id };
    });
  }

  /** Drafts only — the DB trigger enforces this too; here it is for the error message. */
  async remove(ctx: RlsContext & { platformRole?: string | null }, id: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const r = await tx.execute(sql`
        delete from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and status = 'draft'
        returning id`);
      if (r.length === 0)
        throw new ConflictException("only a draft can be deleted — retire an active flow instead");
      return { id, deleted: true };
    });
  }

  /**
   * Draft a graph from a plain-language description. THE MODEL PROPOSES — nothing is written.
   *
   * Three guards, in order, because a plausible-looking wrong flow is the expensive failure here:
   *   1. the model is handed ONLY the governed status catalog and told it may use nothing else,
   *   2. every code it returns is resolved against that catalog and the whole reply is rejected if
   *      any is unknown (it cannot invent "manager_review" and have it quietly saved),
   *   3. the same structural validation the canvas save uses runs before the reply is returned.
   * The human then reviews it on the canvas and presses Save.
   */
  async assist(ctx: RlsContext & { platformRole?: string | null }, id: string, dto: z.infer<typeof assistSchema>) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);

    const { flow, catalog, roles, holders } = await this.dbService.withContext(ctx, async (tx) => {
      const f = (await tx.execute(sql`
        select id, name_en, status, status_domain from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as { id: string; name_en: string; status: string; status_domain: "item" | "vendor" } | undefined;
      if (!f) throw new NotFoundException("flow not found in this workspace");
      if (f.status !== "draft")
        throw new ConflictException(`this flow is ${f.status} — create a new version to change it`);
      const table = f.status_domain === "vendor" ? sql`vendor_statuses` : sql`item_statuses`;
      const cat = (await tx.execute(sql`
        select code, label_en, label_ar from ${table} where is_active order by sort_order, code`)) as Array<{
        code: string; label_en: string; label_ar: string;
      }>;
      const r = (await tx.execute(sql`select unnest(enum_range(null::membership_role))::text as code`)) as Array<{ code: string }>;
      const h = (await tx.execute(sql`
        select role::text as code, count(*)::int as n from tenant_memberships
        where tenant_id = ${tenantId}::uuid and is_active group by role`)) as Array<
        { code: string; n: number }
      >;
      return {
        flow: f,
        catalog: cat,
        roles: r.map((x) => x.code),
        holders: Object.fromEntries(h.map((x) => [x.code, x.n])) as Record<string, number>,
      };
    });

    const system = [
      "You are a workflow assistant for a Saudi auto spare-parts procurement platform. You TALK WITH",
      "the admin to work out what their order flow should be, and you draw it once it is clear.",
      "",
      "ALWAYS reply in the language the admin used (Egyptian/Gulf Arabic if they wrote Arabic).",
      "",
      "SET drawGraph=false — reply with words only — when:",
      "  • they greeted you or made small talk (say hello back, then ask what flow they want),",
      "  • the request is too vague to draw (ask ONE or TWO specific questions, do not interrogate),",
      "  • they asked a question about the workflow rather than asking for a change,",
      "  • something important is genuinely ambiguous — e.g. an approval was mentioned but not who",
      "    approves it, or a branch was described without saying when it is taken.",
      "Never invent an answer to something you should ask about. Never draw a whole flow off a",
      "greeting.",
      "",
      "SET drawGraph=true only when you can draw something the admin actually asked for. Then also",
      "say in `reply`, in one sentence, what you drew and what you assumed.",
      "",
      "Keep replies SHORT — two or three sentences. This is a side panel, not an essay.",
      "",
      "HARD RULES when drawGraph is true — a reply breaking any of these is discarded:",
      "1. `status` on every step MUST be one of the codes listed below, copied exactly. Never invent one.",
      "2. Exactly ONE step has isEntry true.",
      "3. At least one step has isTerminal true.",
      "4. Every transition's `from` and `to` must be codes of steps you included.",
      "5. No transition from a step to itself.",
      "5b. AT MOST ONE transition per (from, to) pair. To say a move needs sign-off, set",
      "    requiresApproval:true on that single transition — do NOT draw a second parallel arrow.",
      "6. `allowedRoles` entries must come from the roles list below.",
      "7. Layout — a single long row forces the canvas to zoom out until the labels are unreadable,",
      "   so WRAP the path instead of running it off to the right:",
      "     • Main path reads left-to-right starting at x=80, y=100, stepping x by 260.",
      "     • AT MOST 5 steps per row. After the 5th, go back to x=80 and add 200 to y.",
      "     • Put side branches (cancellation, unavailable, rejection) on their own row below the",
      "       main path, roughly under the step they branch from.",
      "     • Keep every x and y a multiple of 20.",
      "",
      "8. `ownerRoles` on a step = who is RESPONSIBLE while a record sits there. `allowedRoles` on a",
      "   transition = who may fire that ONE arrow. Use the step-level owner when a whole desk belongs",
      "   to a team, and single out a transition only when one move needs a narrower permission.",
      "   Do not repeat the same role in both — it adds nothing.",
      "9. NEVER name a role shown below as '0 people': every record would stall there with nobody",
      "   able to move it. If the natural owner has no holders, leave ownerRoles empty and SAY SO.",
      "10. `pages` routes a step's records to a screen — use only the page KEYS listed below. Leave it",
      "    empty unless the admin actually asked where things should show up; empty means the record",
      "    keeps appearing exactly where it does today, which is the safe default.",
      "",
      "11. `handoff` decides who HOLDS the record after the move: 'pool' releases it to the next",
      "    step's owners (right for a real handover between teams, and the default), 'keep' leaves it",
      "    with the same person (right when one person does several steps in a row), 'actor' gives it",
      "    to whoever made the move (right when picking something up IS taking it on).",
      "",
      "Write `labelEn` on each transition as the ACTION that causes it (Quote, Confirm, Deliver).",
      "Set requiresApproval true only where the user actually asked for an approval or a gate.",
      "",
      "AVAILABLE STATUS CODES (code — English label):",
      ...catalog.map((c) => `  ${c.code} — ${c.label_en}`),
      "",
      "AVAILABLE ROLES (never pick one with 0 people):",
      ...roles.map((r) => `  ${r} — ${holders[r] ?? 0} people`),
      "",
      "AVAILABLE PAGE KEYS:",
      ...ROUTABLE_PAGES.map((p) => `  ${p.key} — ${p.labelEn}${p.wired ? "" : "  (NOT BUILT YET — avoid)"}`),
    ].join("\n");

    const current = dto.graph && dto.graph.steps.length
      ? `The canvas currently holds this graph — modify it rather than starting over:\n${JSON.stringify(dto.graph)}`
      : "The canvas is currently empty.";
    const transcript = dto.messages.map((m) => `${m.role === "user" ? "ADMIN" : "YOU"}: ${m.text}`).join("\n");
    const user = `${current}\n\nThe conversation so far:\n${transcript}\n\nReply to the ADMIN's last message.`;

    const RESULT_SCHEMA = {
      type: "object",
      properties: {
        reply: {
          type: "string",
          description: "what you say to the admin, in THEIR language. Short — 2-3 sentences.",
        },
        drawGraph: {
          type: "boolean",
          description: "true only when you are drawing/updating the flow; false for talk and questions",
        },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              status: { type: "string" },
              isEntry: { type: "boolean" },
              isTerminal: { type: "boolean" },
              slaHours: { type: "integer" },
              ownerRoles: {
                type: "array", items: { type: "string" },
                description: "roles responsible while a record sits here; [] leaves it open",
              },
              pages: {
                type: "array", items: { type: "string" },
                description: "page KEYS this step surfaces on; [] leaves it where it appears today",
              },
              x: { type: "integer" },
              y: { type: "integer" },
            },
            required: ["status", "isEntry", "isTerminal", "x", "y"],
          },
        },
        transitions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              labelEn: { type: "string" },
              requiresApproval: { type: "boolean" },
              allowedRoles: { type: "array", items: { type: "string" } },
              handoff: {
                type: "string", enum: ["pool", "keep", "actor"],
                description: "custody after this move: pool (release to the next desk), keep, actor",
              },
              priority: { type: "integer" },
            },
            required: ["from", "to"],
          },
        },
      },
      required: ["reply", "drawGraph"],
    };

    const raw = await this.ai.json<{
      reply: string; drawGraph: boolean; steps?: unknown[]; transitions?: unknown[];
    }>(system, user, RESULT_SCHEMA);

    // conversation turn with nothing to draw — the common case for a greeting or a question
    if (!raw.drawGraph || !raw.steps?.length) return { reply: raw.reply, drew: false as const };

    // parse through the SAME zod schema the save path uses — the model gets no looser contract
    const parsed = saveGraphSchema.safeParse({ steps: raw.steps, transitions: raw.transitions ?? [] });
    if (!parsed.success)
      throw new BadRequestException(`the assistant returned a graph we cannot use: ${parsed.error.issues[0]?.message}`);

    const known = new Set(catalog.map((c) => c.code));
    const invented = [...new Set(parsed.data.steps.map((s) => s.status))].filter((c) => !known.has(c));
    if (invented.length)
      throw new BadRequestException(
        `the assistant suggested statuses that do not exist here: ${invented.join(", ")}. Try describing it with the statuses you have.`,
      );

    // Safety net: a model that still emits parallel arrows for the same pair gets them separated
    // rather than the whole reply thrown away. Being forgiving of the model and strict about the
    // RESULT is the right split — the human reviews it on the canvas either way.
    const seen = new Map<string, number>();
    for (const t of parsed.data.transitions) {
      const k = `${t.from}>${t.to}`;
      const n = seen.get(k) ?? 0;
      if (n > 0) t.priority = n;
      seen.set(k, n + 1);
    }

    this.validateGraph(parsed.data);
    // nothing is persisted: the canvas renders this and the human decides
    return {
      reply: raw.reply,
      drew: true as const,
      flow: flow.name_en,
      steps: parsed.data.steps,
      transitions: parsed.data.transitions,
    };
  }

  // ── validation ────────────────────────────────────────────────────────────

  /** Every referenced code must exist in THIS flow's vocabulary. Reject the whole document if not —
   *  a partially-valid graph saved is worse than one rejected with a clear list. */
  private async resolveStatusCodes(tx: Tx, domain: "item" | "vendor", dto: SaveGraphDto) {
    const table = domain === "vendor" ? sql`vendor_statuses` : sql`item_statuses`;
    const codes = [...new Set(dto.steps.map((s) => s.status))];
    const rows = (await tx.execute(sql`
      select id, code from ${table} where code in (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`)) as Array<{
      id: string;
      code: string;
    }>;
    const map = new Map(rows.map((r) => [r.code, r.id]));
    const unknown = codes.filter((c) => !map.has(c));
    if (unknown.length)
      throw new BadRequestException(
        `unknown ${domain} status code(s): ${unknown.join(", ")} — use GET /admin/workflows/catalog`,
      );
    return map;
  }

  /** Structural rules that make a graph coherent. Checked on every save so the canvas and the AI get
   *  the same answer, rather than discovering it at activation. */
  private validateGraph(dto: SaveGraphDto) {
    const errs: string[] = [];
    const seen = new Set<string>();
    for (const s of dto.steps) {
      if (seen.has(s.status)) errs.push(`step '${s.status}' appears more than once`);
      seen.add(s.status);
    }
    const entries = dto.steps.filter((s) => s.isEntry);
    if (entries.length !== 1)
      errs.push(`a flow needs exactly one entry step (found ${entries.length})`);
    for (const t of dto.transitions) {
      if (!seen.has(t.from)) errs.push(`transition from '${t.from}', which is not a step in this flow`);
      if (!seen.has(t.to)) errs.push(`transition to '${t.to}', which is not a step in this flow`);
      if (t.from === t.to) errs.push(`transition '${t.from}' → itself does nothing`);
    }
    const dup = new Set<string>();
    for (const t of dto.transitions) {
      const k = `${t.from}→${t.to}#${t.priority}`;
      if (dup.has(k)) errs.push(`two transitions '${t.from}' → '${t.to}' share priority ${t.priority}`);
      dup.add(k);
    }
    if (errs.length) throw new BadRequestException(errs.join("; "));

    for (const st of dto.steps) {
      const bad = st.pages.filter((p) => !isPageKey(p.page)).map((p) => p.page);
      if (bad.length)
        throw new BadRequestException(
          `step '${st.status}' is routed to unknown page(s): ${bad.join(", ")}`,
        );
    }
  }

  /**
   * Activation is stricter than saving: a draft may be half-drawn, but a LIVE flow that can wedge a
   * record is the failure mode this whole design exists to prevent.
   */
  private async assertActivatable(
    tx: Tx,
    id: string,
    flow: { is_default: boolean; selection_condition: unknown },
  ) {
    const steps = (await tx.execute(sql`
      select s.id, coalesce(i.code, v.code) as code, s.is_entry, s.is_terminal, s.owner_roles
      from workflow_steps s
      left join item_statuses i on i.id = s.item_status_id
      left join vendor_statuses v on v.id = s.vendor_status_id
      where s.flow_id = ${id}::uuid`)) as Array<{ id: string; code: string; is_entry: boolean; is_terminal: boolean }>;
    const edges = (await tx.execute(sql`
      select from_step_id, to_step_id from workflow_transitions where flow_id = ${id}::uuid`)) as Array<{
      from_step_id: string;
      to_step_id: string;
    }>;

    const errs: string[] = [];
    if (steps.length === 0) errs.push("the flow has no steps");
    const entry = steps.find((s) => s.is_entry);
    if (!entry) errs.push("no entry step — new records would have nowhere to start");
    if (!steps.some((s) => s.is_terminal)) errs.push("no terminal step — records could never finish");
    if (!flow.is_default && flow.selection_condition === null)
      errs.push("routing is not set: give it a selection condition, or make it the default flow");

    // a non-terminal step with no way out wedges every record that reaches it
    const out = new Set(edges.map((e) => e.from_step_id));
    for (const s of steps) {
      if (!s.is_terminal && !out.has(s.id))
        errs.push(`step '${s.code}' is not terminal and has no outgoing transition — records would stall there`);
    }
    // and a step nothing can reach is dead weight the canvas will happily draw
    if (entry) {
      const adj = new Map<string, string[]>();
      for (const e of edges) adj.set(e.from_step_id, [...(adj.get(e.from_step_id) ?? []), e.to_step_id]);
      const seen = new Set([entry.id]);
      const queue = [entry.id];
      while (queue.length) {
        for (const n of adj.get(queue.shift()!) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
      }
      for (const s of steps) {
        if (!seen.has(s.id)) errs.push(`step '${s.code}' cannot be reached from the entry step`);
      }
    }
    if (errs.length) throw new BadRequestException(errs.join("; "));

    // An owner role with no holders is not a configuration opinion — it is a step no human can move
    // a record out of. Activation is the last cheap moment to say so; after it, real orders stall.
    const holders = new Map(
      ((await tx.execute(sql`
        select m.role::text as code, count(*)::int as n
        from tenant_memberships m
        join workflow_flows f on f.tenant_id = m.tenant_id
        where f.id = ${id}::uuid and m.is_active
        group by m.role`)) as Array<{ code: string; n: number }>).map((h) => [h.code, h.n]),
    );
    for (const st of steps as Array<{ code: string; is_terminal: boolean; owner_roles?: string[] }>) {
      const unstaffed = (st.owner_roles ?? []).filter((r) => !holders.get(r));
      if (unstaffed.length && !st.is_terminal)
        throw new BadRequestException(
          `step '${st.code}' is handled by ${unstaffed.join(", ")}, but nobody in this workspace ` +
            `holds ${unstaffed.length > 1 ? "those roles" : "that role"} — every order would stall ` +
            `there. Assign someone, or clear the owner on that step.`,
        );
    }
  }
}
