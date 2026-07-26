import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";
import { envOf } from "../../common/env-guards.js";
import { StatusService, type StatusEntity } from "../../common/status.service.js";

/**
 * CANCELLATION AND RETURN — QNEW-89 §7.
 *
 * These are not statuses in the order's own chain. Splicing "cancellation requested" into the
 * order's status would destroy the very fact you need to put it back if the request is refused: the
 * order stops being `confirmed` the moment someone merely ASKS to cancel it.
 *
 * So an exception is a small flow hanging off the record — request → review → execute or restore —
 * and while it is open the record keeps its real status, frozen. Two states, both true.
 *
 * ENTRY CONDITIONS are checked here rather than left to the workflow, because they are properties of
 * the exception rather than of the flow: you may cancel an order that has not been delivered, and
 * you may return one that has.
 */

export const openExceptionSchema = z.object({
  entityType: z.enum(["rfq", "rfq_item", "order", "order_item"]),
  entityId: z.string().uuid(),
  kind: z.enum(["cancellation", "return"]),
  reason: z.string().min(3).max(500),
});

export const resolveExceptionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional(),
});

/** Release carries no decision — there was no request. Only a note, and even that is optional. */
export const releaseExceptionSchema = z.object({
  note: z.string().max(500).optional(),
});

/** Where an approved exception sends the record. */
const TERMINAL: Record<string, string> = { cancellation: "cancelled", return: "return" };

/** Statuses past which a cancellation is no longer the right instrument — use a return instead. */
const DELIVERED_ONWARDS = ["delivered", "pending_invoice", "invoice_issued", "settled"];

@Injectable()
export class WorkflowExceptionsService {
  constructor(
    private readonly dbService: DbService,
    private readonly status: StatusService,
  ) {}

  /** Everything open, plus recently decided, so a reviewer has one place to look. */
  async list(ctx: RlsContext) {
    return this.dbService.withContext(ctx, async (tx) => {
      const rows = await tx.execute(sql`
        select e.id, e.entity_type, e.entity_id, e.kind, e.status, e.reason,
               e.requested_by_name, e.resolved_by_name, e.resolved_at, e.resolution_note,
               e.created_at,
               s.label_en as frozen_at,
               coalesce(r.order_number, o.order_number, ir.order_number, io.order_number) as reference,
               coalesce(ii.part_number, oi.final_part_number) as part
        from workflow_exceptions e
        left join item_statuses s on s.id = e.restore_status_id
        left join rfqs        r  on e.entity_type = 'rfq'        and r.id  = e.entity_id
        left join orders      o  on e.entity_type = 'order'      and o.id  = e.entity_id
        left join rfq_items   ii on e.entity_type = 'rfq_item'   and ii.id = e.entity_id
        left join order_items oi on e.entity_type = 'order_item' and oi.id = e.entity_id
        left join rfqs   ir on ir.id = ii.rfq_id
        left join orders io on io.id = oi.order_id
        where e.environment = ${envOf(ctx)}
        order by case e.status when 'open' then 0 else 1 end, e.created_at desc
        limit 200`);
      // Two buckets, not one, because they need different buttons: `open` is a question somebody
      // must answer, `held` is a record the engine parked. Handing a hold to the inbox that renders
      // "Cancel it" is precisely the defect 0057 closed, so the split is enforced here rather than
      // trusted to the caller.
      const isOpen = (r: unknown) => (r as { status: string }).status === "open";
      const isHold = (r: unknown) => (r as { kind: string }).kind === "hold";
      return {
        open: rows.filter((r) => isOpen(r) && !isHold(r)),
        held: rows.filter((r) => isOpen(r) && isHold(r)),
        all: rows,
      };
    });
  }

