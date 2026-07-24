import {
  LayoutDashboard,
  FilePlus2,
  Files,
  ShoppingCart,
  Truck,
  Receipt,
  Undo2,
  Store,
  Percent,
  BarChart3,
  CalendarClock,
  Users,
  History,
  Webhook,
  UserCircle,
  LineChart,
  Wallet,
  Banknote,
  Building2,
  Wrench,
  Boxes,
  Gauge,
  Handshake,
  PackageSearch,
  CheckCircle,
  FileText,
  Target,
  SlidersHorizontal,
  ClipboardList,
  ClipboardCheck,
  UserPlus,
  Settings,
  type LucideIcon,
} from "lucide-react";

export type Persona = "platform" | "workspace" | "vendor" | "workshop" | "service_provider";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  soon?: boolean;
  superAdminOnly?: boolean; // platform portal — only super_admin
  adminOnly?: boolean; // workspace portal — only company_admin (the manager)
}
export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** Platform portal — Qparts staff (super admin + service roles), cross-workspace. */
export const platformNav: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
      { label: "Internal Dashboard", path: "/internal", icon: Boxes },
      { label: "Management Overview", path: "/management-overview", icon: Gauge },
    ],
  },
  {
    heading: "Procurement",
    items: [
      { label: "RFQs Dashboard", path: "/rfqs", icon: Files },
      { label: "Orders Dashboard", path: "/orders", icon: ShoppingCart },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true },
    ],
  },
  {
    heading: "Services",
    items: [
      { label: "Pricing Engine", path: "/pricing", icon: Percent, soon: true },
      { label: "Profit Percentages", path: "/profit", icon: BarChart3, soon: true },
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true },
    ],
  },
  {
    heading: "Master data",
    items: [
      { label: "Vendors", path: "/vendors", icon: Store },
      { label: "Workshops", path: "/org/workshops", icon: Wrench },
      { label: "Providers", path: "/providers", icon: Handshake },
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Workspaces", path: "/admin/workspaces", icon: Building2, superAdminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Onboarding review", path: "/onboarding/review", icon: ClipboardCheck },
      { label: "Status Logs", path: "/status-logs", icon: History, soon: true },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
    ],
  },
];

/**
 * Platform SYSTEM view — what a super admin controls across the WHOLE platform when no workspace is
 * selected ("All workspaces" / unscoped). Focused on platform administration, not one workspace's
 * day-to-day. (When a platform user enters a specific workspace subdomain they get `platformNav`.)
 */
export const platformSystemNav: NavGroup[] = [
  {
    heading: "Platform",
    items: [
      { label: "Management Overview", path: "/management-overview", icon: Gauge },
      { label: "Internal Dashboard", path: "/internal", icon: Boxes },
    ],
  },
  {
    heading: "Control tower",
    items: [
      { label: "Workspaces", path: "/admin/workspaces", icon: Building2, superAdminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Onboarding review", path: "/onboarding/review", icon: ClipboardCheck },
    ],
  },
  {
    heading: "Master data",
    items: [
      { label: "Vendors", path: "/vendors", icon: Store },
      { label: "Workshops", path: "/org/workshops", icon: Wrench },
      { label: "Providers", path: "/providers", icon: Handshake },
    ],
  },
  {
    heading: "System",
    items: [
      { label: "Status Logs", path: "/status-logs", icon: History, soon: true },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
      { label: "Settings", path: "/settings", icon: Settings },
    ],
  },
];

/**
 * Workspace portal — the manager (company_admin) runs the whole procurement operation for ONE
 * workspace. Non-admin workspace users (branch managers / service advisors) see the ungated core;
 * the management dashboards, reports/pricing and setup/master-data are `adminOnly` (the manager).
 */
export const workspaceNav: NavGroup[] = [
  {
    heading: "Dashboard",
    items: [
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
      { label: "Management Overview", path: "/management-overview", icon: Gauge, adminOnly: true },
      { label: "Internal Dashboard", path: "/internal", icon: Boxes, adminOnly: true },
    ],
  },
  {
    heading: "Procurement",
    items: [
      { label: "New RFQ", path: "/rfq-new", icon: FilePlus2 },
      { label: "RFQs Dashboard", path: "/rfqs", icon: Files },
      { label: "Orders Dashboard", path: "/orders", icon: ShoppingCart },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true },
      { label: "Closed Orders", path: "/closed", icon: CheckCircle, soon: true },
    ],
  },
  {
    heading: "Finance",
    items: [
      { label: "Purchase & Return Invoices", path: "/purchase-invoices", icon: Receipt, soon: true },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true },
      { label: "Delivery & Return Notes", path: "/notes", icon: FileText, soon: true },
      { label: "Statements", path: "/statements", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Reports & pricing",
    items: [
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true, adminOnly: true },
      { label: "Parts Pricing Report", path: "/parts-pricing-report", icon: BarChart3, soon: true, adminOnly: true },
      { label: "Targets", path: "/targets", icon: Target, soon: true, adminOnly: true },
      { label: "Profit Percentages", path: "/profit", icon: Percent, soon: true, adminOnly: true },
      { label: "Pricing Engine", path: "/pricing", icon: SlidersHorizontal, soon: true, adminOnly: true },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Add supplier / workshop", path: "/onboarding", icon: UserPlus, adminOnly: true },
      { label: "Workshops & Branches", path: "/org/workshops", icon: Wrench, adminOnly: true },
      { label: "Vendors", path: "/vendors", icon: Store, adminOnly: true },
      { label: "Providers", path: "/providers", icon: Handshake, adminOnly: true },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true, adminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users, adminOnly: true },
      { label: "Status Logs", path: "/status-logs", icon: History, soon: true, adminOnly: true },
      { label: "Settings", path: "/settings", icon: Settings, adminOnly: true },
    ],
  },
];

