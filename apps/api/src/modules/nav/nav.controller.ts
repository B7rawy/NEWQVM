import { BadRequestException, Controller, ForbiddenException, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { resolvePersona, type Persona } from "../../common/persona.helpers.js";
import { DbService } from "../../db/db.service.js";
import { NavService } from "./nav.service.js";

/** The sidebar this user gets. See NavService for the three questions that decide it. */
/** Which role each portal's typical user carries — see the persona map in persona.helpers.ts. */
const PREVIEW_ROLE: Record<string, string | null> = {
  platform: null,          // keep the previewer's own platform role
  platform_system: null,
  workspace: "company_admin",
  workshop: "workshop",
  vendor: "vendor",
  service_provider: "service_provider",
  internal: "service_provider",
};

@Controller("nav")
@UseGuards(AuthGuard)
export class NavController {
  constructor(
    private readonly svc: NavService,
    private readonly dbService: DbService,
  ) {}

  /**
   * `?persona=` — "show me what a workspace manager sees". PLATFORM STAFF ONLY, and refused for
   * everyone else rather than ignored, because silently answering with your own tree would be a
   * privilege check that looks like it passed.
   *
   * It exists because the shell's portal preview used to render the STATIC tree, which knows nothing
   * about which counterparties a workspace has linked. Previewing an EMPTY workspace therefore
   * showed New RFQ, Vendors, Providers and Internal — every one of which a real manager there would
   * not see. A preview that contradicts the product is worse than no preview.
   *
   * The role is the one that persona's typical user carries, so the answer matches what that person
   * would actually get: a workspace preview is the MANAGER's view, which is what the switcher says.
   */
  @Get()
  async nav(@Req() req: Request, @Query("persona") preview?: string) {
    const ctx = getContext(req);
    const { persona: real } = await this.dbService.withContext(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: true },
      (tx) => resolvePersona(tx, ctx.userId, ctx.isInternal),
    );

    let persona = real;
    let role = ctx.role ?? null;
    if (preview) {
      if (!ctx.isInternal) throw new ForbiddenException("previewing another portal is restricted to platform staff");
      if (!(preview in PREVIEW_ROLE)) throw new BadRequestException(`unknown portal '${preview}'`);
      persona = preview as Persona;
      role = PREVIEW_ROLE[preview] ?? role;
    }

    return this.svc.resolve({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      isInternal: ctx.isInternal,
      persona,
      role,
      // no workspace chosen → the platform-wide tree, matching what the shell already did. A preview
      // names its own persona, so it must not be re-mapped underneath it.
      unscoped: !preview && !ctx.tenantId,
    });
  }
}
