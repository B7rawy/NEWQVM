import { Module } from "@nestjs/common";
import { DbModule } from "./db/db.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { NotificationsModule } from "./modules/notifications/notifications.module.js";
import { MeController } from "./modules/me/me.controller.js";
import { WorkspacesAdminController } from "./modules/admin/workspaces-admin.controller.js";
import { WorkspacesAdminService } from "./modules/admin/workspaces-admin.service.js";
import { OrgController } from "./modules/org/org.controller.js";
import { OrgService } from "./modules/org/org.service.js";
import { VendorsController } from "./modules/vendors/vendors.controller.js";
import { VendorsService } from "./modules/vendors/vendors.service.js";
import { UsersAdminController } from "./modules/admin/users-admin.controller.js";
import { UsersAdminService } from "./modules/admin/users-admin.service.js";
import { ImpersonationController } from "./modules/admin/impersonation.controller.js";
import { ImpersonationService } from "./modules/admin/impersonation.service.js";
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
import { ApprovalsController } from "./modules/approvals/approvals.controller.js";
import { ApprovalsService } from "./modules/approvals/approvals.service.js";
import { VendorSelfServiceController } from "./modules/vendor-selfservice/vendor-selfservice.controller.js";
import { VendorSelfServiceService } from "./modules/vendor-selfservice/vendor-selfservice.service.js";
import { VendorFinanceController } from "./modules/vendor-finance/vendor-finance.controller.js";
import { VendorFinanceService } from "./modules/vendor-finance/vendor-finance.service.js";
import { ShippingController } from "./modules/shipping/shipping.controller.js";
import { ShippingService } from "./modules/shipping/shipping.service.js";
import { WorkspacesController } from "./modules/workspaces/workspaces.controller.js";
import { CounterpartyController } from "./modules/counterparty/counterparty.controller.js";
import { CounterpartyService } from "./modules/counterparty/counterparty.service.js";
import { AccountController } from "./modules/account/account.controller.js";
import { AccountService } from "./modules/account/account.service.js";
import { VendorPortalController } from "./modules/vendor-portal/vendor-portal.controller.js";
import { VendorPortalService } from "./modules/vendor-portal/vendor-portal.service.js";

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
    ApprovalsController,
    VendorSelfServiceController,
    VendorFinanceController,
    ShippingController,
    WorkspacesAdminController,
    OrgController,
    VendorsController,
    UsersAdminController,
    ImpersonationController,
    CounterpartyController,
    AccountController,
    VendorPortalController,
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
    ApprovalsService,
    VendorSelfServiceService,
    VendorFinanceService,
    ShippingService,
    WorkspacesAdminService,
    OrgService,
    VendorsService,
    UsersAdminService,
    ImpersonationService,
    CounterpartyService,
    AccountService,
    VendorPortalService,
  ],
})
export class AppModule {}
