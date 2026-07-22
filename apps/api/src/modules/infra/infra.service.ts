import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, schema, type RlsContext, type Tx } from "../../db/db.service.js";

@Injectable()
export class AuditService {
  constructor(private readonly dbService: DbService) {}

  /** Append an audit entry inside an existing tx (called by other services). */
  async record(
    tx: Tx,
    tenantId: string,
    e: {
      entityType: string;
      entityId?: string | null;
      actorUserId?: string | null;
      action: string;
      oldValue?: unknown;
      newValue?: unknown;
    },
  ) {
    await tx.insert(schema.auditLog).values({
      tenantId,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      actorUserId: e.actorUserId ?? null,
      action: e.action,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
    });
  }

  async query(ctx: RlsContext, entityType?: string, entityId?: string) {
    const rows = await this.dbService.withContext(ctx, (tx) =>
      tx.execute(sql`
        select id, entity_type, entity_id, action, actor_user_id, created_at
        from audit_log
        where (${entityType ?? null}::text is null or entity_type = ${entityType ?? null})
          and (${entityId ?? null}::uuid is null or entity_id = ${entityId ?? null}::uuid)
        order by created_at desc limit 100`),
    );
    return { count: rows.length, entries: rows };
  }
}

@Injectable()
export class CalendarService {
  constructor(private readonly dbService: DbService) {}

  async getSettings(ctx: RlsContext) {
    return this.dbService.withContext(ctx, (tx) => this.load(tx, ctx.tenantId!));
  }

  private async load(tx: Tx, tenantId: string) {
    const s = (
      (await tx.execute(sql`
        select working_days, day_start_minute, day_end_minute, timezone
        from business_calendar_settings where tenant_id = ${tenantId}::uuid limit 1`)) as Array<{
        working_days: number[];
        day_start_minute: number;
        day_end_minute: number;
        timezone: string;
      }>
    )[0];
    return s ?? { working_days: [0, 1, 2, 3, 4], day_start_minute: 480, day_end_minute: 1020, timezone: "Asia/Riyadh" };
  }

  async setSettings(ctx: RlsContext, workingDays: number[]) {
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into business_calendar_settings (tenant_id, working_days)
        values (${ctx.tenantId}::uuid, ${JSON.stringify(workingDays)}::jsonb)
        on conflict (tenant_id) do update set working_days = excluded.working_days, updated_at = now()`);
      return { workingDays };
    });
  }

  async addHoliday(ctx: RlsContext, dateStr: string, name?: string) {
    return this.dbService.withContext(ctx, async (tx) => {
      await tx.execute(sql`
        insert into business_holidays (tenant_id, holiday_date, name)
        values (${ctx.tenantId}::uuid, ${dateStr}::date, ${name ?? null})
        on conflict (tenant_id, holiday_date) do nothing`);
      return { date: dateStr };
    });
  }

  /** Deadline = `from` + N business days, skipping non-working weekdays and holidays (QNEW-47). */
  async computeDeadline(ctx: RlsContext, fromISO: string, businessDays: number) {
    return this.dbService.withContext(ctx, async (tx) => {
      const settings = await this.load(tx, ctx.tenantId!);
      const holidays = new Set(
        (
          (await tx.execute(
            sql`select holiday_date::text as d from business_holidays where tenant_id = ${ctx.tenantId}::uuid`,
          )) as Array<{ d: string }>
        ).map((r) => r.d),
      );
      const working = new Set(settings.working_days);
      const cur = new Date(fromISO);
      let counted = 0;
      let guard = 0;
      while (counted < businessDays && guard < 1000) {
        cur.setUTCDate(cur.getUTCDate() + 1);
        guard++;
        const iso = cur.toISOString().slice(0, 10);
        if (working.has(cur.getUTCDay()) && !holidays.has(iso)) counted++;
      }
      return { from: fromISO, businessDays, deadline: cur.toISOString().slice(0, 10) };
    });
  }
}
