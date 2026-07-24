import { BadRequestException, Body, Controller, Post, Query, Req, UseGuards, Get } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { PricingService, setBasisSchema } from "./pricing.service.js";

const agencyPriceSchema = z.object({
  partNumber: z.string().min(1),
  price: z.number().finite().nonnegative(),
  source: z.string().optional(),
});
const computeQuerySchema = z.object({
  cost: z.coerce.number().finite().nonnegative(),
  scenario: z.enum(["cash_client", "credit_client", "insurance"]).default("cash_client"),
});

/** Pricing engine (QNEW-30). Configuration is internal (pricing supervisor / platform). */
@Controller("pricing")
@UseGuards(AuthGuard, RolesGuard)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Post("basis")
  @PlatformOnly()
  setBasis(@Req() req: Request, @Body() body: unknown) {
    return this.pricing.setBasis(this.ctx(req), setBasisSchema.parse(body));
  }

  @Post("agency-price")
  @PlatformOnly()
  agencyPrice(@Req() req: Request, @Body() body: unknown) {
    const dto = agencyPriceSchema.parse(body);
    return this.pricing.upsertAgencyPrice(this.ctx(req), dto.partNumber, dto.price, dto.source);
  }

  /** Preview a computed selling price for a given cost + scenario. */
  @Get("compute")
  @PlatformOnly()
  compute(@Req() req: Request, @Query("cost") cost: string, @Query("scenario") scenario?: string) {
    const q = computeQuerySchema.parse({ cost, scenario });
    return this.pricing.compute(this.ctx(req), { cost: q.cost, payerScenario: q.scenario });
  }
}
