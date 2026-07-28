import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext, type Tx } from "../../db/db.service.js";
import { envOf } from "../../common/env-guards.js";
import { AiService } from "../../common/ai.service.js";
import { StatusService, type StatusEntity } from "../../common/status.service.js";
import { ROUTABLE_PAGES, isPageKey, pageByKey } from "./pages.js";
import { GATES, gateByKey } from "./gates.js";
import { ACTIONS, actionByKey } from "./actions.js";
import { validateWebhookUrl } from "./webhook-url.js";
import {
  CONDITION_FIELDS, conditionFieldByKey, describeSelection, type Condition,
} from "./conditions.js";

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

/**
 * A condition on a transition: `{}` = always, otherwise clauses that must all hold (`all`) or of
 * which one must hold (`any`). Deliberately NOT nestable — a rule an admin cannot read back in one
 * sentence is a rule nobody trusts, and `describe()` has to be able to render it.
 */
const clauseSchema = z.object({
  field: z.string().max(64),
  op: z.enum(["eq", "ne", "gt", "lt", "in"]),
  value: z.unknown(),
});
const conditionSchema = z.object({
  all: z.array(clauseSchema).max(10).optional(),
  any: z.array(clauseSchema).max(10).optional(),
});

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
  /**
   * What happens after this move succeeds — see actions.ts and 0056.
   *
   * `ref` is the RECEIPT left behind when the configuration was taken from the action library
   * (0060): {id, name} of the entry it was copied from. It MUST be declared here or the whole
   * feature is dead on arrival — z.object strips keys it does not know, so an undeclared receipt is
   * deleted silently on the way in and every flow saves a copy that has forgotten where it came
   * from. Nothing follows it at run time; the copy beside it is what runs, which is what keeps an
   * active flow's behaviour frozen while the library stays editable.
   */
  actions: z
    .array(
      z.object({
        action: z.string().max(64),
        params: z.record(z.unknown()).optional().default({}),
        ref: z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) }).nullish(),
      }),
    )
    .optional()
    .default([])
    // A null receipt is dropped rather than stored: the DB CHECK reads `exists(@.ref)`, and a JSON
    // null exists while `@.ref.id` does not, so {"ref": null} would be refused by the database as a
    // half receipt. The canvas sending an explicitly-cleared field is an ordinary thing to happen.
    .transform((as) => as.map((a) => (a.ref ? a : { action: a.action, params: a.params }))),
  /**
   * THE CROSSING (0066) — taking this arrow also hands the record to another flow.
   *
   * DECLARED HERE OR THE FEATURE DOES NOT EXIST: `z.object` strips keys it does not know, so an
   * undeclared `toFlowKey` is deleted silently on the way in and every canvas save quietly wipes
   * every border in the flow. Same trap the action-library receipt above documents.
   *
   * A KEY, so the target may republish without this flow needing a new version. Nullish rather than
   * defaulted: an ordinary arrow has no target flow, and `null` is how the canvas clears one.
   */
  toFlowKey: z
    .string()
    .regex(/^[a-z0-9]+([-_][a-z0-9]+)*$/, "a flow key is lowercase words joined by - or _")
    .max(64)
    .nullish()
    .transform((v) => v ?? null),
  /** Fire this move by itself once its rules hold. Off by default — never inferred. */
  autoAdvance: z.boolean().optional().default(false),
  /** Fire automatically at most once per record, so a revisited status does not re-fire it. */
  autoOnce: z.boolean().optional().default(true),
  /** Exit gates from the code-defined catalog — see gates.ts and 0051. */
  gates: z
    .array(
      z.object({
        gate: z.string().max(64),
        params: z.record(z.unknown()).optional().default({}),
        enforcement: z.enum(["block", "warn_override"]).optional(),
      }),
    )
    .optional()
    .default([])
    .transform((gs) =>
      gs.map((g) => ({
        ...g,
        // fall back to the catalog's own opinion; the stored row must satisfy the DB CHECK
        enforcement: g.enforcement ?? gateByKey(g.gate)?.defaultEnforcement ?? "block",
      })),
    ),
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

/**
 * A LIBRARY ENTRY — a named, reusable configuration of one catalog action (QNEW-90 item 3).
 *
 * It holds no entity scoping of its own: which record types an action applies to belongs to the
 * catalog entry (ActionDef.entities), so an entry inherits the scope of whatever `action` it names
 * and the two can never drift apart.
 */
export const actionEntrySchema = z.object({
  nameEn: z.string().trim().min(2).max(120),
  nameAr: z.string().trim().min(2).max(120),
  action: z.string().min(1).max(64),
  params: z.record(z.unknown()).optional().default({}),
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
  /**
   * 'handoff' declares a SUB-FLOW: records only ever arrive here by crossing an arrow that names it,
   * never by being born into it (0066). It has to be settable at creation rather than inferred,
   * because "no selection condition" is exactly what an unfinished flow also looks like, and guessing
   * between the two is the difference between a flow that accepts nothing and one that accepts
   * everything.
   */
  entryMode: z.enum(["selected", "handoff"]).optional().default("selected"),
})
  /**
   * THE FALLBACK AND A HANDOFF FLOW ARE DIFFERENT ANSWERS TO THE SAME QUESTION, and holding both is
   * the bug that produced "sub-flow captures newborn records".
   *
   * The database permits the pair and the engine does not read it as a contradiction: selectableFlows
   * drops `entry_mode = 'handoff'` from the CANDIDATE list but reads the fallback off `is_default`
   * alone, so a flow claiming both is handed every record no condition matched — at birth, into a
   * rulebook whose terminals activation itself warns "stay in this workflow for good". Nothing
   * anywhere would report it, because each flag on its own is ordinary.
   *
   * Refused here rather than repaired later: this is the only endpoint that could ever set the pair.
   */
  .refine((d) => !(d.isDefault && d.entryMode === "handoff"), {
    message:
      "a handoff flow cannot also be the fallback — the fallback takes every record no other flow " +
      "claims, and a handoff flow takes only records another workflow hands to it. Pick one.",
    path: ["entryMode"],
  });

/**
 * HOW RECORDS GET INTO A FLOW — ONE choice, not three independent flags (QNEW-64).
 *
 * `is_default`, `selection_condition` and `entry_mode` are three columns answering ONE question, and
 * modelling them as three switches is what let two of them be set together. A discriminated union
 * makes the illegal combinations unrepresentable at the boundary rather than caught after the fact,
 * and it is the shape the screen renders directly: three radio buttons, one answer.
 *
 * DRAFT ONLY, and that is not a limitation this schema invented — `workflow_flow_freeze()` refuses
 * any change to selection_condition or selection_priority on a non-draft row, because routing decides
 * which rulebook a record picks up when it is born and an active flow whose routing could be edited
 * would re-aim live traffic with no version anywhere recording it. entry_mode and is_default are not
 * in that trigger's tuple, but they are the same decision, so they get the same rule.
 */
