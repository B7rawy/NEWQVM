import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import {
  createCarrierSchema,
  createShipmentSchema,
  registerDriverSchema,
  ShippingService,
} from "./shipping.service.js";

/** Shipping / logistics (QNEW-54/55) — internal configuration + dispatch. */
@Controller("shipping")
@UseGuards(AuthGuard, RolesGuard)
export class ShippingController {
  constructor(private readonly svc: ShippingService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal };
  }

  @Post("carriers")
  @PlatformOnly()
  createCarrier(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createCarrier(this.ctx(req), createCarrierSchema.parse(body));
  }

  @Get("carriers")
  listCarriers(@Req() req: Request) {
    return this.svc.listCarriers(this.ctx(req));
  }

  @Post("shipments")
  @PlatformOnly()
  createShipment(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createShipment(this.ctx(req), createShipmentSchema.parse(body));
  }

  @Post("drivers")
  @PlatformOnly()
  registerDriver(@Req() req: Request, @Body() body: unknown) {
    return this.svc.registerDriver(this.ctx(req), registerDriverSchema.parse(body));
  }

  @Post("orders/:id/broadcast")
  @PlatformOnly()
  broadcast(@Req() req: Request, @Param("id") id: string) {
    return this.svc.broadcast(this.ctx(req), id);
  }

  @Post("delivery-requests/:id/accept")
  @PlatformOnly()
  accept(@Req() req: Request, @Param("id") id: string) {
    return this.svc.accept(this.ctx(req), id);
  }
}
