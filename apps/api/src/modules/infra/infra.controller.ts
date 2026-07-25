import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard.js";
import { RolesGuard } from "../../common/roles.guard.js";
import { PlatformOnly } from "../../common/roles.decorator.js";
import { getContext } from "../../common/request-context.js";
import { AuditService, CalendarService } from "./infra.service.js";

@Controller()
@UseGuards(AuthGuard, RolesGuard)
export class InfraController {
  constructor(
    private readonly audit: AuditService,
    private readonly calendar: CalendarService,
  ) {}
  private ctx(req: Request) {
    const c = getContext(req);
    if (!c.tenantId) throw new BadRequestException("no workspace resolved (subdomain / X-Tenant)");
    return { tenantId: c.tenantId, userId: c.userId, isInternal: c.isInternal, environment: c.environment, impersonatorId: c.impersonatorId };
  }

  @Get("audit-log")
  @PlatformOnly()
  auditLog(@Req() req: Request, @Query("entityType") et?: string, @Query("entityId") ei?: string) {
    return this.audit.query(this.ctx(req), et, ei);
  }

  @Get("calendar")
  calendar_(@Req() req: Request) {
    return this.calendar.getSettings(this.ctx(req));
  }

  @Post("calendar/working-days")
  @PlatformOnly()
  setDays(@Req() req: Request, @Body() body: unknown) {
    const dto = z.object({ workingDays: z.array(z.number().int().min(0).max(6)) }).parse(body);
    return this.calendar.setSettings(this.ctx(req), dto.workingDays);
  }

  @Post("calendar/holidays")
  @PlatformOnly()
  addHoliday(@Req() req: Request, @Body() body: unknown) {
    const dto = z.object({ date: z.string(), name: z.string().optional() }).parse(body);
    return this.calendar.addHoliday(this.ctx(req), dto.date, dto.name);
  }

  @Get("calendar/deadline")
  deadline(@Req() req: Request, @Query("from") from: string, @Query("days") days: string) {
    const d = Number(days);
    if (!from || !Number.isFinite(d)) throw new BadRequestException("from and days required");
    return this.calendar.computeDeadline(this.ctx(req), from, d);
  }
}