  /**
   * Raise a cancellation or a return.
   *
   * Captures the record's CURRENT status as the thing to restore. Reading it back from status_logs
   * at rejection time would mean trusting that nothing moved in between — which the freeze does
   * guarantee, but recording the answer is cheaper than proving it and survives a trimmed log.
   */
  async open(ctx: RlsContext, dto: z.infer<typeof openExceptionSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const table =
        dto.entityType === "rfq" ? "rfqs"
        : dto.entityType === "rfq_item" ? "rfq_items"
        : dto.entityType === "order" ? "orders" : "order_items";

      const rec = (await tx.execute(sql`
        select t.status_id, s.code
        from ${sql.raw(table)} t
        left join item_statuses s on s.id = t.status_id
        where t.id = ${dto.entityId}::uuid
        limit 1`))[0] as { status_id: string | null; code: string | null } | undefined;
      if (!rec) throw new NotFoundException("that record is not in this workspace");

      const code = rec.code ?? "";
      // §7.5 — the entry conditions. A cancellation after delivery is a return, and calling it a
      // cancellation would send it down a path that never touches the goods that are already out.
      if (dto.kind === "cancellation" && DELIVERED_ONWARDS.includes(code))
        throw new BadRequestException(
          `this has already reached '${code}' — raise a return instead of a cancellation`,
        );
      if (dto.kind === "return" && !DELIVERED_ONWARDS.includes(code))
        throw new BadRequestException(
          `nothing has been delivered yet (it is '${code}') — raise a cancellation instead of a return`,
        );

      const existing = (await tx.execute(sql`
        select id from workflow_exceptions
        where tenant_id = ${ctx.tenantId}::uuid and environment = ${envOf(ctx)}
          and entity_type = ${dto.entityType}::entity_type and entity_id = ${dto.entityId}::uuid
          and status = 'open' limit 1`))[0] as { id: string } | undefined;
      // two people asking should join one review, not open two that can be decided differently
      if (existing) throw new ConflictException({ message: "one is already open for this record", exceptionId: existing.id });

      const [row] = (await tx.execute(sql`
        insert into workflow_exceptions
          (tenant_id, environment, entity_type, entity_id, kind, status, reason,
           requested_by, requested_by_name, restore_status_id)
        values (${ctx.tenantId}::uuid, ${envOf(ctx)}, ${dto.entityType}::entity_type,
                ${dto.entityId}::uuid, ${dto.kind}, 'open', ${dto.reason},
                ${ctx.userId}::uuid, (select full_name from users where id = ${ctx.userId}::uuid),
                ${rec.status_id}::uuid)
        returning id`)) as Array<{ id: string }>;

      return { id: row.id, kind: dto.kind, status: "open", frozenAt: code };
    });
  }

  /**
   * Decide it.
   *
   * approve → the record moves to the exception's terminal status.
   * reject  → the record goes back to exactly where it was, which is the point of capturing it.
   *
   * Both go through StatusService like every other move, so they land in status_logs with the real
   * actor. `resolvingException` is the one flag that lifts the freeze — without it, resolving a
   * cancellation would be blocked by the cancellation being resolved.
   */
  async resolve(ctx: RlsContext, id: string, dto: z.infer<typeof resolveExceptionSchema>) {
    return this.dbService.withContext(ctx, async (tx) => {
      const e = (await tx.execute(sql`
        select id, entity_type, entity_id, kind, status, restore_status_id, requested_by
        from workflow_exceptions
        where id = ${id}::uuid limit 1 for update`))[0] as {
        id: string; entity_type: string; entity_id: string; kind: string;
        status: string; restore_status_id: string | null; requested_by: string | null;
      } | undefined;
      if (!e) throw new NotFoundException("exception not found");
      if (e.status !== "open") throw new BadRequestException(`already ${e.status}`);

      // A hold is not a request, so there is nothing here to approve or refuse — and approving one
      // would run TERMINAL['hold'], which does not exist. Before 0057 the engine filed its holds as
      // cancellations and this path would have CANCELLED the record. Release is the only exit.
      if (e.kind === "hold")
        throw new BadRequestException(
          "this is on hold, not a request — release it instead of approving or refusing it",
        );

      // segregation of duties, same rule the approvals engine applies: asking and deciding are two
      // different people, or the review is theatre.
      if (e.requested_by === ctx.userId)
        throw new BadRequestException("the person who asked for this cannot decide it");

      const inner = { ...ctx, resolvingException: true };

      if (dto.decision === "approve") {
        const toCode = TERMINAL[e.kind];
        await this.status.transition(tx, inner, {
          entity: e.entity_type as StatusEntity,
          id: e.entity_id,
          toCode,
        });
        await tx.execute(sql`
          update workflow_exceptions
             set status = 'executed', resolved_by = ${ctx.userId}::uuid,
                 resolved_by_name = (select full_name from users where id = ${ctx.userId}::uuid),
                 resolved_at = now(), resolution_note = ${dto.note ?? null}, updated_at = now()
           where id = ${id}::uuid`);
        return { id, decision: "approved", movedTo: toCode };
      }

      // REJECT — put it back exactly where it was. The record never left, but its own flow was
      // frozen; unfreezing without restoring would be fine here, yet writing the restore explicitly
      // means status_logs records that a cancellation was refused rather than leaving a silent gap.
      let restoredTo: string | null = null;
      if (e.restore_status_id) {
        const [s] = (await tx.execute(sql`
          select code from item_statuses where id = ${e.restore_status_id}::uuid`)) as Array<{ code: string }>;
        restoredTo = s?.code ?? null;
        if (restoredTo) {
          await this.status.transition(tx, inner, {
            entity: e.entity_type as StatusEntity,
            id: e.entity_id,
            toCode: restoredTo,
          });
        }
      }
      await tx.execute(sql`
        update workflow_exceptions
           set status = 'rejected', resolved_by = ${ctx.userId}::uuid,
               resolved_by_name = (select full_name from users where id = ${ctx.userId}::uuid),
               resolved_at = now(), resolution_note = ${dto.note ?? null}, updated_at = now()
         where id = ${id}::uuid`);
      return { id, decision: "rejected", restoredTo };
    });
  }

  /**
   * Take a record off hold (0057).
   *
   * Separate from resolve() because a hold is a different kind of thing: the engine froze the record
   * and nobody is being asked to decide anything. Three differences follow from that, and each is
   * deliberate:
   *
   *   - no approve/reject — the only exit is release, so there is no path that cancels the record
   *   - no segregation of duties — that rule exists so asking and granting are two people. Nobody
   *     asked for a hold, so refusing to let the person who tripped it clear it would only strand
   *     the record.
   *   - no status move — a hold never took the record anywhere, so there is nothing to restore.
   *     restore_status_id is still captured, because a hold placed on a record that a LATER
   *     cancellation also touches needs to know where home was.
   */
  async release(ctx: RlsContext, id: string, note?: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      const e = (await tx.execute(sql`
        select id, kind, status from workflow_exceptions
        where id = ${id}::uuid limit 1 for update`))[0] as
        { id: string; kind: string; status: string } | undefined;
      if (!e) throw new NotFoundException("not found");
      if (e.kind !== "hold")
        throw new BadRequestException(
          `a ${e.kind} is somebody's request — decide it, do not release it`,
        );
      if (e.status !== "open") throw new BadRequestException(`already ${e.status}`);

      await tx.execute(sql`
        update workflow_exceptions
           set status = 'released', resolved_by = ${ctx.userId}::uuid,
               resolved_by_name = (select full_name from users where id = ${ctx.userId}::uuid),
               resolved_at = now(), resolution_note = ${note ?? null}, updated_at = now()
         where id = ${id}::uuid`);
      return { id, status: "released" };
    });
  }
}
