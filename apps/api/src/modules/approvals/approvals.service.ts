import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, schema, type RlsContext } from "../../db/db.service.js";

export const createPolicySchema = z.object({
  name: z.string().min(1),
  entityType: z.string().min(1),
  levels: z
    .array(z.object({ approverUserId: z.string().uuid(), isRequired: z.boolean().default(true) }))
    .min(1),
});
export const submitSchema = z.object({ entityType: z.string().min(1), entityId: z.string().uuid() });
export const actSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().max(500).optional(),
});

@Injectable()
export class ApprovalsService {
  constructor(private readonly dbService: DbService) {}

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

      const [r] = await tx
        .insert(schema.approvalRequests)
        .values({
          tenantId: ctx.tenantId!,
          policyId: policy.id,
          entityType: dto.entityType,
          entityId: dto.entityId,
          requestedBy: ctx.userId,
          currentLevel: 1,
          overallStatus: "pending",
        })
        .returning({ id: schema.approvalRequests.id });
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
          select id, policy_id, current_level, overall_status
          from approval_requests where id = ${requestId}::uuid limit 1 for update`)) as Array<{
          id: string;
          policy_id: string;
          current_level: number;
          overall_status: string;
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

      await tx.insert(schema.approvalActions).values({
        tenantId: ctx.tenantId!,
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
        return { requestId, status: "approved" };
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
               (select count(*) from approval_actions a where a.request_id = r.id) as actions
        from approval_requests r where r.id = ${requestId}::uuid`),
    );
    if (rows.length === 0) throw new NotFoundException("approval request not found");
    return rows[0];
  }
}
