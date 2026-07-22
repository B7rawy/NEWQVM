import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { MeController } from "./modules/me/me.controller.js";
import { RfqController } from "./modules/rfq/rfq.controller.js";
import { RfqService } from "./modules/rfq/rfq.service.js";
import { VendorRfqService } from "./modules/rfq/vendor-rfq.service.js";
import { QuoteAccessController } from "./modules/rfq/quote-access.controller.js";
import { WorkspacesController } from "./modules/workspaces/workspaces.controller.js";

/**
 * Root module. Domain modules are added one per area as they are built (CONVENTIONS §BE-1).
 * DbModule + NotificationsModule are global; AuthModule provides JWT + AuthGuard + RolesGuard.
 */
@Module({
  imports: [DbModule, NotificationsModule, AuthModule],
  controllers: [MeController, RfqController, WorkspacesController, QuoteAccessController],
  providers: [RfqService, VendorRfqService],
})
export class AppModule {}
