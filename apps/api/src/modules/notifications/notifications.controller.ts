import { Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard.js";
import { requireTenantCtx } from "../../common/request-context.js";
import { listQuerySchema, NotificationsService } from "./notifications.service.js";

/** The id reaches a `::uuid` cast, and an unparseable one would surface as a 500 rather than a 400. */
const idSchema = z.string().uuid();

/**
 * MY IN-APP INBOX.
 *
 * No roles guard and no PlatformOnly, deliberately: a notification is addressed to a person, so the
 * only authorisation question is "are you that person", and the answer comes from the signed-in
 * identity rather than from a role. Every route below resolves the recipient from the session and
 * never from the request — there is no user-id parameter anywhere in this file, because the moment
 * one exists somebody can ask for somebody else's inbox and the RESTRICTIVE policy in migration 0061
 * becomes the only thing standing between them and it. Two locks are better, but one of them should
 * not be load-bearing on its own.
 *
 * A WORKSPACE IS REQUIRED. Notifications are tenant-scoped, so "my notifications" only has an answer
 * inside a workspace. requireTenantCtx() 400s without one rather than quietly answering 0, which
 * would read on screen as "you have nothing waiting" — a false statement dressed as a calm one.
 */
@Controller("notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    return this.svc.list(requireTenantCtx(req), listQuerySchema.parse(query ?? {}));
  }

  /** The badge's single source of truth. Hot path — one indexed count, see the service. */
  @Get("unread-count")
  unreadCount(@Req() req: Request) {
    return this.svc.unreadCount(requireTenantCtx(req));
  }

  @Post(":id/read")
  markRead(@Req() req: Request, @Param("id") id: string) {
    return this.svc.markRead(requireTenantCtx(req), idSchema.parse(id));
  }

  @Post("read-all")
  markAllRead(@Req() req: Request) {
    return this.svc.markAllRead(requireTenantCtx(req));
  }
}
