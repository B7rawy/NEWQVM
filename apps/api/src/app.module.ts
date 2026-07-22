import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { MeController } from "./modules/me/me.controller.js";
import { RfqController } from "./modules/rfq/rfq.controller.js";
import { WorkspacesController } from "./modules/workspaces/workspaces.controller.js";

/**
 * Root module. Domain modules are added one per area as they are built (CONVENTIONS §BE-1).
 * DbModule is global; AuthModule provides the JWT + AuthGuard used across tenant-scoped routes.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [MeController, RfqController, WorkspacesController],
})
export class AppModule {}
