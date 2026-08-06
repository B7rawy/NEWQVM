import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { Roles } from "../../common/roles.decorator.js";
import { requireTenantCtx } from "../../common/request-context.js";
import { z } from "zod";
import { OrdersService } from "./orders.service.js";

/** Optional cart body — absent keeps the whole-RFQ behaviour byte-compatible. */
const confirmSchema = z
  .object({
    items: z
      .array(z.object({ rfqItemId: z.string().uuid(), approvedQty: z.number().int().min(1).optional() }))
      .min(1)
      .optional(),
  })
  .optional();

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /** Confirm an RFQ into an order — customer-side action (workshop roles) or platform staff. */
  @Post("rfqs/:id/confirm")
  @Roles("company_admin", "branch_manager", "service_advisor")
  confirm(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.orders.confirm(requireTenantCtx(req), id, confirmSchema.parse(body ?? undefined));
  }

  @Get("orders")
  list(@Req() req: Request) {
    // scope to the active workspace even for platform staff (see rfq.controller note)
    // ?queue= is OPT-IN: without it the query is byte-identical to before routing existed.
    return this.orders.list({ ...requireTenantCtx(req), isInternal: false }, req.query.queue as string | undefined);
  }
}
