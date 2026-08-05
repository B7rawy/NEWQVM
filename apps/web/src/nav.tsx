import {
  GitBranch,
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
  Inbox,

  Stamp,} from "lucide-react";

/**
 * NAME → COMPONENT. /nav returns an icon NAME, because a database column cannot hold a React
 * component. This is the only place that mapping exists, and it is built from the same names the
 * static trees below use, so any page seeded from those trees can always be drawn.
 *
 * A name with no entry falls back to a generic glyph rather than throwing: losing one icon is a
 * blemish, losing the whole sidebar is being locked out of the product.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  Banknote,
  BarChart3,
  Boxes,
  Building2,
  CalendarClock,
  CheckCircle,
  ClipboardCheck,
  ClipboardList,
  FilePlus2,
  FileText,
  Files,
  Gauge,
  GitBranch,
  Handshake,
  History,
  Inbox,
  LayoutDashboard,
  LineChart,
  PackageSearch,
  Percent,
  Receipt,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Stamp,
  Store,
  Target,
  Truck,
  Undo2,
  UserCircle,
  UserPlus,
  Users,
  Wallet,
  Webhook,
  Wrench,
};
export const iconByName = (name: string): LucideIcon => NAV_ICONS[name] ?? LayoutDashboard;

export type Persona = "platform" | "workspace" | "vendor" | "workshop" | "service_provider" | "internal";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** One level only — see migration 0073, where the database refuses a third. */
  children?: Array<{ label: string; path: string; icon: LucideIcon; soon?: boolean }>;
  soon?: boolean;
  superAdminOnly?: boolean; // platform portal — only super_admin
  adminOnly?: boolean; // workspace portal — only company_admin (the manager)
}
export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** Platform portal — Qparts staff (super admin + service roles), cross-workspace. */
/* ─────────────────────────────────────────────────────────────────────────────────────────────
   GENERATED FROM app_pages. Do not hand-edit — the next regeneration overwrites it.

   These trees are the FALLBACK the shell renders when /nav cannot be reached. The database has
   been the source of truth since migration 0069, and the reconciliation migrations that followed
   moved it; regenerating keeps the offline copy telling the same story as the live one. A fallback
   that disagrees with the product is worse than no fallback, because it appears exactly when
   something has already gone wrong.

   To change a menu, change the catalog (the Pages screen, or a migration) and regenerate.
   ──────────────────────────────────────────────────────────────────────────────────────────── */

export const platformNav: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { label: "My work", path: "/my-work", icon: Inbox },
      { label: "Approvals", path: "/approvals", icon: Stamp },
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
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
      { label: "Internal", path: "/internal-teams", icon: Boxes },
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Workspaces", path: "/admin/workspaces", icon: Building2, superAdminOnly: true },
      { label: "Workflows", path: "/admin/workflows", icon: GitBranch, superAdminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Onboarding review", path: "/onboarding/review", icon: ClipboardCheck },
      { label: "Status Logs", path: "/status-logs", icon: History },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
    ],
  },
];

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
      { label: "Workflows", path: "/admin/workflows", icon: GitBranch, superAdminOnly: true },
      { label: "Pages", path: "/admin/pages", icon: SlidersHorizontal, superAdminOnly: true },
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
      { label: "Internal", path: "/internal-teams", icon: Boxes },
    ],
  },
  {
    heading: "System",
    items: [
      { label: "Status Logs", path: "/status-logs", icon: History },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
      { label: "Settings", path: "/settings", icon: Settings },
    ],
  },
];

export const workspaceNav: NavGroup[] = [
  {
    heading: "Dashboard",
    items: [
      { label: "My work", path: "/my-work", icon: Inbox },
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
      { label: "Management Overview", path: "/management-overview", icon: Gauge, adminOnly: true },
    ],
  },
  {
    heading: "Procurement",
    items: [
      { label: "New RFQ", path: "/rfq-new", icon: FilePlus2, soon: true },
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
      { label: "Workshops", path: "/org/workshops", icon: Wrench, adminOnly: true },
      { label: "Vendors", path: "/vendors", icon: Store, adminOnly: true },
      { label: "Providers", path: "/providers", icon: Handshake, adminOnly: true },
      { label: "Internal", path: "/internal-teams", icon: Boxes, adminOnly: true },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true, adminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users, adminOnly: true },
      { label: "Status Logs", path: "/status-logs", icon: History, adminOnly: true },
      { label: "Settings", path: "/settings", icon: Settings, adminOnly: true },
    ],
  },
];

