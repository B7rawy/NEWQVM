import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { requireTenantCtx } from "../../common/request-context.js";
import { z } from "zod";
import { CreateRfqDto, createRfqSchema, RfqService } from "./rfq.service.js";
import { sendRfqSchema, VendorRfqService } from "./vendor-rfq.service.js";

const selectWinnerSchema = z.object({ quoteItemId: z.string().uuid() });

/**
 * RFQ domain — the entry point of the order chain. All tenant-scoped by RLS.
 * Create is limited to workshop roles (+ platform staff); vendors cannot create RFQs.
 */
@Controller("rfqs")
@UseGuards(AuthGuard, RolesGuard)
export class RfqController {
  constructor(
    private readonly rfq: RfqService,
    private readonly vendorRfq: VendorRfqService,
  ) {}

  @Get()
  list(@Req() req: Request) {
    // scope the list to the ACTIVE workspace even for platform staff (isInternal:false) — the
    // "see all workspaces" privilege is the switcher, not a merged single-workspace view.
    // ?queue= is OPT-IN: without it the query is byte-identical to before routing existed.
    return this.rfq.list({ ...requireTenantCtx(req), isInternal: false }, req.query.queue as string | undefined);
  }

  @Get(":id")
  detail(@Req() req: Request, @Param("id") id: string) {
    return this.rfq.detail({ ...requireTenantCtx(req), isInternal: false }, id);
  }

  @Post()
  @Roles("company_admin", "branch_manager", "service_advisor")
  create(@Req() req: Request, @Body() body: unknown) {
    const dto: CreateRfqDto = createRfqSchema.parse(body);
    return this.rfq.create(requireTenantCtx(req), dto);
  }

  /** Send the RFQ to vendors — internal (purchasing) action; each send is a guarded notification. */
  @Post(":id/send")
  @PlatformOnly()
  send(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.vendorRfq.send(requireTenantCtx(req), id, sendRfqSchema.parse(body));
  }

  /** Vendor-quote comparison view (purchasing). */
  @Get(":id/quotes")
  @PlatformOnly()
  quotes(@Req() req: Request, @Param("id") id: string) {
    return this.vendorRfq.getQuotes(requireTenantCtx(req), id);
  }

  /** Pick the winning quote for an item (old cost_id) — purchasing. */
  @Post(":id/items/:itemId/winning-quote")
  @PlatformOnly()
  selectWinner(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() body: unknown,
  ) {
    const { quoteItemId } = selectWinnerSchema.parse(body);
    return this.vendorRfq.selectWinner(requireTenantCtx(req), id, itemId, quoteItemId);
  }
}