export const routingSchema = z.discriminatedUnion("mode", [
  /** The fallback: whatever no other flow claimed. Exactly one per domain — activate() enforces it. */
  z.object({ mode: z.literal("fallback") }),
  /** Chosen by matching the record's own facts, ahead of the fallback. */
  z.object({
    mode: z.literal("condition"),
    condition: conditionSchema,
    /** Only ever decides a tie between two flows that BOTH match. */
    priority: z.number().int().min(-1000).max(1000).optional().default(0),
  }),
  /** A sub-flow: records only ever arrive by an arrow in another flow naming this one. */
  z.object({ mode: z.literal("handoff") }),
]);

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
  /**
   * null = never auto-selected; {} = matches every record; {...} = a real condition.
   *
   * IT IS THE SAME SCHEMA THE ARROWS USE, and that is a change from `z.record(z.unknown())` (0065).
   * It had to be: this field is now EVALUATED at entry, and the loose record accepted shapes with a
   * runtime meaning nobody intended — `{"any": true}` is not a condition, but `any` is not an array
   * so isEmptyCondition() reads it as empty and the flow silently matches EVERY record. A flow that
   * looks conditional and captures everything is the exact failure the three-state column was
   * designed to prevent. z.object also strips undeclared keys, so a misspelt `alll` cannot ride
   * along as decoration either.
   */
  selectionCondition: conditionSchema.nullable().optional(),
  /**
   * Which flow wins when two conditions both match. Highest first, then oldest — the rule the
   * arrows already use. Optional because almost no workspace needs it: it only decides a tie.
   */
  selectionPriority: z.number().int().min(-1000).max(1000).optional(),
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
    /**
     * The break-glass return takes a real arrow through the real guard rather than writing a status
     * itself — see returnRecord(). Injected from the @Global StatusModule, so nothing has to be
     * wired into WorkflowModule for it.
     */
    private readonly status: StatusService,
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
        conditionFields: CONDITION_FIELDS.map((f) => ({
          key: f.key, labelEn: f.labelEn, labelAr: f.labelAr,
          type: f.type, options: f.options, entities: f.entities,
        })),
        actions: ACTIONS.map((a) => ({
          key: a.key, labelEn: a.labelEn, labelAr: a.labelAr, helpEn: a.helpEn,
          params: a.params, entities: a.entities,
        })),
        gates: GATES.map((g) => ({
          key: g.key, labelEn: g.labelEn, labelAr: g.labelAr, helpEn: g.helpEn,
          params: g.params, entities: g.entities, defaultEnforcement: g.defaultEnforcement,
        })),
        // The saved configurations sit BESIDE the code catalog rather than replacing it: one is what
        // the engine can do, the other is what this workspace has decided it usually wants done.
        actionLibrary: await this.libraryRows(tx, ctx),
        holders: Object.fromEntries(holders.map((h) => [h.code, h.n])),
      };
    });
  }

  // ── the action library (QNEW-90 item 3) ───────────────────────────────────
  //
  // WHY THESE LIVE ON THE PLATFORM-ONLY AUTHORING SURFACE. WorkflowController is @PlatformOnly() at
  // the door and every write below additionally demands super_admin, exactly like the flows — and
  // that is right, because a library entry is not a record a workspace works on, it is a piece of a
  // rule. It is copied verbatim into transitions whose semantics only a super admin may set, so
  // letting a workspace manager author entries would hand them the contents of a rule while the rule
  // itself stayed closed to them. The contrast is the run log, which is deliberately open to the
  // workspace's own manager (0059): they are the person who must ACT when an action fails. Nobody
  // acts on a library entry except whoever is building the flow.

  /**
   * Every entry in this workspace + environment, with how many flows carry a receipt for it.
   *
   * THE USAGE COUNT IS A jsonb CONTAINMENT TEST, and it counts DISTINCT flows rather than rows: an
   * entry used on four arrows of one flow is one flow to the person asking "what will I be looking
   * at if I change this". `t.actions @> [{"ref":{"id": …}}]` is true when SOME element of the array
   * contains that object — element-wise containment, which is why the surrounding action and params
   * of the copy do not have to match anything.
   *
   * The tenant and environment of workflow_transitions are filtered EXPLICITLY. RLS would not do it
   * here: the tenant policy ends in `OR app_is_internal()`, and every caller of this code is
   * platform staff by construction, so without these two predicates the count would silently span
   * every workspace on the box.
   */
  private async libraryRows(tx: Tx, ctx: RlsContext) {
    return (await tx.execute(sql`
      select e.id, e.name_en, e.name_ar, e.action, e.params, e.created_at, e.updated_at,
             (select count(distinct t.flow_id)::int
                from workflow_transitions t
               where t.tenant_id = e.tenant_id and t.environment = e.environment
                 and t.actions @> jsonb_build_array(
                       jsonb_build_object('ref', jsonb_build_object('id', e.id::text)))) as used_by_flows
      from workflow_actions e
      where e.tenant_id = ${ctx.tenantId}::uuid and e.environment = ${envOf(ctx)}
      order by lower(e.name_en)`)) as Array<Record<string, unknown>>;
  }

  async library(ctx: RlsContext) {
    const tenantId = this.requireTenant(ctx);
    const rows = await this.dbService.withContext(ctx, (tx) =>
      this.libraryRows(tx, { ...ctx, tenantId }),
    );
    return { count: rows.length, entries: rows };
  }

  /**
   * The key this workspace's webhook deliveries are signed with, and how to check one.
   *
   * WITHOUT THIS THE SIGNATURE WOULD BE THEATRE. Every delivery carries an HMAC, but a receiver can
   * only verify it if somebody can tell the receiver's author what the key is — and nothing else in
   * this system can read the column. An unverifiable signature is worse than none: it looks like
   * authentication on the screen and on the wire, and the receiving end ends up trusting the URL,
   * which is the exact thing the signature exists to stop being enough.
   *
   * IT IS A READ, AND IT IS STILL super_admin. `library()` above is readable by any platform staff
   * because a list of named configurations is not a credential; this is one, and handing it out is
   * handing out the ability to forge a call that another system will act on. There is deliberately
   * no rotation endpoint: rotation without a way to publish two valid keys at once is an outage for
   * every receiver at the moment it is pressed, and the honest version of that feature is bigger
   * than this ticket.
   *
   * THE SECRET IS MINTED IF THIS WORKSPACE HAS NEVER HAD ONE, by an INSERT that names only the
   * workspace and the environment — the value comes from the column default, which is the database's
   * own CSPRNG. Nothing in this API can supply one; see the header of migration 0064.
   */
  async webhookSecret(ctx: RlsContext & { platformRole?: string | null }) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    const environment = envOf(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into workflow_webhook_secrets (tenant_id, environment)
        values (${tenantId}::uuid, ${environment}::environment_type)
        on conflict (tenant_id, environment) do nothing`);
      const [row] = (await tx.execute(sql`
        select secret from workflow_webhook_secrets
        where tenant_id = ${tenantId}::uuid and environment = ${environment}::environment_type`)) as
        Array<{ secret: string }>;
      return {
        environment,
        secret: row?.secret ?? null,
        // Returned rather than left to documentation because the person calling this is, right
        // then, writing the code that has to verify it. The full scheme — including why the
        // timestamp is inside the signed message and why the comparison must be constant-time — is
        // in the header of migration 0064.
        scheme: {
          algorithm: "HMAC-SHA256",
          signedMessage: "<x-qvm-timestamp> + '.' + <raw request body>",
          headers: {
            "x-qvm-delivery": "delivery id — identical on every retry; de-duplicate on it",
            "x-qvm-timestamp": "unix seconds; reject anything more than a few minutes old",
            "x-qvm-signature": "v1=<hex hmac>",
          },
        },
      };
    });
  }

  /**
   * An unknown action key is refused HERE, at save time, for the same reason saveGraph refuses one:
   * a stored key the server cannot resolve is a rule that looks configured and logs "this server
   * does not know the action" every time a record crosses it. Refusing it in the library as well as
   * on the transition means a bad entry cannot be authored and then copied onto ten arrows before
   * anybody finds out.
   */
  private assertKnownAction(action: string) {
    if (!actionByKey(action))
      throw new BadRequestException(
        `'${action}' is not an action this server knows — use GET /admin/workflows/catalog`,
      );
  }

  async createLibraryEntry(
    ctx: RlsContext & { platformRole?: string | null },
    dto: z.infer<typeof actionEntrySchema>,
  ) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    this.assertKnownAction(dto.action);
    return this.dbService.withContext(ctx, async (tx) => {
      try {
        const [row] = (await tx.execute(sql`
          insert into workflow_actions (tenant_id, environment, name_en, name_ar, action, params)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${dto.nameEn}, ${dto.nameAr}, ${dto.action},
                  ${JSON.stringify(dto.params)}::jsonb)
          returning id, name_en, name_ar, action, params`)) as Array<Record<string, unknown>>;
        return { ...row, used_by_flows: 0 };
      } catch (e) {
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException(
            `there is already a saved action called '${dto.nameEn}' — pick another name, or edit that one`,
          );
        throw e;
      }
    });
  }

  /**
   * Edit an entry. THIS DOES NOT CHANGE ANY FLOW THAT ALREADY USES IT — a transition holds a copy,
   * and the copy is what runs (0060). The response says so in the same words the screen must, so a
   * caller that is not our own UI is told too rather than left to infer it.
   */
  async updateLibraryEntry(
    ctx: RlsContext & { platformRole?: string | null },
    entryId: string,
    dto: z.infer<typeof actionEntrySchema>,
  ) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    this.assertKnownAction(dto.action);
    return this.dbService.withContext(ctx, async (tx) => {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await tx.execute(sql`
          update workflow_actions
             set name_en = ${dto.nameEn}, name_ar = ${dto.nameAr}, action = ${dto.action},
                 params = ${JSON.stringify(dto.params)}::jsonb, updated_at = now()
           where id = ${entryId}::uuid and tenant_id = ${tenantId}::uuid
             and environment = ${envOf(ctx)}
          returning id, name_en, name_ar, action, params`)) as Array<Record<string, unknown>>;
      } catch (e) {
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException(
            `there is already a saved action called '${dto.nameEn}' — pick another name`,
          );
        throw e;
      }
      if (!rows.length) throw new NotFoundException("saved action not found in this workspace");
      const [used] = (await tx.execute(sql`
        select count(distinct flow_id)::int as n from workflow_transitions
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and actions @> jsonb_build_array(
                jsonb_build_object('ref', jsonb_build_object('id', ${entryId}::text)))`)) as Array<{ n: number }>;
      return {
        ...rows[0],
        used_by_flows: used?.n ?? 0,
        note:
          "Flows that already use this keep the copy they were built with — nothing they run has " +
          "changed. Open a draft to pull this version in.",
      };
    });
  }

  /**
   * Remove an entry from the library.
   *
   * DELIBERATELY NOT REFUSED WHEN IT IS IN USE, and that is what the name in the receipt buys. A
   * flow's copy keeps working untouched, and the builder goes on showing the name the entry had,
   * so nothing on screen becomes a bare uuid. Refusing instead would mean every retired flow ever
   * activated held the library open forever.
   */
  async removeLibraryEntry(ctx: RlsContext & { platformRole?: string | null }, entryId: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const r = await tx.execute(sql`
        delete from workflow_actions
        where id = ${entryId}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        returning id`);
      if (r.length === 0) throw new NotFoundException("saved action not found in this workspace");
      return {
        id: entryId,
        deleted: true,
        note: "Flows built from it are untouched — they run their own copy, under the name it had.",
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
               f.name_en as flow,
               -- WHERE THIS RECORD CAME FROM, when it is away in a sub-flow (0066).
               --
               -- The join above already names the flow correctly on its own, because a crossing
               -- rebinds rs.flow_id: an order handed to insurance reads "Insurance" here the moment
               -- it crosses. What it could not say is that the order is a VISITOR. Without this
               -- column a purchasing manager watching their queue sees the order leave with no
               -- explanation, and an insurance clerk sees an order arrive with no idea whose it is
               -- or where it goes back to. Left join, not inner: origin_flow_id is null for the
               -- overwhelming majority of records, which have never left home.
               of.name_en as origin_flow
        from workflow_record_state rs
        join workflow_flows f on f.id = rs.flow_id
        left join workflow_flows of on of.id = rs.origin_flow_id
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
   * BREAK GLASS: bring a record home from the sub-flow it is away in — 0066.
   *
   * WHY IT EXISTS. A crossing is refused, not half-done, so a record can never be stuck BETWEEN two
   * flows. What it can be is stuck INSIDE one: the way home is an arrow, and an arrow can only be
   * taken by somebody holding the role it allows. If the sub-flow's owners are all on leave, or the
   * one return arrow allows a role nobody in this workspace has any more, the record sits there and
   * no amount of correct engine behaviour moves it.
   *
   * WHY IT IS NOT A BACK DOOR, and this is the whole of its design: it does not write anything
   * itself. It finds the return arrow the author drew and takes it through StatusService like any
   * other move — same guard, same gates, same custody rule, ONE status_logs row, with a real
   * changed_by so the history says a named person did this. It therefore cannot produce a state an
   * ordinary return could not produce; what it changes is WHO may take that arrow, which is exactly
   * the thing that was stuck, and nothing else.
   *
   * It refuses when no arrow home is drawn from where the record stands. That refusal is not a
   * shortcoming — the alternative is a super admin dropping records onto statuses no author ever
   * connected, which is precisely the "a record somewhere nobody drew" failure this whole feature is
   * built to avoid. The fix for a missing way home is to draw one.
   */
  async returnRecord(
    ctx: RlsContext & { platformRole?: string | null },
    entity: string,
    id: string,
    toCode?: string,
  ) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const state = (await tx.execute(sql`
        select rs.flow_id, rs.origin_flow_id, rs.status_domain,
               home.flow_key as home_key, home.name_en as home_name,
               away.name_en as away_name
        from workflow_record_state rs
        left join workflow_flows home on home.id = rs.origin_flow_id
        left join workflow_flows away on away.id = rs.flow_id
        where rs.tenant_id = ${tenantId}::uuid and rs.environment = ${envOf(ctx)}
          and rs.entity_type = ${entity}::entity_type and rs.entity_id = ${id}::uuid
        limit 1`))[0] as
        | {
            flow_id: string | null; origin_flow_id: string | null; status_domain: "item" | "vendor";
            home_key: string | null; home_name: string | null; away_name: string | null;
          }
        | undefined;
      if (!state) throw new NotFoundException("this record is not being tracked by a workflow");
      if (!state.origin_flow_id || !state.home_key)
        throw new ConflictException(
          "this record is not away in another workflow, so there is nothing to bring it back from",
        );

      // Where it stands NOW decides which arrows are available — the same question the guard asks.
      const statusId = await this.status.currentStatusId(tx, entity as StatusEntity, id);
      if (!statusId) throw new ConflictException("this record has no status yet");

      const exits = (await tx.execute(sql`
        select coalesce(i.code, v.code) as code
        from workflow_transitions t
        join workflow_steps fs on fs.id = t.from_step_id
        join workflow_steps ts on ts.id = t.to_step_id
        left join item_statuses i on i.id = ts.item_status_id
        left join vendor_statuses v on v.id = ts.vendor_status_id
        where t.flow_id = ${state.flow_id}::uuid
          and coalesce(fs.item_status_id, fs.vendor_status_id) = ${statusId}::uuid
          and t.to_flow_key = ${state.home_key}
        order by t.priority desc, t.created_at asc`)) as Array<{ code: string }>;

      if (!exits.length)
        throw new ConflictException(
          `nothing hands this record back to '${state.home_name}' from where it currently stands in ` +
            `'${state.away_name}'. Draw a return arrow from this status, publish that workflow, and ` +
            `it can come home the ordinary way.`,
        );

      // MORE THAN ONE ENDING is the point of this design, so more than one way home is normal and
      // the choice is a business one — "did the claim settle or was it refused" is not something an
      // emergency lever gets to decide on the operator's behalf.
      const chosen = toCode ?? (exits.length === 1 ? exits[0].code : null);
      if (!chosen)
        throw new BadRequestException(
          `this record has more than one way back to '${state.home_name}' — say which one: ` +
            exits.map((e) => `'${e.code}'`).join(", "),
        );
      if (!exits.some((e) => e.code === chosen))
        throw new BadRequestException(
          `'${chosen}' is not a way back to '${state.home_name}' from where this record stands — ` +
            `the ones drawn are: ${exits.map((e) => `'${e.code}'`).join(", ")}`,
        );

      // The ordinary path, deliberately. ctx.userId is a real person, so the log row is attributable.
      await this.status.transition(
        tx,
        { tenantId, userId: ctx.userId, environment: ctx.environment },
        { entity: entity as StatusEntity, id, toCode: chosen },
      );
      return { entity, id, returnedTo: state.home_name, at: chosen };
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
  async pageView(ctx: RlsContext, flowId?: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const flows = (await tx.execute(sql`
        select f.id, f.name_en, f.name_ar, f.version, f.status, f.is_default, f.entry_mode,
               (select count(*)::int from workflow_steps s where s.flow_id = f.id) as steps
        from workflow_flows f
        where f.tenant_id = ${ctx.tenantId}::uuid and f.environment = ${envOf(ctx)}
          and f.status_domain = 'item'
        order by case f.status when 'active' then 0 when 'draft' then 1 else 2 end,
                 f.is_default desc, f.version desc`)) as Array<{
        id: string; name_en: string; name_ar: string; version: number; status: string;
        is_default: boolean; entry_mode: string; steps: number;
      }>;
      /**
       * WHICH FLOW IS THIS SCREEN ABOUT? An explicit ?flow=, else the workspace's own default.
       *
       * `flows.find(f => f.steps > 0) ?? flows[0]` was fine when a workspace had one flow and is not
       * fine now. The order above puts active-and-default first, so it happened to pick the right
       * one — but nothing said so, and a workspace whose default was mid-republish would have had
       * the Screens view silently describe a SUB-FLOW as if it were the whole engine: half the
       * statuses, and exits pointing at screens the other half never reaches. A screen that omits
       * half the engine is the same class of untruth as a run-log row that reads backwards.
       *
       * The `steps > 0` preference is kept as the last tie-break, for the reason it was added: an
       * empty stub next to a real flow makes the screen look broken.
       */
      const requested = flows.find((f) => f.id === flowId);
      const flow =
        requested ??
        flows.find((f) => f.status === "active" && f.is_default && f.steps > 0) ??
        flows.find((f) => f.status === "active" && f.is_default) ??
        flows.find((f) => f.steps > 0) ??
        flows[0];

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

  /**
   * All flows in the active workspace + environment.
   *
   * ORDERED THE WAY THE ENGINE ORDERS THEM within a domain — `selection_priority desc,
   * created_at asc` — rather than by key, because since 0065 a workspace can run several flows at
   * once and the first question about a list of them is "which one gets this order". Reading them in
   * the engine's own order is the answer; reading them alphabetically hides it. Filtering this list
   * down to the active flows of one domain therefore yields exactly the sequence bindOnEntry tries,
   * which is what the Workflows screen renders. Everything else — drafts, retired versions — falls
   * out oldest-first among them; `version desc` is only a tie-break for rows created in one
   * transaction.
   *
   * `selection_summary` is computed here rather than in the browser so there is ONE rendering of a
   * routing rule in the product. Its three states are not something a screen should be trusted to
   * get right: `null` and `{}` look almost identical and mean opposite things (see describeSelection).
   *
   * `entry_mode` IS SELECTED, and its absence was a defect rather than an omission. Without it this
   * method could not tell a live sub-flow from an unfinished draft, so the Workflows screen listed an
   * ACTIVE handoff flow among the conditional flows "checked before the fallback, in this order" —
   * a race it is not in — and printed "takes nothing — no routing set, so it is never chosen" beside
   * it. Two false statements about a flow doing exactly what it was configured to do.
   */
  async list(ctx: RlsContext) {
    const tenantId = this.requireTenant(ctx);
    const rows = (await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select f.id, f.flow_key, f.version, f.name_en, f.name_ar, f.status, f.is_default,
               f.entry_mode, f.status_domain, f.selection_condition, f.selection_priority,
               f.created_at, f.updated_at,
               (select count(*)::int from workflow_steps s where s.flow_id = f.id) as steps,
               (select count(*)::int from workflow_transitions t where t.flow_id = f.id) as transitions,
               (select count(*)::int from workflow_record_state r where r.flow_id = f.id) as records,
               -- WILL PUBLISHING THIS DRAFT MAKE IT THE FALLBACK ANYWAY? activate() hands the flag
               -- over from the predecessor it retires (see the note there), so v2 of the workspace's
               -- fallback goes live as the fallback even though the clone carries is_default = false.
               -- A screen that read only is_default would offer a routing choice this flow does not
               -- have, which is the same class of untruth as the two lines above.
               exists (select 1 from workflow_flows p
                        where p.tenant_id = f.tenant_id and p.environment = f.environment
                          and p.flow_key = f.flow_key and p.status = 'active' and p.is_default
                          and p.id <> f.id) as inherits_default,
               -- DOES ANYTHING ACTUALLY HAND WORK HERE? A handoff flow is reached only by being
               -- crossed into, and publishing one that nothing names is allowed — no check refuses
               -- it, because a pair is legitimately published one at a time. But the screen then
               -- listed it as though work arrived, which is the mirror image of the bug this whole
               -- change fixed: a live workflow no record can ever enter, presented as working.
               (select count(*) from workflow_transitions t
                 join workflow_flows src on src.id = t.flow_id and src.status = 'active'
                where t.to_flow_key = f.flow_key and src.id <> f.id
                  and src.tenant_id = f.tenant_id and src.environment = f.environment
                  and src.status_domain = f.status_domain)::int as handed_by_flows
        from workflow_flows f
        where f.tenant_id = ${tenantId}::uuid and f.environment = ${envOf(ctx)}
        order by f.status_domain, f.selection_priority desc, f.created_at asc, f.version desc`),
    )) as Array<Record<string, unknown>>;
    return {
      count: rows.length,
      flows: rows.map((f) => ({
        ...f,
        selection_summary: describeSelection(
          f.is_default as boolean,
          f.selection_condition as Condition | null,
          f.entry_mode as string | null,
        ),
      })),
    };
  }

  /** One flow with its full graph — the canvas payload, and what the AI is shown as "current". */
  async get(ctx: RlsContext, id: string) {
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      // entry_mode and inherits_default ride along for the same reason list() carries them: the
      // canvas is where routing is now CHOSEN, and a picker that cannot see the current answer would
      // either show the wrong one or silently reset it. See list() for what inherits_default means.
      const flow = (await tx.execute(sql`
        select f.id, f.flow_key, f.version, f.name_en, f.name_ar, f.status, f.is_default,
               f.entry_mode, f.status_domain, f.selection_condition, f.selection_priority,
               f.canvas, f.created_at, f.updated_at,
               exists (select 1 from workflow_flows p
                        where p.tenant_id = f.tenant_id and p.environment = f.environment
                          and p.flow_key = f.flow_key and p.status = 'active' and p.is_default
                          and p.id <> f.id) as inherits_default
        from workflow_flows f
        where f.id = ${id}::uuid and f.tenant_id = ${tenantId}::uuid and f.environment = ${envOf(ctx)}
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
               t.handoff, t.gates, t.auto_advance, t.auto_once, t.actions, t.to_flow_key
        from workflow_transitions t
        join workflow_steps fs on fs.id = t.from_step_id
        join workflow_steps ts on ts.id = t.to_step_id
        left join item_statuses fi on fi.id = fs.item_status_id
        left join vendor_statuses fv on fv.id = fs.vendor_status_id
        left join item_statuses ti on ti.id = ts.item_status_id
        left join vendor_statuses tv on tv.id = ts.vendor_status_id
        where t.flow_id = ${id}::uuid
        order by t.priority, t.created_at`);

      // The same sentence list() returns, from the same renderer. The canvas is where routing is
      // chosen, so it is the screen that most needs to read back what is actually stored — and a
      // second rendering in the browser is how a screen and the engine start disagreeing about
      // what `null` and `{}` mean.
      return {
        ...flow,
        selection_summary: describeSelection(
          flow.is_default as boolean,
          flow.selection_condition as Condition | null,
          flow.entry_mode as string | null,
        ),
        steps,
        transitions,
      };
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
                                    status_domain, is_default, entry_mode)
        values (${tenantId}::uuid, ${envOf(ctx)}, ${dto.flowKey}, ${next.v}, ${dto.nameEn}, ${dto.nameAr},
                ${dto.statusDomain}, ${dto.isDefault}, ${dto.entryMode})
        returning id, version`)) as Array<{ id: string; version: number }>;
      return { id: row.id, flowKey: dto.flowKey, version: row.version, status: "draft", entryMode: dto.entryMode };
    });
  }

  /**
   * HOW RECORDS GET INTO THIS FLOW — the answer, changed after creation.
   *
   * WHY THIS ENDPOINT HAD TO EXIST. `is_default` and `entry_mode` were settable ONLY at creation and
   * `selection_condition` only as a field of the whole-graph save the canvas does not send. So a
   * second flow drawn in the product had no condition, no priority, no entry mode and was not the
   * default — and activate() refuses exactly that flow, telling the admin to do one of three things
   * the product gave them no way to do. Every multi-flow feature underneath (the crossing, the
   * handoff, My Work's "from X") was unreachable behind that one gap.
   *
   * ONE CHOICE, NOT THREE FLAGS — see routingSchema. The union is the point: two of these set
   * together is what produced "sub-flow captures newborn records", and a shape that cannot express
   * the pair cannot store it.
   *
   * DRAFT ONLY. `workflow_flow_freeze()` already refuses selection_condition and selection_priority
   * on a non-draft row, so two thirds of this write would be rejected by the database anyway; the
   * other third is the same decision and gets the same rule rather than a quieter one. The screen
   * says so instead of offering a control that throws.
   */
  async updateRouting(
    ctx: RlsContext & { platformRole?: string | null },
    id: string,
    dto: z.infer<typeof routingSchema>,
  ) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      const flow = (await tx.execute(sql`
        select f.id, f.flow_key, f.status, f.status_domain,
               exists (select 1 from workflow_flows p
                        where p.tenant_id = f.tenant_id and p.environment = f.environment
                          and p.flow_key = f.flow_key and p.status = 'active' and p.is_default
                          and p.id <> f.id) as inherits_default
        from workflow_flows f
        where f.id = ${id}::uuid and f.tenant_id = ${tenantId}::uuid and f.environment = ${envOf(ctx)}
        limit 1`))[0] as
        | { id: string; flow_key: string; status: string; status_domain: string; inherits_default: boolean }
        | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");
      if (flow.status !== "draft")
        throw new ConflictException(
          `this flow is ${flow.status} — records are executing it, and routing decides which rulebook ` +
            `a record picks up. Create a new version to change it.`,
        );

      /**
       * A NEW VERSION OF THE FALLBACK IS STILL THE FALLBACK, and pretending otherwise would store a
       * choice activation then overrules. activate() hands `is_default` over from the predecessor it
       * retires — without that, publishing v2 of the workspace's own flow left the workspace with no
       * fallback at all and every record raised afterwards moved unchecked. So a draft in that
       * position cannot be made a handoff or a conditional flow: the flag would come back at
       * publish, and `is_default` + `entry_mode = 'handoff'` is the very pair this union exists to
       * prevent. Retiring the live fallback, or giving another flow the flag first, is the way.
       */
      if (flow.inherits_default && dto.mode !== "fallback")
        throw new ConflictException(
          `this is a new version of the workflow that is currently the fallback, so publishing it ` +
            `makes it the fallback again — that is what stops the workspace being left without one. ` +
            `Give another workflow the fallback first, or retire the live version, and then come back.`,
        );

      if (dto.mode === "condition") {
        // `{}` IS "EVERY RECORD" IN THIS CODEBASE, and offering it from a condition picker is how a
        // flow that looks conditional quietly captures everything — the exact failure the
        // three-state column was designed to prevent. The honest way to say "every record" is to be
        // the fallback, which is the choice next to this one.
        if (!dto.condition.all?.length && !dto.condition.any?.length)
          throw new BadRequestException(
            "a condition needs at least one test, or it matches every record — which is what the " +
              "fallback is for. Add a test, or make this the fallback instead.",
          );
        // Same catalog check saveGraph runs, for the same reason: an unknown field fails CLOSED at
        // run time, so the flow would simply never be chosen — silently, weeks later, with every
        // record going to the fallback and nothing anywhere saying why.
        const bad = [...(dto.condition.all ?? []), ...(dto.condition.any ?? [])]
          .map((c) => c.field)
          .filter((k) => !conditionFieldByKey(k));
        if (bad.length)
          throw new BadRequestException(
            `this flow would be selected on unknown field(s): ${[...new Set(bad)].join(", ")}`,
          );
      }

      const isDefault = dto.mode === "fallback";
      const entryMode = dto.mode === "handoff" ? "handoff" : "selected";
      /**
       * The condition is REPLACED by the other two answers rather than left where it was. A stored
       * condition the engine never consults is dead data that reads as a live rule on every screen
       * rendering the column, and the first person to clear is_default would inherit a routing rule
       * nobody chose.
       *
       * THE FALLBACK STORES `{}`, NOT NULL, and that is the same choice template.service.ts makes
       * about the provisioned flow for the same reason. Null would be tidier and it breaks the one
       * path a fallback is most often taken down: newVersion() clones with `is_default = false`
       * (two active defaults is a unique-index violation while the predecessor is still live), so
       * the clone would carry no default flag AND no condition — and assertActivatable refuses
       * exactly that as "routing is not set", before ever reaching the handover that would have
       * given the flag back. Publishing v2 of the workspace's own fallback would be refused outright.
       * `{}` reads as "matches every record", which is inert on a flow the engine consults by flag
       * rather than by condition, and survives the clone.
       */
      const condition = dto.mode === "handoff" ? null : JSON.stringify(dto.mode === "condition" ? dto.condition : {});
      const priority = dto.mode === "condition" ? dto.priority : 0;

      await tx.execute(sql`
        update workflow_flows
           set is_default = ${isDefault}, entry_mode = ${entryMode},
               selection_condition = ${condition === null ? sql`null` : sql`${condition}::jsonb`},
               selection_priority = ${priority}, updated_at = now()
         where id = ${id}::uuid`);

      // WHO ELSE WANTS THIS SLOT. Only ONE active flow per domain may be the fallback, and the
      // refusal lives at activation — which is a long way from the moment the choice is made. Naming
      // the holder here lets the screen say it while the admin can still pick something else.
      const holder =
        isDefault
          ? ((await tx.execute(sql`
              select name_en, version from workflow_flows
              where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
                and status_domain = ${flow.status_domain}::status_domain and status = 'active'
                and is_default and flow_key <> ${flow.flow_key}
              limit 1`))[0] as { name_en: string; version: number } | undefined)
          : undefined;

      return {
        id,
        mode: dto.mode,
        isDefault,
        entryMode,
        selectionPriority: priority,
        // `z.unknown()` on a clause's value infers it as OPTIONAL, which Condition does not — the
        // same cast list() makes when handing a jsonb column to the one renderer of a routing rule.
        selectionSummary: describeSelection(
          isDefault,
          dto.mode === "condition" ? (dto.condition as Condition) : null,
          entryMode,
        ),
        fallbackHeldBy: holder ? `${holder.name_en} (v${holder.version})` : null,
      };
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
        select id, flow_key, status, status_domain from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as
        { id: string; flow_key: string; status: string; status_domain: "item" | "vendor" } | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");
      if (flow.status !== "draft")
        throw new ConflictException(
          `this flow is ${flow.status} — records are executing it. Create a new version to change it.`,
        );

      const codeToId = await this.resolveStatusCodes(tx, flow.status_domain, dto);
      this.validateGraph(dto, flow.flow_key);

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
                                            condition, priority, handoff, gates, auto_advance, auto_once,
                                            actions, to_flow_key)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${id}::uuid, ${stepIds.get(t.from)!}::uuid,
                  ${stepIds.get(t.to)!}::uuid, ${t.labelEn ?? null}, ${t.labelAr ?? null},
                  ${t.requiresApproval}, ${JSON.stringify(t.allowedRoles)}::jsonb,
                  ${JSON.stringify(t.condition)}::jsonb, ${t.priority}, ${t.handoff},
                  ${JSON.stringify(t.gates)}::jsonb, ${t.autoAdvance}, ${t.autoOnce},
                  ${JSON.stringify(t.actions)}::jsonb, ${t.toFlowKey})`);
      }

      await tx.execute(sql`
        update workflow_flows set
          name_en = coalesce(${dto.nameEn ?? null}, name_en),
          name_ar = coalesce(${dto.nameAr ?? null}, name_ar),
          selection_condition = ${dto.selectionCondition === undefined ? sql`selection_condition` : dto.selectionCondition === null ? sql`null` : sql`${JSON.stringify(dto.selectionCondition)}::jsonb`},
          -- omitted keeps what is stored, exactly like selection_condition above: the canvas does
          -- not send this field and must not reset the routing order of a flow every time somebody
          -- drags a step.
          selection_priority = ${dto.selectionPriority === undefined ? sql`selection_priority` : sql`${dto.selectionPriority}`},
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
        select id, flow_key, status, status_domain, is_default, selection_condition, entry_mode
        from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as
        | {
            id: string; flow_key: string; status: string; status_domain: "item" | "vendor";
            is_default: boolean; selection_condition: unknown; entry_mode: string;
          }
        | undefined;
      if (!flow) throw new NotFoundException("flow not found in this workspace");
      if (flow.status !== "draft") throw new ConflictException(`flow is already ${flow.status}`);

      const warnings = await this.assertActivatable(tx, id, flow);

      // ── TWO ACTIVE FLOWS: FINE. TWO DEFAULTS: NOT ──────────────────────────────────────────────
      //
      // Since 0065 a workspace legitimately runs several flows in one domain — an insurance flow
      // beside a cash flow — and nothing here or in the schema stops that: the only uniqueness the
      // database enforces is one active version per flow_key, and one active DEFAULT per domain.
      //
      // That second index is what this check is for. It already refused two defaults, but as a
      // constraint violation from inside a transaction: a 500 reading `duplicate key value violates
      // unique constraint "workflow_flows_default_uq"`, to a person whose actual mistake was leaving
      // "make this the fallback" ticked on their second flow. The refusal is the same, said in
      // words, and it names the flow already holding the slot so the reader knows what to do next.
      //
      // Not raised when the collision is with the SAME flow_key: that is the ordinary version
      // handover, and the statement below retires the predecessor a line later.
      if (flow.is_default) {
        const holder = (await tx.execute(sql`
          select name_en, version from workflow_flows
          where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
            and status_domain = ${flow.status_domain} and status = 'active' and is_default
            and flow_key <> ${flow.flow_key}
          limit 1`))[0] as { name_en: string; version: number } | undefined;
        if (holder)
          throw new ConflictException(
            `'${holder.name_en}' (v${holder.version}) is already the fallback flow for this kind of ` +
              `record, and there can only be one — a record that matches no condition has to have ` +
              `exactly one answer. Give this flow a selection condition instead, or retire that one.`,
          );
      }

      // retire the predecessor FIRST — the partial unique index permits only one active version and
      // is not deferrable, so the other order fails.
      //
      // Read the predecessor BEFORE retiring it: RETURNING reports the row as it now is, and the
      // whole point of the read is the value that is about to be overwritten.
      const predecessor = (await tx.execute(sql`
        select is_default from workflow_flows
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and flow_key = ${flow.flow_key} and status = 'active'`)) as Array<{ is_default: boolean }>;

      // `is_default = false` on the way out, so the flag means one thing: THE flow currently serving
      // as this domain's fallback. The partial index only counts active rows, so a retired row could
      // keep it without breaking anything — and then two rows claim the same job, one of them a
      // version nothing has executed since last month, and every screen listing flows has to decide
      // which claim to believe.
      await tx.execute(sql`
        update workflow_flows set status = 'retired', is_default = false
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and flow_key = ${flow.flow_key} and status = 'active'`);

      // ── THE FALLBACK SURVIVES ITS OWN VERSIONING ──────────────────────────────────────────────
      //
      // newVersion() forces `is_default = false` on the clone, because two ACTIVE defaults is a
      // unique-index violation and the clone is created while its predecessor is still live. The
      // flag therefore has to be handed over here, at the moment the predecessor stops being active
      // — and it was not: publishing v2 of the workspace's own flow left v2 live and the workspace
      // with NO default at all, so every record raised afterwards matched no flow, bound to nothing,
      // and moved unchecked. Enforcement switched itself off, silently, on the supported edit path.
      //
      // The order below is what makes this safe: the predecessor is already retired by the statement
      // above, so `workflow_flows_default_uq` (which counts only active rows) sees exactly one
      // default at every point.
      const inheritsDefault = predecessor.some((r) => r.is_default);
      await tx.execute(sql`
        update workflow_flows set status = 'active', is_default = ${flow.is_default || inheritsDefault}
        where id = ${id}::uuid`);
      return { id, status: "active", warnings };
    });
  }

  async retire(ctx: RlsContext & { platformRole?: string | null }, id: string) {
    this.requireSuperAdmin(ctx);
    const tenantId = this.requireTenant(ctx);
    return this.dbService.withContext(ctx, async (tx) => {
      /**
       * RETIRING A FLOW SOMETHING CROSSES INTO IS HOW A BORDER BECOMES A DEAD END — 0066.
       *
       * This method was a bare UPDATE with no checks at all, which was defensible while a flow stood
       * alone: retiring it stopped new records binding to it and the records already inside kept
       * executing the version they entered. It is not defensible once another ACTIVE flow names this
       * one as a destination. That arrow resolves by key to whatever is active, so retiring the only
       * active version turns a drawn, validated border into a refusal every record hits.
       *
       * A VERSION BUMP IS NOT AFFECTED and that is the point of checking here rather than in the
       * trigger: activate() retires the predecessor inside its own transaction, having already
       * activated the successor moments later under the same key, so the key never stops resolving.
       * The standalone Retire button is the only path that can leave nothing behind.
       *
       * RETIRED VERSIONS COUNT TOO, for the same reason they do in assertCrossingsResolve: a record
       * executes the version it was bound to, so a retired parent still carrying live records still
       * hands them across this border. `f.status = 'active'` could not see them, and retiring the
       * destination turned their one remaining move into a run-time refusal — the clerk holding the
       * order finds out, the admin who pressed Retire does not.
       *
       * "STILL BEING EXECUTED" IS NOT "HAS EVER HELD A RECORD". workflow_record_state is upserted on
       * every move and never deleted, so a record that finished months ago keeps its row pointing at
       * the version it ended on. Testing for the row alone made this refusal UNSATISFIABLE: one
       * long-finished order permanently blocked retiring the sub-flow, under a message telling the
       * admin to republish a flow they had already republished. The step the record is standing on
       * has to be consulted — a record on a terminal step is not going anywhere, least of all across
       * a border.
       */
      const crossers = (await tx.execute(sql`
        select distinct f.name_en, f.version, f.status::text as status from workflow_transitions t
        join workflow_flows f on f.id = t.flow_id
         and (f.status = 'active'
              or exists (
                select 1 from workflow_record_state rs
                -- The record's CURRENT status lives on its own table, so resolving it is
                -- polymorphic. Anything this join cannot resolve falls through as live, which is
                -- the safe direction: refusing a retire is recoverable, stranding a record is not.
                left join rfqs        rq on rs.entity_type = 'rfq'        and rq.id = rs.entity_id
                left join rfq_items   ri on rs.entity_type = 'rfq_item'   and ri.id = rs.entity_id
                left join orders      oo on rs.entity_type = 'order'      and oo.id = rs.entity_id
                left join order_items oi on rs.entity_type = 'order_item' and oi.id = rs.entity_id
                left join workflow_steps st on st.flow_id = f.id
                  and st.item_status_id = coalesce(rq.status_id, ri.status_id, oo.status_id, oi.status_id)
                where rs.flow_id = f.id
                  and (st.id is null or not st.is_terminal)))
        join workflow_flows me on me.id = ${id}::uuid
        where t.to_flow_key = me.flow_key and f.id <> me.id
          and f.tenant_id = me.tenant_id and f.environment = me.environment
          and f.status_domain = me.status_domain`)) as Array<
        { name_en: string; version: number; status: string }
      >;
      if (crossers.length)
        throw new ConflictException(
          `${crossers
            .map(
              (c) =>
                `'${c.name_en}' (v${c.version}${c.status === "active" ? "" : `, ${c.status}, records still moving in it`})`,
            )
            .join(", ")} hands records to this ` +
            `workflow, so retiring it would leave that move with nowhere to go. Retire or republish ` +
            `${crossers.length > 1 ? "those workflows" : "that workflow"} first.`,
        );

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
      //
      // selection_priority IS copied, beside the condition it orders. The two are one decision —
      // "this flow takes insurance work, ahead of the pickup flow" — and a clone that kept the
      // condition but reset the order would republish a flow that routes differently from the
      // version it was cloned from, which is the last thing somebody publishing v2 of a live flow is
      // expecting.
      //
      // entry_mode IS COPIED, and it is not optional. A sub-flow has no selection condition because
      // nothing selects it; a clone that reset to 'selected' would fail activation with "routing is
      // not set" — and the only ways out of that are to invent a condition for a flow nothing
      // selects, or to make it the default. Publishing v2 of a working sub-flow must not present
      // that choice.
      const [copy] = (await tx.execute(sql`
        insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
                                    status_domain, is_default, selection_condition, selection_priority,
                                    entry_mode, canvas)
        values (${tenantId}::uuid, ${envOf(ctx)}, ${src.flow_key as string}, ${next.v},
                ${src.name_en as string}, ${src.name_ar as string}, ${src.status_domain as string},
                false, ${src.selection_condition === null ? sql`null` : sql`${JSON.stringify(src.selection_condition)}::jsonb`},
                ${(src.selection_priority as number) ?? 0},
                ${(src.entry_mode as string) ?? "selected"},
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
      // `actions` is copied as a whole jsonb value, so a library receipt on an element rides along
      // into the new draft. It has to: the draft is where "this copy has drifted from the saved
      // action, update it" is offered, and an entry the clone forgot could never be offered again.
      //
      // `to_flow_key` is copied for a reason worth naming: a version that forgot it would silently
      // UN-CONFIGURE every border in the flow on the next publish. The graph would still look right
      // on the canvas — the arrow is still there — and records would simply stop being handed to the
      // sub-flow, with nothing anywhere reporting a change.
      const trs = (await tx.execute(sql`
        select from_step_id, to_step_id, label_en, label_ar, requires_approval, allowed_roles,
               condition, priority, handoff, gates, auto_advance, auto_once, actions, to_flow_key
        from workflow_transitions where flow_id = ${id}::uuid`)) as Array<Record<string, unknown>>;
      for (const t of trs) {
        await tx.execute(sql`
          insert into workflow_transitions (tenant_id, environment, flow_id, from_step_id, to_step_id,
                                            label_en, label_ar, requires_approval, allowed_roles,
                                            condition, priority, handoff, gates, auto_advance, auto_once,
                                            actions, to_flow_key)
          values (${tenantId}::uuid, ${envOf(ctx)}, ${copy.id}::uuid,
                  ${map.get(t.from_step_id as string)!}::uuid, ${map.get(t.to_step_id as string)!}::uuid,
                  ${(t.label_en as string) ?? null}, ${(t.label_ar as string) ?? null},
                  ${t.requires_approval as boolean}, ${JSON.stringify(t.allowed_roles)}::jsonb,
                  ${JSON.stringify(t.condition)}::jsonb, ${t.priority as number},
                  ${(t.handoff as string) ?? 'pool'}, ${JSON.stringify(t.gates ?? [])}::jsonb,
                  ${(t.auto_advance as boolean) ?? false}, ${(t.auto_once as boolean) ?? true},
                  ${JSON.stringify(t.actions ?? [])}::jsonb, ${(t.to_flow_key as string) ?? null})`);
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

    const { flow, catalog, roles, holders, crossable } = await this.dbService.withContext(ctx, async (tx) => {
      const f = (await tx.execute(sql`
        select id, flow_key, name_en, status, status_domain from workflow_flows
        where id = ${id}::uuid and tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
        limit 1`))[0] as
        { id: string; flow_key: string; name_en: string; status: string; status_domain: "item" | "vendor" } | undefined;
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
      /**
       * The flows this one may hand a record to — 0066, and the reason `toFlowKey` IS offered to
       * the model where the action-library receipt deliberately is not.
       *
       * A receipt names a library row by uuid and the model is shown no uuids, so the only thing it
       * could do is invent one. A flow key is different in kind: these are the real, active,
       * same-domain keys of this workspace, listed below by name, so the model is CHOOSING from a
       * closed set rather than making something up. Its own flow is excluded — a border into itself
       * is refused by validateGraph anyway, and offering it would invite the model to draw one.
       */
      const cross = (await tx.execute(sql`
        select flow_key, name_en from workflow_flows
        where tenant_id = ${tenantId}::uuid and environment = ${envOf(ctx)}
          and status_domain = ${f.status_domain} and status = 'active' and flow_key <> ${f.flow_key}
        order by flow_key`)) as Array<{ flow_key: string; name_en: string }>;
      return {
        flow: f,
        catalog: cat,
        roles: r.map((x) => x.code),
        holders: Object.fromEntries(h.map((x) => [x.code, x.n])) as Record<string, number>,
        crossable: cross,
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
      "",
      ...(crossable.length
        ? [
            "12. `toFlowKey` on a transition HANDS THE RECORD TO ANOTHER WORKFLOW as it makes the move.",
            "    Use it ONLY when the admin describes work leaving this process for a different one",
            "    (\"send it to the insurance flow\", \"then the returns process takes over\"). The",
            "    destination status must be a step in BOTH this flow and the named one — draw it here",
            "    too. Leave it out for every ordinary move; almost every arrow is ordinary.",
            "    Pick ONLY from these keys — never invent one:",
            ...crossable.map((c) => `      ${c.flow_key} — ${c.name_en}`),
          ]
        : []),
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
        // THE FIFTH PLACE OF THE FIVE-PLACE RULE, answered by omission. Neither `actions` nor the
        // library receipt on one is offered to the model: a receipt names a row by uuid, the model
        // is shown no uuids, and the only thing it could do is invent one. That would put an entry
        // name on the canvas that no library screen can find and that the usage count would never
        // report. Anything a future model emits anyway is stripped below rather than trusted.
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
              // Offered, unlike the action-library receipt above, because the model is choosing from
              // the closed list of real flow keys printed in the system prompt rather than inventing
              // an identifier. An `enum` pins it further: with no other flow in the workspace the
              // property is omitted entirely, so the model cannot propose a crossing to nowhere.
              ...(crossable.length
                ? {
                    toFlowKey: {
                      type: "string",
                      enum: crossable.map((c) => c.flow_key),
                      description:
                        "hand the record to this OTHER workflow as part of this move; omit for an ordinary move",
                    },
                  }
                : {}),

              // EVERYTHING ELSE THE ARROW CARRIES, for the same reason toFlowKey is here: the
              // assistant REPLACES the graph, and zod defaults any field the model does not send —
              // condition to {}, gates to [], autoAdvance to false, autoOnce to true. So an admin
              // who wrote "only when the payer is insurance" on an arrow, or made a move automatic,
              // and then asked the assistant to add a step, silently lost it. 0066 closed exactly
              // this hole for crossings and said why: "asking the assistant to adjust anything would
              // have it propose a graph in which every crossing had quietly vanished." The same
              // sentence is true of every one of these, and the model is shown all of them in the
              // current graph, so carrying them back is a matter of letting it.
              //
              // `actions` stays out, deliberately and unlike the rest: an action carries params the
              // model would be inventing rather than echoing, and a library receipt names a row by
              // uuid. It is the one field the assistant may not author, which is why saveGraph
              // preserves it separately rather than trusting a round trip.
              condition: {
                type: "object",
                description:
                  "when this move is allowed, echoed back UNCHANGED from the current graph unless " +
                  "the admin asked to change it. Omitting it clears it.",
              },
              gates: {
                type: "array",
                items: { type: "object" },
                description: "rules that must hold first; echo back unchanged unless asked to change",
              },
              autoAdvance: {
                type: "boolean",
                description: "does this move happen by itself; echo back unchanged unless asked",
              },
              autoOnce: {
                type: "boolean",
                description: "if automatic, at most once per record; echo back unchanged unless asked",
              },
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

    // A receipt the model produced points at nothing, so it is removed before the proposal is drawn.
    // Being forgiving of the model and strict about the RESULT is the same split used for parallel
    // arrows below: the human reviews what lands on the canvas either way, and what lands must not
    // claim to have come out of a library it never read.
    for (const t of parsed.data.transitions)
      t.actions = t.actions.map((a) => ({ action: a.action, params: a.params }));

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

    this.validateGraph(parsed.data, flow.flow_key);
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
  private validateGraph(dto: SaveGraphDto, flowKey?: string) {
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
      // A BORDER INTO YOURSELF IS NOT A BORDER — 0066. The check above already forces `to` to be a
      // step in THIS flow, which is exactly what makes a crossing work: the destination status is a
      // shared node, present in both graphs. Aiming that at this same flow describes an ordinary
      // move while claiming to be a handoff, and at run time it would resolve back to the flow the
      // record is already on, write origin_flow_id pointing at itself, and make the record look
      // permanently away in a sub-flow it never left.
      if (flowKey && t.toFlowKey === flowKey)
        errs.push(
          `'${t.from}' → '${t.to}' hands the record to '${flowKey}', which is this flow — ` +
            `clear the destination workflow to make it an ordinary move`,
        );
    }
    const dup = new Set<string>();
    for (const t of dto.transitions) {
      const k = `${t.from}→${t.to}#${t.priority}`;
      if (dup.has(k)) errs.push(`two transitions '${t.from}' → '${t.to}' share priority ${t.priority}`);
      dup.add(k);
    }
    if (errs.length) throw new BadRequestException(errs.join("; "));

    // The flow's OWN condition is checked against the same catalog as the arrows', because since
    // 0065 it is evaluated the same way. An unknown field fails closed at run time (conditions.ts
    // test()), so the flow would simply never be chosen — silently, weeks later, with every record
    // going to the default and nothing anywhere saying why. Refusing the save is the moment somebody
    // can still fix the typo.
    if (dto.selectionCondition) {
      const badSelection = [
        ...(dto.selectionCondition.all ?? []),
        ...(dto.selectionCondition.any ?? []),
      ]
        .map((c) => c.field)
        .filter((k) => !conditionFieldByKey(k));
      if (badSelection.length)
        throw new BadRequestException(
          `this flow is selected on unknown field(s): ${[...new Set(badSelection)].join(", ")}`,
        );
    }

    for (const t of dto.transitions) {
      const badFields = [...(t.condition.all ?? []), ...(t.condition.any ?? [])]
        .map((c) => c.field)
        .filter((k) => !conditionFieldByKey(k));
      if (badFields.length)
        throw new BadRequestException(
          `'${t.from}' → '${t.to}' tests unknown field(s): ${[...new Set(badFields)].join(", ")}`,
        );

      const badActions = t.actions.filter((a) => !actionByKey(a.action)).map((a) => a.action);
      if (badActions.length)
        throw new BadRequestException(
          `'${t.from}' → '${t.to}' uses unknown action(s): ${[...new Set(badActions)].join(", ")}`,
        );

      // A webhook destination is refused HERE as well as at run time, for the same reason the line
      // above refuses an unknown action key: the run-time guard makes the address SAFE — nothing is
      // ever queued or sent to it — but it does so silently, weeks later, in a run log nobody is
      // watching. An admin who types a private address gets no error, saves, activates, and learns
      // about it when an order crosses the arrow. Two gates for two different failures: this one
      // stops a mistake being authored, the run-time one stops a name that resolves somewhere else
      // by the time we dial it.
      for (const a of t.actions) {
        if (a.action !== "webhook") continue;
        const verdict = validateWebhookUrl(String((a.params as Record<string, unknown>)?.url ?? ""));
        if (!verdict.ok)
          throw new BadRequestException(
            `'${t.from}' → '${t.to}' sends a webhook to a destination this server will refuse: ${verdict.reason}`,
          );
      }

      const unknown = t.gates.filter((g) => !gateByKey(g.gate)).map((g) => g.gate);
      if (unknown.length)
        throw new BadRequestException(
          `'${t.from}' → '${t.to}' uses unknown rule(s): ${unknown.join(", ")}`,
        );
    }

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
   *
   * PUBLIC, not private, so that WorkflowTemplateService can put the standard flow through exactly
   * this gate before activating it. A second copy of these rules is how a provisioned flow would
   * end up live in a shape the Activate button itself would have refused.
   */
  async assertActivatable(
    tx: Tx,
    id: string,
    flow: { is_default: boolean; selection_condition: unknown; entry_mode?: string | null },
  ) {
    const steps = (await tx.execute(sql`
      select s.id, coalesce(i.code, v.code) as code, s.is_entry, s.is_terminal, s.owner_roles
      from workflow_steps s
      left join item_statuses i on i.id = s.item_status_id
      left join vendor_statuses v on v.id = s.vendor_status_id
      where s.flow_id = ${id}::uuid`)) as Array<{ id: string; code: string; is_entry: boolean; is_terminal: boolean }>;
    const edges = (await tx.execute(sql`
      select from_step_id, to_step_id, to_flow_key from workflow_transitions where flow_id = ${id}::uuid`)) as Array<{
      from_step_id: string;
      to_step_id: string;
      to_flow_key: string | null;
    }>;

    const errs: string[] = [];
    if (steps.length === 0) errs.push("the flow has no steps");
    const entry = steps.find((s) => s.is_entry);
    if (!entry) errs.push("no entry step — new records would have nowhere to start");
    if (!steps.some((s) => s.is_terminal)) errs.push("no terminal step — records could never finish");
    // `entry_mode = 'handoff'` is a THIRD valid answer to "how do records get here" — 0066. A
    // sub-flow is reached by being handed a record, never by being selected for one, so demanding a
    // selection condition from it would force an admin to store `{}` — which this codebase defines
    // as "matches every record" — about a flow that must match none.
    if (!flow.is_default && flow.selection_condition === null && flow.entry_mode !== "handoff")
      errs.push(
        "routing is not set: give it a selection condition, make it the default flow, or mark it a " +
          "handoff flow that records only reach by crossing into it",
      );

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

    /**
     * CAN EVERY STEP STILL GET TO AN ENDING? — a latent defect that has nothing to do with crossings
     * and predates them, fixed here because this feature is what makes it dangerous.
     *
     * The three checks above look like they already guarantee it and they do not. Take
     * entry→X, X→Y, Y→X, entry→T(terminal): a terminal exists, every non-terminal has an outgoing
     * edge, and the forward BFS reaches every step — all three pass, and a record that lands on X
     * orbits X and Y forever. Nothing in the system would report it; the order simply never
     * finishes, and the two people watching it each see an arrow they can legitimately take.
     *
     * The correct test is the mirror of the forward one: BFS BACKWARDS from every terminal step and
     * refuse any step the walk does not reach. It is the property a sub-flow most needs — "a record
     * that enters can always get back out" is exactly "every step can reach an ending" — but it is
     * worth having on every flow in the system, which is why it is not conditional on crossings.
     */
    if (steps.some((s) => s.is_terminal)) {
      const rev = new Map<string, string[]>();
      for (const e of edges) rev.set(e.to_step_id, [...(rev.get(e.to_step_id) ?? []), e.from_step_id]);
      const canFinish = new Set(steps.filter((s) => s.is_terminal).map((s) => s.id));
      const queue = [...canFinish];
      while (queue.length) {
        for (const p of rev.get(queue.shift()!) ?? []) if (!canFinish.has(p)) (canFinish.add(p), queue.push(p));
      }
      for (const s of steps) {
        if (!canFinish.has(s.id))
          errs.push(
            `step '${s.code}' can never reach a terminal step — a record that gets there would never come back`,
          );
      }
    }
    if (errs.length) throw new BadRequestException(errs.join("; "));

    const crossingWarns = await this.assertCrossingsResolve(tx, id, edges);

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

    // A draft crossing target is worth telling the admin about, and it is the reason this publish
    // was allowed at all — see assertCrossingsResolve. It rides the same channel as every other
    // activation warning rather than a second one nobody reads.
    return [
      ...crossingWarns,
      ...WorkflowService.crossingWarnings(flow.entry_mode ?? "selected", steps, edges),
    ];
  }

  /**
   * SAID, NOT ENFORCED — and the distinction is the point.
   *
   * A handoff flow whose terminal steps have no crossing back is INDISTINGUISHABLE from one whose
   * way home was never drawn. Both are a sub-flow that ends some records where they are. The first
   * is legitimate and common — a claim that settles inside the returns process is finished, and
   * dragging it back to the parent just to sit on a terminal there would be ceremony. The second is
   * a mistake. Nothing in the graph tells them apart, because intent is not a property of a graph.
   *
   * So refusing would block correct flows, and staying silent would let a real omission through. It
   * is reported, and the admin — who knows which one they meant — decides. Returned rather than
   * logged: a warning written to a server log is a warning nobody reads.
   */
  private static crossingWarnings(
    entryMode: string,
    steps: Array<{ id: string; code: string; is_terminal: boolean }>,
    edges: Array<{ from_step_id: string; to_step_id: string; to_flow_key: string | null }>,
  ): string[] {
    if (entryMode !== "handoff") return [];
    // A crossing leaves FROM a step and also lands ON one, and only the first was counted — so the
    // hand-back arrow, which is drawn INTO a terminal step carrying to_flow_key, looked like no way
    // out at all. Activating a correctly drawn sub-flow therefore warned that its records "stay in
    // this workflow for good" and told the admin to draw the very arrow they had just drawn. The
    // record never occupies that step in this flow: it leaves at the moment of the move.
    const crossesOut = new Set(edges.filter((e) => e.to_flow_key).map((e) => e.from_step_id));
    const crossesAway = new Set(edges.filter((e) => e.to_flow_key).map((e) => e.to_step_id));
    const dead = steps
      .filter((s) => s.is_terminal && !crossesOut.has(s.id) && !crossesAway.has(s.id))
      .map((s) => s.code);
    if (!dead.length) return [];
    return [
      `records that reach ${dead.map((c) => `'${c}'`).join(", ")} stay in this workflow for good — ` +
        `nothing there hands them back. That is correct if this is where they are meant to finish; ` +
        `if they should return, draw an arrow from there into the workflow they came from.`,
    ];
  }

  /**
   * BOTH ENDS OF EVERY BORDER, checked at the only moment they are still cheap to fix — 0066.
   *
   * A crossing is the one thing in this engine that spans two graphs, so it is the one thing neither
   * graph can validate alone. Both directions are checked because a border breaks from either side:
   * publish the sub-flow without the status it lands on, or republish the PARENT having dropped the
   * status the sub-flow hands back to, and the result is the same — a record reaches the border and
   * the run-time resolver refuses it.
   *
   * The run-time refusal is safe by construction (the record does not move and every other arrow
   * still works), but "safe" is not "acceptable": the person who discovers it is a purchasing clerk
   * with a live order, and the person who could have prevented it was an admin pressing Activate.
   */
  private async assertCrossingsResolve(
    tx: Tx,
    id: string,
    edges: Array<{ to_step_id: string; to_flow_key: string | null }>,
  ) {
    const self = (await tx.execute(sql`
      select flow_key, tenant_id, environment, status_domain from workflow_flows where id = ${id}::uuid`))[0] as
      { flow_key: string; tenant_id: string; environment: string; status_domain: string } | undefined;
    if (!self) return [];

    const errs: string[] = [];
    /** Things worth saying that are not reasons to refuse the publish. */
    const warns: string[] = [];

    // ── FORWARD: everywhere this flow sends a record, can it actually land? ──────────────────────
    const outbound = edges.filter((e) => e.to_flow_key);
    for (const e of [...new Map(outbound.map((e) => [`${e.to_flow_key}:${e.to_step_id}`, e])).values()]) {
      // THE TARGET MAY STILL BE A DRAFT, AND REFUSING THAT MADE THE FEATURE UNBUILDABLE.
      //
      // This asked for an ACTIVE target and raised an error otherwise. Two flows that hand records
      // to each other — an order flow and the insurance flow it detours through, which is the case
      // this feature was asked for — then deadlocked: A will not activate until B is live, and B
      // will not activate until A is live. There is no order in which the pair can be published,
      // so the round trip could not be configured at all.
      //
      // A draft target is now a WARNING. It is a real thing to say — a record reaching that arrow
      // before the other flow is published is held, by the run-time check in status.service.ts —
      // but it is the admin's own half-finished work in front of them, not a reason to refuse the
      // publish that makes finishing it possible. Publish B (warned about A), then publish A
      // (clean, B is live), and the pair is up. A key that names NO flow at all is still an error:
      // that is a typo, and no amount of publishing will resolve it.
      const landing = (await tx.execute(sql`
        select coalesce(i.code, v.code) as code,
               (select f2.id from workflow_flows f2
                 where f2.tenant_id = ${self.tenant_id}::uuid and f2.environment = ${self.environment}::environment_type
                   and f2.status_domain = ${self.status_domain}::status_domain
                   and f2.flow_key = ${e.to_flow_key} and f2.status <> 'retired'
                 order by case f2.status when 'active' then 0 else 1 end, f2.version desc
                 limit 1) as target_id,
               (select f2.status::text from workflow_flows f2
                 where f2.tenant_id = ${self.tenant_id}::uuid and f2.environment = ${self.environment}::environment_type
                   and f2.status_domain = ${self.status_domain}::status_domain
                   and f2.flow_key = ${e.to_flow_key} and f2.status <> 'retired'
                 order by case f2.status when 'active' then 0 else 1 end, f2.version desc
                 limit 1) as target_status
        from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.id = ${e.to_step_id}::uuid`))[0] as
        { code: string; target_id: string | null; target_status: string | null } | undefined;
      if (!landing) continue;

      if (!landing.target_id) {
        errs.push(
          `'${landing.code}' hands the record to a workflow called '${e.to_flow_key}', and this ` +
            `workspace has no such workflow — check the name`,
        );
        continue;
      }
      if (landing.target_status !== "active") {
        warns.push(
          `'${landing.code}' hands the record to the '${e.to_flow_key}' workflow, which is still a ` +
            `draft. Records reaching this point will be held until you publish it.`,
        );
      }
      const has = (await tx.execute(sql`
        select 1 from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.flow_id = ${landing.target_id}::uuid and coalesce(i.code, v.code) = ${landing.code}
        limit 1`))[0];
      if (!has)
        errs.push(
          `'${landing.code}' hands the record to the '${e.to_flow_key}' workflow, but that workflow ` +
            `has no '${landing.code}' step — a record handed there would have nowhere to stand`,
        );
    }

    // ── REVERSE: does anything already cross INTO this flow at a status this version dropped? ────
    //
    // THIS IS THE CHECK THAT STOPS A-v2 STRANDING RECORDS SITTING INSIDE B. Publishing a new version
    // of the parent is a completely ordinary act performed by somebody who may never have looked at
    // the sub-flow, and deleting a status from it is exactly how the way home disappears.
    //
    // ── AND IT LOOKED AT THE WRONG FLOWS. `f.status = 'active'` MISSED THE POPULATION IT PROTECTS ──
    //
    // A record executes the flow VERSION it was bound to and keeps executing it after that version
    // is retired — that is the whole point of the binding, restated in three places in this file. So
    // the versions holding records with a way home to defend are precisely the ones an active-only
    // join cannot see: republish the sub-flow and its v1 is retired while every record inside it
    // still runs v1's return arrow. Republishing the PARENT without the status that retired arrow
    // lands on was then accepted silently, and a record inside v1 had no move left to make: its
    // return is refused at run time ("has no step for"), and it is not away in anything the
    // break-glass lever can act on differently.
    //
    // Driven from workflow_record_state instead: a version with rows pointing at it is a version
    // something is executing, whatever its status says. ACTIVE flows stay in scope on their own
    // merit — they have no records yet and will — so the predicate is a union of "live" and "being
    // executed", not a replacement of one by the other.
    const inbound = (await tx.execute(sql`
      select distinct f.name_en as source_name, f.version as source_version, f.status::text as source_status,
             coalesce(i.code, v.code) as code
      from workflow_transitions t
      join workflow_flows f on f.id = t.flow_id
       and (f.status = 'active'
            or exists (
                select 1 from workflow_record_state rs
                -- The record's CURRENT status lives on its own table, so resolving it is
                -- polymorphic. Anything this join cannot resolve falls through as live, which is
                -- the safe direction: refusing a retire is recoverable, stranding a record is not.
                left join rfqs        rq on rs.entity_type = 'rfq'        and rq.id = rs.entity_id
                left join rfq_items   ri on rs.entity_type = 'rfq_item'   and ri.id = rs.entity_id
                left join orders      oo on rs.entity_type = 'order'      and oo.id = rs.entity_id
                left join order_items oi on rs.entity_type = 'order_item' and oi.id = rs.entity_id
                left join workflow_steps st on st.flow_id = f.id
                  and st.item_status_id = coalesce(rq.status_id, ri.status_id, oo.status_id, oi.status_id)
                where rs.flow_id = f.id
                  and (st.id is null or not st.is_terminal)))
      join workflow_steps s on s.id = t.to_step_id
      left join item_statuses i on i.id = s.item_status_id
      left join vendor_statuses v on v.id = s.vendor_status_id
      where t.to_flow_key = ${self.flow_key}
        and f.tenant_id = ${self.tenant_id}::uuid and f.environment = ${self.environment}::environment_type
        and f.status_domain = ${self.status_domain}::status_domain
        and f.id <> ${id}::uuid`)) as Array<
      { source_name: string; source_version: number; source_status: string; code: string }
    >;

    const mine = new Set(
      ((await tx.execute(sql`
        select coalesce(i.code, v.code) as code from workflow_steps s
        left join item_statuses i on i.id = s.item_status_id
        left join vendor_statuses v on v.id = s.vendor_status_id
        where s.flow_id = ${id}::uuid`)) as Array<{ code: string }>).map((s) => s.code),
    );
    for (const i of inbound) {
      if (!mine.has(i.code))
        errs.push(
          `the '${i.source_name}' workflow (v${i.source_version}${
            // Naming the version and saying it is retired is the difference between a message an
            // admin can act on and one they will argue with: their screen shows that workflow live
            // on a later version, and the thing being protected is the records still inside the
            // older one.
            i.source_status === "active" ? "" : `, ${i.source_status}, records still moving in it`
          }) hands records back to this one at '${i.code}', and this version has no '${i.code}' ` +
            `step — records inside it would have nowhere to return to`,
        );
    }

    if (errs.length) throw new BadRequestException(errs.join("; "));
    return warns;
  }
}