export const vendorNav: NavGroup[] = [
  {
    heading: "Sales",
    items: [
      { label: "Overview", path: "/vendor", icon: LayoutDashboard },
      { label: "Quotations", path: "/vendor/quotations", icon: Files },
      { label: "Confirmed Orders", path: "/vendor/confirmed", icon: ShoppingCart },
    ],
  },
  {
    heading: "Fulfillment & finance",
    items: [
      { label: "Purchase & Return Invoices", path: "/vendor/invoices", icon: Receipt, soon: true },
      { label: "Statement & Payments", path: "/vendor/statement", icon: Wallet, soon: true },
      { label: "Returns & Exchanges", path: "/vendor/returns", icon: Undo2, soon: true },
      { label: "Invoice Financing", path: "/vendor/financing", icon: Banknote, soon: true },
      { label: "Shipping & Delivery", path: "/vendor/deliveries", icon: Truck, soon: true },
    ],
  },
  {
    heading: "Growth",
    items: [
      { label: "Parts Catalog", path: "/vendor/catalog", icon: PackageSearch, soon: true },
      { label: "Online Store", path: "/vendor/store", icon: Store, soon: true },
      { label: "Paid Quotations", path: "/vendor/paid-quotations", icon: Stamp, soon: true },
      { label: "Wallet", path: "/vendor/wallet", icon: Wallet, soon: true },
      { label: "Market Index", path: "/vendor/market-index", icon: LineChart, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Users & Permissions", path: "/vendor/branches", icon: Building2, soon: true },
      { label: "Profit Percentages", path: "/vendor/margins", icon: Percent, soon: true },
      { label: "Account Managers", path: "/vendor/account-managers", icon: CalendarClock, soon: true },
      { label: "My Profile", path: "/vendor/profile", icon: UserCircle },
      { label: "Settings", path: "/vendor/settings", icon: Settings, soon: true },
    ],
  },
];

export const workshopNav: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      { label: "Overview", path: "/workshop", icon: LayoutDashboard },
    ],
  },
  {
    heading: "Storefront",
    items: [
      { label: "Online Store", path: "/workshop/store", icon: Store, soon: true },
      { label: "Shipping & Delivery", path: "/shipping", icon: Truck, soon: true },
      { label: "Paid Quotations", path: "/paid-quotations", icon: Stamp, soon: true },
      { label: "Wallet", path: "/wallet", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Requests",
    items: [
      { label: "New RFQ", path: "/workshop/requests/new", icon: FilePlus2,
        children: [
          { label: "Regular RFQ", path: "/workshop/requests/new/regular", icon: FileText, soon: true },
        ] },
      { label: "RFQs Dashboard", path: "/workshop/requests", icon: Files },
    ],
  },
  {
    heading: "Orders",
    items: [
      { label: "Orders Dashboard", path: "/workshop/orders", icon: ShoppingCart },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true },
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
    heading: "Records",
    items: [
      { label: "Notes Archive", path: "/notes-archive", icon: History, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Branches", path: "/workshop/branches", icon: Building2 },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
      { label: "My Profile", path: "/workshop/profile", icon: UserCircle, soon: true },
      { label: "Settings", path: "/settings", icon: UserCircle },
    ],
  },
];

export const providerNav: NavGroup[] = [
  {
    heading: "Provider",
    items: [
      { label: "Overview", path: "/provider", icon: LayoutDashboard },
      { label: "Assignments", path: "/provider/assignments", icon: ClipboardList, soon: true },
    ],
  },
  {
    heading: "Part numbers",
    items: [
      { label: "Part Number Extraction", path: "/provider/extraction", icon: PackageSearch, soon: true },
      { label: "Part Number Request Settings", path: "/provider/extraction-settings", icon: SlidersHorizontal, soon: true },
    ],
  },
  {
    heading: "Procurement",
    items: [
      { label: "New RFQ", path: "/provider/rfq-new", icon: FilePlus2, soon: true,
        children: [
          { label: "Regular RFQ", path: "/provider/rfq-new/regular", icon: FileText, soon: true },
        ] },
      { label: "RFQs Dashboard", path: "/provider/rfqs", icon: Files, soon: true },
      { label: "Orders Dashboard", path: "/provider/orders", icon: ShoppingCart, soon: true },
    ],
  },
  {
    heading: "Finance",
    items: [
      { label: "Invoices", path: "/provider/invoices", icon: Receipt, soon: true },
      { label: "Wallet", path: "/provider/wallet", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Users & Permissions", path: "/provider/users", icon: Users, soon: true },
      { label: "Account Managers", path: "/provider/account-managers", icon: CalendarClock, soon: true },
      { label: "My Profile", path: "/provider/profile", icon: UserCircle, soon: true },
    ],
  },
];

export const internalNav: NavGroup[] = [
  {
    heading: "Dashboard",
    items: [
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
      { label: "Internal Dashboard", path: "/internal", icon: Boxes },
      { label: "Part Number Extraction", path: "/internal/extraction", icon: PackageSearch, soon: true },
      { label: "Assignments", path: "/internal/assignments", icon: ClipboardList, soon: true },
    ],
  },
  {
    heading: "Operations",
    items: [
      { label: "Delivery & Return Notes", path: "/notes", icon: FileText, soon: true },
      { label: "Notes Archive", path: "/notes-archive", icon: History, soon: true },
      { label: "Status Logs", path: "/status-logs", icon: History },
      { label: "Purchase & Return Invoices", path: "/purchase-invoices", icon: Receipt, soon: true },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true },
    ],
  },
  {
    heading: "Fulfilment",
    items: [
      { label: "Shipping & Delivery", path: "/shipping", icon: Truck, soon: true },
      { label: "Paid Quotations", path: "/paid-quotations", icon: Stamp, soon: true },
      { label: "Wallet", path: "/wallet", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Reports",
    items: [
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true },
      { label: "Parts Pricing Report", path: "/parts-pricing-report", icon: BarChart3, soon: true },
      { label: "Profit Percentages", path: "/profit", icon: Percent, soon: true },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true },
      { label: "Vendors", path: "/vendors", icon: Store },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "My Profile", path: "/internal/profile", icon: UserCircle, soon: true },
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
  if (persona === "internal") return internalNav;
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
