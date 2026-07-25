import { sql, type SQL } from "drizzle-orm";
import { isPageKey } from "./pages.js";

/**
 * Turns "which status shows on which page" into a WHERE predicate.
 *
 * THE SAFETY RULE, and the reason this is not a simple `pages @> queue` test:
 *
 *   A status that the flow routes NOWHERE appears on EVERY page, exactly as it does today.
 *   Only a status deliberately routed somewhere is filtered out of the pages it was not routed to.
 *
 * Without that rule, the first time an admin routed a single status, every OTHER status would
 * silently vanish from every queue — a half-configured flow would hide live work, and the failure
 * would surface as a customer phone call rather than an error. With it, the worst a partial
 * configuration can do is move records between queues; it can never make one disappear.
 *
 * The predicate reads only ACTIVE flows. A draft being edited must never change what anyone sees.
 *
 * Callers pass `undefined` to opt out entirely, which yields `true` — so an endpoint, an integration
 * or an external consumer that does not ask for a queue gets today's query unchanged.
 */
export function queuePredicate(statusCode: SQL, queue: string | undefined): SQL {
  if (!queue || !isPageKey(queue)) return sql`true`;

  // RLS already scopes workflow_flows/workflow_steps to this tenant and environment, so the
  // subqueries need no explicit tenant filter — adding one would duplicate the policy, not tighten it.
  const routedAnywhere = sql`
    select coalesce(i.code, v.code)
    from workflow_steps ws
    join workflow_flows f on f.id = ws.flow_id and f.status = 'active'
    left join item_statuses i on i.id = ws.item_status_id
    left join vendor_statuses v on v.id = ws.vendor_status_id
    where jsonb_array_length(ws.pages) > 0`;

  const routedHere = sql`
    select coalesce(i.code, v.code)
    from workflow_steps ws
    join workflow_flows f on f.id = ws.flow_id and f.status = 'active'
    left join item_statuses i on i.id = ws.item_status_id
    left join vendor_statuses v on v.id = ws.vendor_status_id
    where ws.pages @> to_jsonb(${queue}::text)`;

  return sql`(${statusCode} is null or ${statusCode} not in (${routedAnywhere}) or ${statusCode} in (${routedHere}))`;
}