/** Vendor portal — a supplier, across every workspace it's linked to. */
export const vendorNav: NavGroup[] = [
  {
    heading: "Sales",
    items: [
      { label: "Overview", path: "/vendor", icon: LayoutDashboard },
      { label: "Quotation Requests", path: "/vendor/quotations", icon: Files },
      { label: "Confirmed Orders", path: "/vendor/confirmed", icon: ShoppingCart, soon: true },
    ],
  },
  {
    heading: "Fulfillment & finance",
    items: [
      { label: "Deliveries", path: "/vendor/deliveries", icon: Truck, soon: true },
      { label: "Invoices", path: "/vendor/invoices", icon: Receipt, soon: true },
      { label: "Returns & Exchanges", path: "/vendor/returns", icon: Undo2, soon: true },
      { label: "Statement & Payments", path: "/vendor/statement", icon: Wallet, soon: true },
      { label: "Invoice Financing", path: "/vendor/financing", icon: Banknote, soon: true },
    ],
  },
  {
    heading: "Growth",
    items: [
      { label: "Parts Catalog", path: "/vendor/catalog", icon: PackageSearch, soon: true },
      { label: "Online Store", path: "/vendor/store", icon: Store, soon: true },
      { label: "Market Index", path: "/vendor/market-index", icon: LineChart, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Vendor Profile", path: "/vendor/profile", icon: UserCircle },
      { label: "Branches & Users", path: "/vendor/branches", icon: Building2, soon: true },
      { label: "Settings", path: "/vendor/settings", icon: Settings, soon: true },
    ],
  },
];

/** Workshop portal — the customer (a repair shop) that requests parts and receives them. */
export const workshopNav: NavGroup[] = [
  {
    heading: "Overview",
    items: [{ label: "Dashboard", path: "/workshop", icon: LayoutDashboard }],
  },
  {
    heading: "Request parts",
    items: [
      { label: "New Request", path: "/workshop/requests/new", icon: FilePlus2 },
      { label: "My Requests", path: "/workshop/requests", icon: Files },
    ],
  },
  {
    heading: "Orders & deliveries",
    items: [
      { label: "My Orders", path: "/orders", icon: ShoppingCart, soon: true },
      { label: "Deliveries", path: "/deliveries", icon: Truck, soon: true },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true },
    ],
  },
  {
    heading: "Billing",
    items: [
      { label: "Invoices", path: "/invoices", icon: Receipt, soon: true },
      { label: "Statement & Payments", path: "/statement", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Branches", path: "/workshop/branches", icon: Building2 },
      { label: "Users & Permissions", path: "/admin/users", icon: Users, soon: true },
      { label: "Settings", path: "/settings", icon: UserCircle, soon: true },
    ],
  },
];

/** Service-provider portal — internal/external providers. Scaffolded (coming soon) for now. */
export const providerNav: NavGroup[] = [
  {
    heading: "Provider",
    items: [
      { label: "Overview", path: "/provider", icon: LayoutDashboard, soon: true },
      { label: "Assignments", path: "/provider/assignments", icon: ClipboardList, soon: true },
      { label: "Invoices", path: "/provider/invoices", icon: Receipt, soon: true },
      { label: "Profile", path: "/provider/profile", icon: UserCircle, soon: true },
    ],
  },
];

/** Pick + filter the nav tree for the resolved persona and role. */
export function navForPersona(
  persona: Persona,
  opts: { isSuperAdmin?: boolean; isCompanyAdmin?: boolean; unscoped?: boolean },
): NavGroup[] {
  if (persona === "vendor") return vendorNav;
  if (persona === "workshop") return workshopNav;
  if (persona === "service_provider") return providerNav;
  if (persona === "platform") {
    // No workspace selected → the system (super-admin) view; inside a workspace → the full nav.
    const tree = opts.unscoped ? platformSystemNav : platformNav;
    return tree
      .map((g) => ({ ...g, items: g.items.filter((it) => !it.superAdminOnly || opts.isSuperAdmin) }))
      .filter((g) => g.items.length);
  }
  // workspace
  return workspaceNav
    .map((g) => ({ ...g, items: g.items.filter((it) => !it.adminOnly || opts.isCompanyAdmin) }))
    .filter((g) => g.items.length);
}
