import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DbService, type RlsContext } from "../../db/db.service.js";

/**
 * WHICH PAGES THIS USER HAS, in this workspace, right now.
 *
 * Three questions decide every page, in this order:
 *
 *   1. PERSONA — which portal is being rendered. A vendor never sees a workspace page whatever
 *      their role, because it is not their portal.
 *   2. MODULE — is the page switched on for this workspace. A page belonging to a counterparty
 *      family exists only while the workspace has an ACTIVE link of that kind, which is the whole
 *      point: a workspace created with no service providers has no service-provider pages, and
 *      linking one makes them appear with no deploy and no setting to remember.
 *   3. ROLE — may this person see it. company_admin sees everything in its workspace; a workshop's
 *      branch_manager sees everything in the workshop module; everyone else must be listed on the
 *      page in app_page_roles.
 *
 * WHY THE TWO MANAGERS ARE NOT THE SAME WILDCARD. "The workspace manager sees every page and so
 * does the workshop manager" is true of each within their OWN domain, and reading it as one flat
 * wildcard would have handed branch managers the Pricing Engine, Profit Percentages and Users &
 * Permissions — all company_admin-only today. A manager sees all of what they manage, not all of
 * everything, so branch_manager is a wildcard over module='workshop' and nothing else.
 */
@Injectable()
export class NavService {
  constructor(private readonly dbService: DbService) {}

  async resolve(ctx: RlsContext & { persona: string; role: string | null; unscoped: boolean }) {
    const persona = ctx.unscoped && ctx.persona === "platform" ? "platform_system" : ctx.persona;

    return this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      async (tx) => {
        // Which counterparty families this workspace actually has. Platform staff with no workspace
        // selected are looking ACROSS workspaces, so nothing is gated for them — gating the unscoped
        // view on links a single workspace happens to have would hide the very pages used to create
        // the first one.
        const modules = new Set<string>(["core"]);
        if (ctx.tenantId) {
          const linked = (await tx.execute(sql`
            select 'workshop' as m from tenant_workshops where tenant_id = ${ctx.tenantId}::uuid and status = 'active'
            union select 'vendor' from tenant_vendors where tenant_id = ${ctx.tenantId}::uuid and status = 'active'
            union select case when sp.scope = 'internal' then 'internal' else 'service_provider' end
              from tenant_service_providers tsp join service_providers sp on sp.id = tsp.service_provider_id
              where tsp.tenant_id = ${ctx.tenantId}::uuid and tsp.status = 'active'`)) as Array<{ m: string }>;
          for (const r of linked) modules.add(r.m);
        } else {
          for (const m of ["workshop", "vendor", "service_provider", "internal"]) modules.add(m);
        }

        const rows = (await tx.execute(sql`
          select p.key, p.module, p.path, p.label, p.icon, p.group_heading, p.sort_order, p.is_built,
                 p.parent_key,
                 coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
          from app_pages p
          left join app_page_roles r on r.page_key = p.key
          where p.persona = ${persona}
          group by p.key
          order by p.sort_order`)) as Array<{
          key: string; module: string; path: string; label: string; icon: string;
          group_heading: string; sort_order: number; is_built: boolean; parent_key: string | null; roles: string[];
        }>;

        /**
         * A counterparty's role comes from the guard only when a workspace is resolved: without
         * X-Tenant, `ctx.role` is null and a vendor would be handed an EMPTY sidebar — not a
         * restricted one, an unusable one. Who they are does not depend on which workspace happens
         * to be selected, so the persona supplies the role when the request did not.
         */
        const PORTAL_ROLE: Record<string, string> = {
          vendor: "vendor", workshop: "workshop",
          service_provider: "service_provider", internal: "service_provider",
        };
        const role = ctx.role ?? PORTAL_ROLE[persona] ?? null;
        const visible = rows.filter((p) => {
          if (!modules.has(p.module)) return false;
          if (role === "company_admin" || role === "super_admin") return true;
          if (role === "branch_manager" && p.module === "workshop") return true;
          return role != null && p.roles.includes(role);
        });

        /**
         * A CHILD WHOSE PARENT IS HIDDEN IS PROMOTED, not dropped. The parent can disappear for a
         * reason that has nothing to do with the child — a role it does not grant, a module not
         * switched on — and silently deleting the child with it would take a page away from
         * somebody who is explicitly allowed it. It becomes a top-level row instead.
         */
        const shown = new Set(visible.map((p) => p.key));
        const item = (i: (typeof visible)[number]) => ({
          key: i.key, label: i.label, path: i.path, icon: i.icon, soon: !i.is_built,
          children: [] as Array<{ key: string; label: string; path: string; icon: string; soon: boolean }>,
        });
        const byKey = new Map(visible.map((p) => [p.key, item(p)]));
        const top = visible.filter((p) => !p.parent_key || !shown.has(p.parent_key));
        for (const p of visible) {
          if (p.parent_key && shown.has(p.parent_key)) byKey.get(p.parent_key)!.children.push(byKey.get(p.key)!);
        }

        // Regroup in catalog order. Built from the rows rather than a fixed list, so a heading that
        // loses every one of its pages disappears instead of leaving an empty divider behind.
        const groups: Array<{ heading: string; items: Array<ReturnType<typeof item>> }> = [];
        for (const p of top) {
          const last = groups[groups.length - 1];
          if (last && last.heading === p.group_heading) last.items.push(byKey.get(p.key)!);
          else groups.push({ heading: p.group_heading, items: [byKey.get(p.key)!] });
        }
        return { persona, modules: [...modules].sort(), groups };
      },
    );
  }
}
