import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../../common/auth.guard.js";
import { getContext } from "../../common/request-context.js";
import { z } from "zod";
import { createRequestSchema, WorkshopPortalService } from "./workshop-portal.service.js";

const addItemSchema = z.object({
  partNumber: z.string().max(64).optional(),
  partDescription: z.string().max(256).optional(),
  quantity: z.number().int().positive().default(1),
  brandClassId: z.string().uuid().optional(),
}).refine((v) => v.partNumber || v.partDescription, { message: "part number or description is required" });
const cancelSchema = z.object({ reasonId: z.string().uuid().optional(), note: z.string().max(300).optional() });
const returnSchema = z.object({ qty: z.number().int().positive(), reasonId: z.string().uuid().optional(), note: z.string().max(300).optional() });
const confirmItemsSchema = z.object({
  items: z.array(z.object({ rfqItemId: z.string().uuid(), approvedQty: z.number().int().min(1).optional() })).min(1),
});
const clientPoSchema = z.object({ clientPo: z.string().max(64).nullable() });
const noteSchema = z.object({ entityType: z.enum(["rfq", "order"]), entityId: z.string().uuid(), body: z.string().min(1).max(2000) });

/**
 * Workshop portal (cross-workspace). AuthGuard only — the service scopes by workshop ownership
 * (workshop_users) and 403s a non-workshop; no tenant/role context needed.
 */
@Controller("workshop")
@UseGuards(AuthGuard)
export class WorkshopPortalController {
  constructor(private readonly svc: WorkshopPortalService) {}
  private ctx(req: Request) {
    const c = getContext(req);
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Get("overview")
  overview(@Req() req: Request) {
    return this.svc.overview(this.ctx(req));
  }

  @Get("requests")
  requests(@Req() req: Request) {
    return this.svc.requests(this.ctx(req), "workshop_requests");
  }

  @Get("context")
  context(@Req() req: Request) {
    return this.svc.context(this.ctx(req));
  }

  @Get("branches")
  branches(@Req() req: Request) {
    return this.svc.branches(this.ctx(req));
  }

  @Get("orders")
  orders(@Req() req: Request) {
    return this.svc.orders(this.ctx(req), "workshop_orders");
  }

  @Get("requests/:id")
  requestDetail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.requestDetail(this.ctx(req), id);
  }

  @Post("requests")
  createRequest(@Req() req: Request, @Body() body: unknown) {
    return this.svc.createRequest(this.ctx(req), createRequestSchema.parse(body));
  }

  /* ── the ported legacy actions (docs/legacy/workshop-logic.md) ────────────────────────────── */

  @Get("lists")
  lists(@Req() req: Request) {
    return this.svc.lists(this.ctx(req));
  }

  @Post("requests/:id/items")
  addItem(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.addItem(this.ctx(req), id, addItemSchema.parse(body));
  }

  @Post("requests/:id/items/:itemId/cancel")
  requestCancel(@Req() req: Request, @Param("id") id: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.svc.requestCancel(this.ctx(req), id, itemId, cancelSchema.parse(body ?? {}));
  }

  @Post("requests/:id/confirm")
  confirmItems(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.confirmItems(this.ctx(req), id, confirmItemsSchema.parse(body).items);
  }

  @Get("orders/:id")
  orderDetail(@Req() req: Request, @Param("id") id: string) {
    return this.svc.orderDetail(this.ctx(req), id);
  }

  @Post("orders/:id/client-po")
  setClientPo(@Req() req: Request, @Param("id") id: string, @Body() body: unknown) {
    return this.svc.setClientPo(this.ctx(req), id, clientPoSchema.parse(body).clientPo);
  }

  @Post("orders/:id/items/:itemId/return")
  requestReturn(@Req() req: Request, @Param("id") id: string, @Param("itemId") itemId: string, @Body() body: unknown) {
    return this.svc.requestReturn(this.ctx(req), id, itemId, returnSchema.parse(body));
  }

  @Get("invoices")
  invoices(@Req() req: Request) {
    return this.svc.invoices(this.ctx(req));
  }

  @Get("statement")
  statement(@Req() req: Request) {
    return this.svc.statement(this.ctx(req));
  }

  @Get("notes")
  notes(@Req() req: Request) {
    const q = req.query as { entityType?: "rfq" | "order"; entityId?: string };
    return this.svc.notes(this.ctx(req), q.entityType, q.entityId);
  }

  @Post("notes")
  addNote(@Req() req: Request, @Body() body: unknown) {
    return this.svc.addNote(this.ctx(req), noteSchema.parse(body));
  }

  @Get("exceptions")
  myExceptions(@Req() req: Request) {
    const k = (req.query as { kind?: "cancellation" | "return" }).kind;
    return this.svc.myExceptions(this.ctx(req), k);
  }

  @Get("profile")
  profile(@Req() req: Request) {
    return this.svc.profile(this.ctx(req));
  }
}
