import {
  BadRequestException, ForbiddenException, Injectable, Logger, type OnApplicationBootstrap,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { envOf, type Environment } from "../../common/env-guards.js";
import { STANDARD_FLOWS, templateFor, type FlowTemplate } from "./template.js";
import { WorkflowService } from "./workflow.service.js";

/**
 * PROVISIONING AND RESET — "every workspace already HAS a workflow, and can put it back".
 *
 * Before this, a workspace's workflow started as nothing. Building one meant drawing every step and
 * every arrow from an empty canvas, and the only worked example in the database was a demo flow
 * that would have broken the product on the first click if anybody had pressed Activate. The
 * template (template.ts) is a transcription of what the application actually does, so a workspace
 * can now start from its own working flow and change the parts it disagrees with.
 *
 * THE ONE RULE THAT OUTRANKS EVERYTHING ELSE HERE: a workspace that already has a flow of its own
 * is NEVER touched by provisioning. Somebody may have drawn it; replacing it would destroy a
 * customer's configuration, and doing so silently at process start would destroy it with no request
 * in any log to explain it. `ensure` therefore checks for the existence of ANY flow in the
 * (workspace, environment, status_domain) it is about to fill and does nothing at all if one is
 * there — draft, active or retired.
 */

/** Provisioning writes the workspace's own rows, so it runs as the platform rather than as a user. */
const INTERNAL = (environment: Environment): RlsContext => ({
  tenantId: null,
  userId: null,
  isInternal: true,
  environment,
});

/**
 * WHY 'live' ONLY.
 *
 * Flows are per-environment by design (ADR-0012): you draw and test in Sandbox, then build and
 * activate in Live. Sandbox is the drawing board — handing it a pre-activated rulebook would start
 * enforcing rules in the one environment whose whole purpose is trying rules out, and the engine's
 * rollout promise is "permissive until configured". A workspace that wants the standard flow in
 * Sandbox can create it there; the Workflows screen still offers that path.
 */
const PROVISIONED_ENVIRONMENTS: Environment[] = ["live"];

export interface DomainOutcome {
  statusDomain: "item" | "vendor";
  /** created = the workspace had nothing here; kept = it already had a flow and was left alone. */
  outcome: "created" | "kept";
  flowId: string;
  flowKey: string;
  version: number;
  status: string;
}

@Injectable()
export class WorkflowTemplateService implements OnApplicationBootstrap {
  private readonly log = new Logger("WorkflowTemplate");

  constructor(
    private readonly dbService: DbService,
    private readonly workflows: WorkflowService,
  ) {}

  /**
   * Existing workspaces get the standard flow at process start.
   *
   * A migration could not do this: the template is TypeScript, and a SQL copy of it would be a
   * second definition of the product's behaviour that nothing keeps in step with the first. A
   * one-off script could not either — "every existing workspace has one" would then depend on
   * somebody remembering to run it on every environment, and the workspace that got missed is the
   * workspace whose workflow screen is empty.
   *
   * It is safe to run on every boot because `ensure` is a no-op for a workspace that already has a
   * flow, which after the first successful pass is every workspace. Failure is logged and swallowed
   * on purpose: an unreachable database at boot must not stop the API serving the requests it can.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const result = await this.provisionAll();
      const created = result.filter((r) => r.outcome === "created").length;
      if (created) this.log.log(`standard workflow provisioned for ${created} workspace/domain pair(s)`);
    } catch (e) {
      this.log.error(`could not provision standard workflows: ${(e as Error).message}`);
    }
  }

  async provisionAll(): Promise<Array<DomainOutcome & { tenantId: string; environment: Environment }>> {
    const out: Array<DomainOutcome & { tenantId: string; environment: Environment }> = [];
    for (const environment of PROVISIONED_ENVIRONMENTS) {
      const tenants = (await this.dbService.withContext(INTERNAL(environment), (tx) =>
        tx.execute(sql`select id from tenants order by created_at`),
      )) as Array<{ id: string }>;
      for (const t of tenants) {
        for (const r of await this.ensure(t.id, environment)) {
          out.push({ ...r, tenantId: t.id, environment });
        }
      }
    }
    return out;
  }

  /**
   * Give ONE workspace the standard flows, in both status domains, if it has none.
   *
   * Called at boot for every existing workspace, and again the moment a new workspace is created,
   * so "a workspace arrives with a workflow" is true of a workspace made thirty seconds ago rather
   * than only of one that survived a restart.
   */
  async ensure(tenantId: string, environment: Environment = "live"): Promise<DomainOutcome[]> {
    const out: DomainOutcome[] = [];
    for (const template of STANDARD_FLOWS) {
      out.push(await this.ensureOne(tenantId, environment, template));
    }
    return out;
  }

  private async ensureOne(
    tenantId: string,
    environment: Environment,
    template: FlowTemplate,
  ): Promise<DomainOutcome> {
    return this.dbService.withContext(INTERNAL(environment), async (tx) => {
      // THE UNTOUCHABILITY CHECK, and it is deliberately about the DOMAIN and not about the key. A
      // workspace that drew its own item flow under any name has answered the question "what is the
      // workflow here", and dropping a second one in beside it would either fight it for the
      // default slot or sit in the list as a decision nobody made.
      // Ordered so the row reported back is the one that actually GOVERNS. A workspace can hold
      // several flows in a domain — a non-default active one, older retired versions — and only the
      // active default is consulted by status.service.ts. Ranking by status alone left two active
      // flows tied, so the answer to "which flow does this workspace use" depended on the order the
      // planner happened to return.
      const existing = (await tx.execute(sql`
        select id, flow_key, version, status from workflow_flows
        where tenant_id = ${tenantId}::uuid and environment = ${environment}
          and status_domain = ${template.statusDomain}
        order by (status = 'active' and is_default) desc,
                 case status when 'active' then 0 when 'draft' then 1 else 2 end,
                 version desc
        limit 1`))[0] as
        | { id: string; flow_key: string; version: number; status: string }
        | undefined;
      if (existing) {
        return {
          statusDomain: template.statusDomain,
          outcome: "kept" as const,
          flowId: existing.id,
          flowKey: existing.flow_key,
          version: existing.version,
          status: existing.status,
        };
      }

      const flow = await this.publish(tx, tenantId, environment, template);
      return {
        statusDomain: template.statusDomain,
        outcome: "created" as const,
        flowId: flow.id,
        flowKey: template.flowKey,
        version: flow.version,
        status: "active",
      };
    });
  }

  /**
   * RESET — put a workspace's flow back to the standard one.
   *
   * IT PUBLISHES A NEW VERSION RATHER THAN EDITING ANYTHING. An active flow cannot be edited: the
   * database freezes its steps and transitions (trg_workflow_*_freeze) precisely so that an order
   * halfway through cannot have its rules rewritten underneath it. So reset writes version N+1 of
   * the standard flow, activates it, and retires whatever was the default before.
   *
   * THE CONSEQUENCE, WHICH THE SCREEN ALSO HAS TO SAY: records already in flight are bound to the
   * flow version they entered under (workflow_record_state.flow_id) and assertTransitionAllowed
   * follows that binding, so they finish under the rules they started with. A reset that silently
   * re-pointed live orders at a different rulebook would be the exact failure the versioning exists
   * to prevent — and it would be worse than an edit, because the person pressing Reset believes
   * they are restoring a default, not changing an order.
   */
  async reset(
    ctx: RlsContext & { platformRole?: string | null },
    statusDomain: "item" | "vendor",
  ): Promise<{
    flowId: string;
    flowKey: string;
    version: number;
    statusDomain: "item" | "vendor";
    replaced: Array<{ id: string; flowKey: string; version: number }>;
    inFlightKeepingOldRules: number;
  }> {
    // Same door as every other write in WorkflowService: platform staff may LOOK, only a super admin
    // may CHANGE. Forbidden rather than BadRequest — the request is well formed, the caller is not
    // allowed to make it.
    if (ctx.platformRole !== "super_admin")
      throw new ForbiddenException("only a super admin can reset a workspace's workflow");
    if (!ctx.tenantId)
      throw new BadRequestException("pick a workspace first — a flow belongs to one workspace");
    const tenantId = ctx.tenantId;
    const environment = envOf(ctx);
    const template = templateFor(statusDomain);

    return this.dbService.withContext({ ...ctx, tenantId }, async (tx) => {
      // How many records are mid-flight right now, so the answer can say what the reset did NOT do.
      const [inFlight] = (await tx.execute(sql`
        select count(*)::int as n from workflow_record_state rs
        join workflow_flows f on f.id = rs.flow_id
        where rs.tenant_id = ${tenantId}::uuid and rs.environment = ${environment}
          and f.status_domain = ${statusDomain}`)) as Array<{ n: number }>;

      const flow = await this.publish(tx, tenantId, environment, template);
      return {
        flowId: flow.id,
        flowKey: template.flowKey,
        version: flow.version,
        statusDomain,
        replaced: flow.retired,
        inFlightKeepingOldRules: inFlight?.n ?? 0,
      };
    });
  }

  /**
   * Write the template as a NEW version of its flow key and make it the workspace's default.
   *
   * The order of the last two statements is not a style choice. workflow_flows_default_uq is a
   * partial unique index on (tenant_id, environment, status_domain) WHERE is_default AND active,
   * and it is not deferrable — so anything already holding the default slot has to be retired
   * BEFORE this one becomes active, or the transaction dies on a constraint violation.
   */
  private async publish(
    tx: Tx,
    tenantId: string,
    environment: Environment,
    template: FlowTemplate,
  ): Promise<{ id: string; version: number; retired: Array<{ id: string; flowKey: string; version: number }> }> {
    const [next] = (await tx.execute(sql`
      select coalesce(max(version), 0) + 1 as v from workflow_flows
      where tenant_id = ${tenantId}::uuid and environment = ${environment}
        and flow_key = ${template.flowKey}`)) as Array<{ v: number }>;

    // selection_condition '{}' means "matches every record". It is set rather than left null
    // because activation refuses a flow that is neither the default nor conditional, and because a
    // future reader has to be able to tell "matches everything" from "never selected" (null).
    const [flow] = (await tx.execute(sql`
      insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
                                  status_domain, status, is_default, selection_condition)
      values (${tenantId}::uuid, ${environment}, ${template.flowKey}, ${next.v},
              ${template.nameEn}, ${template.nameAr}, ${template.statusDomain}, 'draft', true,
              '{}'::jsonb)
      returning id`)) as Array<{ id: string }>;

    const codes = await this.resolveCodes(tx, template);
    const stepIds = new Map<string, string>();
    const col = template.statusDomain === "item" ? sql`item_status_id` : sql`vendor_status_id`;
    for (const [i, s] of template.steps.entries()) {
      const [row] = (await tx.execute(sql`
        insert into workflow_steps (tenant_id, environment, flow_id, status_domain, ${col},
                                    is_entry, is_terminal, canvas_x, canvas_y, sort_order,
                                    pages, owner_roles)
        values (${tenantId}::uuid, ${environment}, ${flow.id}::uuid, ${template.statusDomain},
                ${codes.get(s.status)!}::uuid, ${!!s.isEntry}, ${!!s.isTerminal}, ${s.x}, ${s.y}, ${i},
                ${JSON.stringify(s.pages)}::jsonb, '[]'::jsonb)
        returning id`)) as Array<{ id: string }>;
      stepIds.set(s.status, row.id);
    }
    for (const m of template.moves) {
      await tx.execute(sql`
        insert into workflow_transitions (tenant_id, environment, flow_id, from_step_id, to_step_id,
                                          label_en, label_ar, requires_approval, allowed_roles,
                                          condition, priority, handoff, gates, auto_advance,
                                          auto_once, actions)
        values (${tenantId}::uuid, ${environment}, ${flow.id}::uuid, ${stepIds.get(m.from)!}::uuid,
                ${stepIds.get(m.to)!}::uuid, ${m.labelEn}, ${m.labelAr},
                -- No approvals, no gates, no actions and no automatic moves anywhere in the
                -- template. Each of those REFUSES or CAUSES something the product does not do
                -- today, and the template's whole claim is that turning it on changes nothing.
                false, '[]'::jsonb, '{}'::jsonb, 0, 'pool', '[]'::jsonb, false, true, '[]'::jsonb)`);
    }

    // The same gate the Activate button goes through. Reusing it rather than trusting the template
    // means a workspace can never be handed a flow that the authoring API would have refused.
    await this.workflows.assertActivatable(tx, flow.id, {
      is_default: true,
      selection_condition: {},
    });

    const retired = (await tx.execute(sql`
      update workflow_flows set status = 'retired'
      where tenant_id = ${tenantId}::uuid and environment = ${environment} and status = 'active'
        and (flow_key = ${template.flowKey} or (is_default and status_domain = ${template.statusDomain}))
      returning id, flow_key, version`)) as Array<{ id: string; flow_key: string; version: number }>;

    await tx.execute(sql`update workflow_flows set status = 'active' where id = ${flow.id}::uuid`);

    return {
      id: flow.id,
      version: next.v,
      retired: retired.map((r) => ({ id: r.id, flowKey: r.flow_key, version: r.version })),
    };
  }

  /**
   * Status CODE -> id, refusing loudly if the catalog has moved under the template.
   *
   * A missing code would otherwise insert a null status id and produce a step that matches no
   * record, which is the quietest possible way for a workflow to stop governing anything.
   */
  private async resolveCodes(tx: Tx, template: FlowTemplate): Promise<Map<string, string>> {
    const wanted = [...new Set(template.steps.map((s) => s.status))];
    const table = template.statusDomain === "item" ? sql`item_statuses` : sql`vendor_statuses`;
    const rows = (await tx.execute(sql`
      select id, code from ${table}
      where is_active and code in (${sql.join(wanted.map((c) => sql`${c}`), sql`, `)})`)) as Array<
      { id: string; code: string }
    >;
    const map = new Map(rows.map((r) => [r.code, r.id]));
    const missing = wanted.filter((c) => !map.has(c));
    if (missing.length)
      throw new BadRequestException(
        `the standard '${template.flowKey}' flow names ${template.statusDomain} status(es) this ` +
          `database does not have: ${missing.join(", ")}`,
      );
    return map;
  }
}
