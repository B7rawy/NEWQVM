import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { MeController } from "./modules/me/me.controller.js";
import { RfqController } from "./modules/rfq/rfq.controller.js";
import { RfqService } from "./modules/rfq/rfq.service.js";
import { VendorRfqService } from "./modules/rfq/vendor-rfq.service.js";
import { QuoteAccessController } from "./modules/rfq/quote-access.controller.js";
import { OrdersController } from "./modules/orders/orders.controller.js";
import { OrdersService } from "./modules/orders/orders.service.js";
import { PurchasingController } from "./modules/purchasing/purchasing.controller.js";
import { PurchasingService } from "./modules/purchasing/purchasing.service.js";
import { DeliveryController } from "./modules/delivery/delivery.controller.js";
import { DeliveryService } from "./modules/delivery/delivery.service.js";
import { InvoiceController } from "./modules/invoicing/invoice.controller.js";
import { InvoiceService } from "./modules/invoicing/invoice.service.js";
import { ReturnsController } from "./modules/returns/returns.controller.js";
import { ReturnsService } from "./modules/returns/returns.service.js";
import { PartsController } from "./modules/parts/parts.controller.js";
import { PartsService } from "./modules/parts/parts.service.js";
import { PricingController } from "./modules/pricing/pricing.controller.js";
import { PricingService } from "./modules/pricing/pricing.service.js";
import { InsuranceController } from "./modules/insurance/insurance.controller.js";
import { InsuranceService } from "./modules/insurance/insurance.service.js";
import { VendorAssignmentController } from "./modules/vendor-assignment/vendor-assignment.controller.js";
import { VendorAssignmentService } from "./modules/vendor-assignment/vendor-assignment.service.js";
import { InfraController } from "./modules/infra/infra.controller.js";
import { AuditService, CalendarService } from "./modules/infra/infra.service.js";
import { WorkspacesController } from "./modules/workspaces/workspaces.controller.js";

/**
 * Root module. Domain modules are added one per area as they are built (CONVENTIONS §BE-1).
 * DbModule + NotificationsModule are global; AuthModule provides JWT + AuthGuard + RolesGuard.
 */
@Module({
  imports: [DbModule, NotificationsModule, AuthModule],
  controllers: [
    MeController,
    RfqController,
    WorkspacesController,
    QuoteAccessController,
    OrdersController,
    PurchasingController,
    DeliveryController,
    InvoiceController,
    ReturnsController,
    PartsController,
    PricingController,
    InsuranceController,
    VendorAssignmentController,
    InfraController,
  ],
  providers: [
    RfqService,
    VendorRfqService,
    OrdersService,
    PurchasingService,
    DeliveryService,
    InvoiceService,
    ReturnsService,
    PartsService,
    PricingService,
    InsuranceService,
    VendorAssignmentService,
    AuditService,
    CalendarService,
  ],
})
export class AppModule {}
