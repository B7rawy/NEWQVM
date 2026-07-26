import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";
import { envOf } from "../../common/env-guards.js";
import { StatusService, type StatusEntity } from "../../common/status.service.js";

export const createPolicySchema = z.object({
  name: z.string().min(1),
  entityType: z.string().min(1),
  levels: z
    .array(z.object({ approverUserId: z.string().uuid(), isRequired: z.boolean().default(true) }))
    .min(1),
});
export const submitSchema = z.object({ entityType: z.string().min(1), entityId: z.string().uuid() });

/** Ask for sign-off on a specific MOVE, not just on a record. */
export const requestMoveSchema = z.object({
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  /** "fromCode>toCode" — the move being authorised. */
  transitionKey: z.string().min(3).max(140),
});
export const actSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().max(500).optional(),
});

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

  async createPolicy(ctx: RlsContext, dto: z.infer<typeof createPolicySchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const [p] = await tx
        .insert(schema.approvalPolicies)
        .values({ tenantId: ctx.tenantId!, name: dto.name, entityType: dto.entityType })
        .returning({ id: schema.approvalPolicies.id });
      await tx.insert(schema.approvalLevels).values(
        dto.levels.map((l, i) => ({
          tenantId: ctx.tenantId!,
          policyId: p.id,
          levelOrder: i + 1,
          approverUserId: l.approverUserId,
          isRequired: l.isRequired,
        })),
      );
      return { id: p.id, levels: dto.levels.length };
    });
  }

  /**
   * THE APPROVALS INBOX.
   *
   * Three lists, and the third is the one that matters most:
   *
   *   waitingOnMe      — I am the named approver for the current level. My decision, right now.
   *   readyToContinue  — signed off, and the move has NOT happened. This is the safety net. The
   *                      final approval performs the move, so this should always be empty; if a row
   *                      appears here it means an approval was granted and something stopped the
   *                      move afterwards. With no scheduler in this repo, a stuck grant is invisible
   *                      anywhere else, and an approval that silently changed nothing is the worst
   *                      failure this feature can have.
   *   mine             — what I asked for, so I can see who it is sitting with.
   */
  async inbox(ctx: RlsContext) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = (await tx.execute(sql`
        select r.id, r.entity_type, r.entity_id, r.transition_key, r.overall_status,
               r.current_level, r.created_at, r.consumed_at, r.requested_by,
               coalesce(r.requested_by_name, u.full_name) as requested_by_name,
               l.approver_user_id as current_approver,
               au.full_name as current_approver_name,
               p.name as policy,
               (select count(*)::int from approval_levels x where x.policy_id = r.policy_id) as levels,
               coalesce(rq.order_number, o.order_number, irq.order_number) as reference,
               coalesce(ii.part_number, oi.final_part_number) as part
        from approval_requests r
        join approval_policies p on p.id = r.policy_id
        left join approval_levels l on l.policy_id = r.policy_id and l.level_order = r.current_level
        left join users u on u.id = r.requested_by
        left join users au on au.id = l.approver_user_id
        left join rfqs        rq on r.entity_type = 'rfq'        and rq.id = r.entity_id
        left join orders      o  on r.entity_type = 'order'      and o.id  = r.entity_id
        left join rfq_items   ii on r.entity_type = 'rfq_item'   and ii.id = r.entity_id
        left join order_items oi on r.entity_type = 'order_item' and oi.id = r.entity_id
        left join rfqs        irq on irq.id = ii.rfq_id
        where r.environment = ${envOf(ctx)}
        order by r.created_at desc
        limit 200`)) as Array<Record<string, unknown>>;

      const mineId = ctx.userId;
      return {
        waitingOnMe: rows.filter(
          (r) => r.overall_status === "pending" && r.current_approver === mineId,
        ),
        readyToContinue: rows.filter(
          (r) => r.overall_status === "approved" && r.consumed_at === null && r.transition_key,
        ),
        mine: rows.filter((r) => r.requested_by === mineId && r.overall_status === "pending"),
        // everything else, so nothing is invisible just because it is not yours
        all: rows,
      };
    });
  }

  /**
   * Ask for sign-off on a specific move.
   *
   * Separate from the guard on purpose. The guard runs inside the caller's business transaction, so
   * anything it wrote would be rolled back by its own refusal — the first cut did that and reported
   * "sent for sign-off" while creating nothing. Asking is a deliberate act with its own transaction.
   *
   * Idempotent: pressing the button twice joins the request already waiting rather than splitting
   * the approvers across two.
   */
  async requestForMove(ctx: RlsContext, dto: z.infer<typeof requestMoveSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const existing = (await tx.execute(sql`
        select id, current_level from approval_requests
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
          and entity_type = ${dto.entityType} and entity_id = ${dto.entityId}::uuid
          and transition_key = ${dto.transitionKey} and overall_status = 'pending'
        limit 1`))[0] as { id: string; current_level: number } | undefined;
      if (existing) return { requestId: existing.id, status: "pending", currentLevel: existing.current_level, joined: true };

      const policy = (await tx.execute(sql`
        select id from approval_policies
        where tenant_id = ${ctx.tenantId}::uuid and entity_type = ${dto.entityType} and is_active
        order by created_at desc limit 1`))[0] as { id: string } | undefined;
      // A padlock with no policy behind it blocks the move forever with nobody able to clear it.
      if (!policy)
        throw new BadRequestException(
          `no approval policy is set up for ${dto.entityType} in this workspace, so nobody can sign this off`,
        );

      const [r] = (await tx.execute(sql`
        insert into approval_requests
          (tenant_id, environment, policy_id, entity_type, entity_id, requested_by,
           current_level, overall_status, transition_key, requested_by_name)
        values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${policy.id}::uuid, ${dto.entityType},
                ${dto.entityId}::uuid, ${ctx.userId}::uuid, 1, 'pending', ${dto.transitionKey},
                (select full_name from users where id = ${ctx.userId}::uuid))
        returning id`)) as Array<{ id: string }>;
      return { requestId: r.id, status: "pending", currentLevel: 1, joined: false };
    });
  }

  /** Open an approval request against the active policy for this entity type (level 1). */
  async submit(ctx: RlsContext, dto: z.infer<typeof submitSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const policy = (
        (await tx.execute(sql`
          select id from approval_policies
          where tenant_id = ${ctx.tenantId}::uuid and entity_type = ${dto.entityType} and is_active
          order by created_at desc limit 1`)) as Array<{ id: string }>
      )[0];
      if (!policy) throw new BadRequestException(`no active approval policy for ${dto.entityType}`);

      let r: { id: string };
      try {
        [r] = await tx
          .insert(schema.approvalRequests)
          .values({
            tenantId: ctx.tenantId!,
            environment: envOf(ctx),
            policyId: policy.id,
            entityType: dto.entityType,
            entityId: dto.entityId,
            requestedBy: ctx.userId,
            currentLevel: 1,
            overallStatus: "pending",
          })
          .returning({ id: schema.approvalRequests.id });
      } catch (e) {
        // approval_requests_pending_uq: an entity can have only one open request at a time.
        if ((e as { code?: string })?.code === "23505")
          throw new ConflictException("this entity already has a pending approval request");
        throw e;
      }
      return { requestId: r.id, status: "pending", currentLevel: 1 };
    });
  }

  /**
   * The current level's named approver acts (approve/reject). Approve advances to the next level or
   * completes; reject halts permanently. Only the current level's approver may act.
   */
  async act(ctx: RlsContext, requestId: string, dto: z.infer<typeof actSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      // FOR UPDATE serializes concurrent acts on the same request (prevents level-skip race)
      const req = (
        (await tx.execute(sql`
          select id, policy_id, current_level, overall_status, requested_by,
                 entity_type, entity_id, transition_key
          from approval_requests where id = ${requestId}::uuid limit 1 for update`)) as Array<{
          id: string;
          policy_id: string;
          current_level: number;
          overall_status: string;
          entity_type: string;
          entity_id: string;
          transition_key: string | null;
          requested_by: string | null;
        }>
      )[0];
      if (!req) throw new NotFoundException("approval request not found");
      if (req.overall_status !== "pending") throw new BadRequestException("request already resolved");

      const levels = (await tx.execute(sql`
        select level_order, approver_user_id from approval_levels
        where policy_id = ${req.policy_id}::uuid order by level_order`)) as Array<{
        level_order: number;
        approver_user_id: string;
      }>;
      const current = levels.find((l) => l.level_order === req.current_level);
      if (!current) throw new BadRequestException("no level configured");
      if (current.approver_user_id !== ctx.userId) {
        throw new ForbiddenException("you are not the approver for the current level");
      }
      // segregation of duties: the requester can never sign off on their own request.
      if (req.requested_by === ctx.userId) {
        throw new ForbiddenException("the requester cannot approve or reject their own request");
      }

      await tx.insert(schema.approvalActions).values({
        tenantId: ctx.tenantId!,
        environment: envOf(ctx),
        requestId,
        actorUserId: ctx.userId!,
        action: dto.action,
        comment: dto.comment,
      });

      if (dto.action === "reject") {
        await tx.execute(
          sql`update approval_requests set overall_status = 'rejected' where id = ${requestId}::uuid`,
        );
        return { requestId, status: "rejected" };
      }

      const isLast = req.current_level >= Math.max(...levels.map((l) => l.level_order));
      if (isLast) {
        await tx.execute(
          sql`update approval_requests set overall_status = 'approved' where id = ${requestId}::uuid`,
        );

        // THE LAST APPROVAL PERFORMS THE MOVE.
        //
        // Without this the record is approved and still sitting there: this repo has no scheduler,
        // no queue worker and no notification dispatcher, so nothing would tell anyone the sign-off
        // had landed. The order would wait until a human happened to press the button again — and a
        // sign-off that changes nothing is the fastest way to lose trust in sign-offs.
        //
        // Running it here also means the approver's own transaction proves the move is possible. If
        // a gate has failed in the meantime, the approval is rolled back with it rather than being
        // recorded against a move that never happened.
        if (req.transition_key) {
          const toCode = req.transition_key.split(">")[1];
          if (toCode) {
            await this.status.transition(tx, ctx, {
              entity: req.entity_type as StatusEntity,
              id: req.entity_id,
              toCode,
            });
          }
        }
        return { requestId, status: "approved", moved: !!req.transition_key };
      }
      // guard the advance on the level we actually acted on
      await tx.execute(
        sql`update approval_requests set current_level = current_level + 1
            where id = ${requestId}::uuid and current_level = ${req.current_level}`,
      );
      return { requestId, status: "pending", currentLevel: req.current_level + 1 };
    });
  }

  async get(ctx: RlsContext, requestId: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select r.id, r.entity_type, r.entity_id, r.current_level, r.overall_status,
               (select count(*)::int from approval_actions a where a.request_id = r.id) as actions
        from approval_requests r where r.id = ${requestId}::uuid`),
    );
    if (rows.length === 0) throw new NotFoundException("approval request not found");
    return rows[0];
  }
}
