/**
 * Adversarial harness: deliberately build a CYCLE of automatic arrows, each carrying a `notify`
 * action, and count everything the engine writes. Everything runs inside ONE transaction that is
 * rolled back at the end, so a concurrent guard-check run cannot see it and it leaves nothing.
 */
import "reflect-metadata";
import { sql } from "drizzle-orm";
import { DbService } from "../src/db/db.service.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { StatusService } from "../src/common/status.service.js";

const db = new DbService();
const status = new StatusService(new NotificationsService(db));

const TENANT = process.env.T!;
const USER = process.env.U!;
const BRANCH = process.env.BR!;
const ENV = "sandbox" as const;
const MODE = process.env.MODE ?? "entry";

class Rollback extends Error {}

try {
  await db.withContext(
    { tenantId: TENANT, userId: USER, isInternal: true, environment: ENV },
    async (tx) => {
      const st = (await tx.execute(
        sql`select id, code from item_statuses where code in ('new_rfq','priced')`,
      )) as Array<{ id: string; code: string }>;
      const S = Object.fromEntries(st.map((r) => [r.code, r.id])) as Record<string, string>;

      const [flow] = (await tx.execute(sql`
        insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
                                    status_domain, status, is_default, canvas)
        values (${TENANT}::uuid, ${ENV}, 'adversarial-loop', 1, 'Loop', 'Loop', 'item', 'draft', false, '{}'::jsonb)
        returning id`)) as Array<{ id: string }>;

      const mkStep = async (statusId: string, order: number) =>
        ((await tx.execute(sql`
          insert into workflow_steps (tenant_id, environment, flow_id, status_domain, item_status_id,
                                      sort_order, is_entry, is_terminal, canvas_x, canvas_y, pages, owner_roles)
          values (${TENANT}::uuid, ${ENV}, ${flow.id}::uuid, 'item', ${statusId}::uuid, ${order},
                  ${order === 1}, false, 0, 0, '[]'::jsonb, '["company_admin"]'::jsonb)
          returning id`)) as Array<{ id: string }>)[0].id;

      const sNew = await mkStep(S.new_rfq, 1);
      const sPriced = await mkStep(S.priced, 2);

      const NOTIFY = JSON.stringify([
        { action: "notify", params: { to: "assignee_and_step_owners", title: "{reference} moved", message: "It is now {status}." } },
      ]);
      const mkTx = async (from: string, to: string, auto: boolean) =>
        tx.execute(sql`
          insert into workflow_transitions (tenant_id, environment, flow_id, from_step_id, to_step_id,
                 requires_approval, allowed_roles, condition, priority, handoff, gates,
                 auto_advance, auto_once, actions)
          values (${TENANT}::uuid, ${ENV}, ${flow.id}::uuid, ${from}::uuid, ${to}::uuid,
                  false, '[]'::jsonb, '{}'::jsonb, 0, 'pool', '[]'::jsonb,
                  ${auto}, false, ${NOTIFY}::jsonb)`);

      // THE CYCLE: new_rfq -> priced -> new_rfq, both automatic, both notifying.
      await mkTx(sNew, sPriced, MODE === "entry" || MODE === "auto");
      await mkTx(sPriced, sNew, true);

      // the freeze trigger refuses edits to an ACTIVE flow, so activate only once it is drawn
      await tx.execute(sql`update workflow_flows set status='active', is_default=true where id = ${flow.id}::uuid`);

      const [rfq] = (await tx.execute(sql`
        insert into rfqs (tenant_id, environment, order_number, workshop_branch_id, order_type,
                          delivery_type, payer_type)
        values (${TENANT}::uuid, ${ENV}, ${"ADV-" + Date.now()}, ${BRANCH}::uuid, 'regular', 'delivery', 'cash_client')
        returning id`)) as Array<{ id: string }>;

      const t0 = Date.now();
      await status.enter(tx, { tenantId: TENANT, userId: USER, environment: ENV }, {
        entity: "rfq", id: rfq.id, toCode: "new_rfq",
      });
      if (MODE === "manual") {
        await status.transition(tx, { tenantId: TENANT, userId: USER, environment: ENV }, {
          entity: "rfq", id: rfq.id, toCode: "priced",
        });
      }
      const ms = Date.now() - t0;

      const one = async (q: ReturnType<typeof sql>) => ((await tx.execute(q)) as Array<{ n: number }>)[0].n;
      const logs = await one(sql`select count(*)::int as n from status_logs where entity_id = ${rfq.id}::uuid`);
      const runs = await one(sql`select count(*)::int as n from workflow_action_runs where entity_id = ${rfq.id}::uuid`);
      const notifs = await one(sql`select count(*)::int as n from in_app_notifications where tenant_id = ${TENANT}::uuid and environment = ${ENV}`);
      const trail = (await tx.execute(sql`
        select fi.code as f, ti.code as t, auto_advanced
        from status_logs l
        left join item_statuses fi on fi.id = l.from_status_id
        left join item_statuses ti on ti.id = l.to_status_id
        where l.entity_id = ${rfq.id}::uuid order by l.created_at`)) as Array<Record<string, unknown>>;
      const [final] = (await tx.execute(sql`
        select s.code from rfqs r join item_statuses s on s.id = r.status_id where r.id = ${rfq.id}::uuid`)) as Array<{ code: string }>;

      throw new Rollback(
        JSON.stringify({ mode: MODE, ms, status_logs: logs, action_runs: runs, in_app: notifs, final: final?.code, trail }, null, 1),
      );
    },
  );
} catch (e) {
  if (e instanceof Rollback) console.log(e.message);
  else console.log("UNEXPECTED: " + (e as Error).message);
}
await db.onModuleDestroy();
