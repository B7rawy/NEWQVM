import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly, Roles } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
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
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.rfq.list({ tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal });
  }

  @Post()
  @Roles("company_admin", "branch_manager", "service_advisor")
  create(@Req() req: Request, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    const dto: CreateRfqDto = createRfqSchema.parse(body);
    return this.rfq.create(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      dto,
    );
  }

  /** Send the RFQ to vendors — internal (purchasing) action; each send is a guarded notification. */
  @Post(":id/send")
  @PlatformOnly()
  send(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.vendorRfq.send(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
      sendRfqSchema.parse(body),
    );
  }

  /** Vendor-quote comparison view (purchasing). */
  @Get(":id/quotes")
  @PlatformOnly()
  quotes(@Req() req: Request, @Param("id") id: string) {
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return this.vendorRfq.getQuotes(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
    );
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
    const ctx = getContext(req);
    if (!ctx.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    const { quoteItemId } = selectWinnerSchema.parse(body);
    return this.vendorRfq.selectWinner(
      { tenantId: ctx.tenantId, userId: ctx.userId, isInternal: ctx.isInternal },
      id,
      itemId,
      quoteItemId,
    );
  }
}
