import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DbService, type RlsContext } from "../../db/db.service.js";

/**
 * Editing who sees which page, without a deploy.
 *
 * THESE ARE THE VALUES auth.guard.ts PUTS ON A REQUEST, not the membership_role enum. They look
 * similar and are not the same list: a counterparty user arrives as the bare "vendor", "workshop"
 * or "service_provider", while company_admin / branch_manager / service_advisor come from a
 * workspace membership. Seeding this from the enum instead of from the guard is what left the
 * vendor and workshop sidebars empty (see migration 0072) — a role nobody carries matches nothing.
 *
 * The map is the authority for the screen's checkboxes AND the server's validation, so the UI
 * cannot offer a role the server would reject, and neither can drift from what the guard emits.
 */
export const ROLES_BY_PERSONA: Record<string, string[]> = {
  platform: ["super_admin", "staff", "account_manager", "purchasing", "part_extractor"],
  platform_system: ["super_admin", "staff", "account_manager", "purchasing", "part_extractor"],
  workspace: ["company_admin", "branch_manager", "service_advisor"],
  // One role per counterparty portal, because that is all the guard distinguishes today. Finer
  // grain (a vendor ADMIN vs an ordinary vendor user) needs the guard to surface
  // vendor_users.is_vendor_admin first; until it does, offering it here would be a checkbox that
  // silently does nothing.
  workshop: ["workshop"],
  vendor: ["vendor"],
  service_provider: ["service_provider"],
  internal: ["service_provider"],
};

export const setRolesSchema = z.object({ roles: z.array(z.string()).max(20) });

@Injectable()
export class PagesAdminService {
  constructor(private readonly dbService: DbService) {}

  async list(ctx: RlsContext) {
    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      const rows = (await tx.execute(sql`
        select p.key, p.module, p.persona, p.path, p.label, p.icon, p.group_heading, p.sort_order, p.is_built,
               coalesce(array_agg(r.role) filter (where r.role is not null), '{}') as roles
        from app_pages p
        left join app_page_roles r on r.page_key = p.key
        group by p.key
        order by p.sort_order`)) as Array<Record<string, unknown>>;
      return { count: rows.length, pages: rows, rolesByPersona: ROLES_BY_PERSONA };
    });
  }

  /**
   * Replace a page's role list. An EMPTY list is allowed on purpose — it is how you take a page out
   * of circulation without deleting it — but it is not the trap it looks like: the resolver treats
   * company_admin and super_admin as wildcards over their own domain, so a workspace or platform
   * page with no roles is still reachable by the person who would need to put it back. A vendor or
   * workshop page emptied this way really does go dark for that portal, which is why the screen
   * says so in as many words before you save it.
   */
  async setRoles(ctx: RlsContext, key: string, dto: z.infer<typeof setRolesSchema>) {
    const persona = (
      (await this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, (tx) =>
        tx.execute(sql`select persona from app_pages where key = ${key} limit 1`),
      )) as Array<{ persona: string }>
    )[0]?.persona;
    if (!persona) throw new NotFoundException("page not found");

    const allowed = ROLES_BY_PERSONA[persona] ?? [];
    const roles = [...new Set(dto.roles)];
    const bad = roles.filter((r) => !allowed.includes(r));
    if (bad.length)
      throw new BadRequestException(`role(s) ${bad.join(", ")} do not exist in the ${persona} portal`);

    return this.dbService.withContext({ tenantId: null, userId: ctx.userId, isInternal: true }, async (tx) => {
      // Delete-then-insert inside ONE transaction. Done as two calls the page would be visible to
      // nobody for the instant in between, which for a sidebar is a user watching their menu blink.
      await tx.execute(sql`delete from app_page_roles where page_key = ${key}`);
      for (const r of roles) {
        await tx.execute(sql`insert into app_page_roles (page_key, role) values (${key}, ${r})`);
      }
      await tx.execute(sql`update app_pages set updated_at = now() where key = ${key}`);
      return { ok: true, key, roles };
    });
  }
}
