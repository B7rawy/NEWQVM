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

/**
 * A page's owner, in words, for the sidebar tag. Only shown when the page belongs to somebody OTHER
 * than the portal you are in — inside the vendor portal every page is a vendor page, so tagging all
 * eighteen of them says nothing. See OWN_MODULE for which portal owns which.
 */
export const MODULE_TAG: Record<string, { label: string; tone: string }> = {
  // The product's own --chip-* tokens, not raw Tailwind palette colours. Two reasons, both learned
  // the hard way: `bg-sky-500/12` produced NO css rule at all here (the class was on the element and
  // the background stayed transparent), and a hand-picked colour would not have flipped with the
  // theme. These tokens have light and dark values already, and the same four tones label the same
  // four families on the Pages admin screen.
  workshop:         { label: "Workshop", tone: "bg-[var(--chip-blue-bg)] text-[var(--chip-blue-fg)]" },
  vendor:           { label: "Vendor",   tone: "bg-[var(--chip-green-bg)] text-[var(--chip-green-fg)]" },
  service_provider: { label: "Provider", tone: "bg-[var(--chip-amber-bg)] text-[var(--chip-amber-fg)]" },
  internal:         { label: "Internal", tone: "bg-[var(--chip-red-bg)] text-[var(--chip-red-fg)]" },
};

/** The counterparty a portal IS. Workspace and platform portals are nobody's, so they tag everything. */
export const OWN_MODULE: Record<string, string | undefined> = {
  vendor: "vendor",
  workshop: "workshop",
  service_provider: "service_provider",
  internal: "internal",
};

export type Persona = "platform" | "workspace" | "vendor" | "workshop" | "service_provider" | "internal";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** One level only — see migration 0073, where the database refuses a third. */
  children?: Array<{ label: string; path: string; icon: LucideIcon; soon?: boolean; module?: string }>;
  /** Which counterparty family switches this page on: core | workshop | vendor | service_provider
   *  | internal. The sidebar shows it as a tag when it is not the portal's own. */
  module?: string;
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
      { label: "RFQs Dashboard", path: "/rfqs", icon: Files, module: "workshop" },
      { label: "Orders Dashboard", path: "/orders", icon: ShoppingCart, module: "workshop" },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Services",
    items: [
      { label: "Pricing Engine", path: "/pricing", icon: Percent, soon: true, module: "vendor" },
      { label: "Profit Percentages", path: "/profit", icon: BarChart3, soon: true, module: "vendor" },
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true, module: "workshop" },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true },
    ],
  },
  {
    heading: "Master data",
    items: [
      { label: "Vendors", path: "/vendors", icon: Store, module: "vendor" },
      { label: "Workshops", path: "/org/workshops", icon: Wrench, module: "workshop" },
      { label: "Providers", path: "/providers", icon: Handshake, module: "service_provider" },
      { label: "Internal", path: "/internal-teams", icon: Boxes, module: "internal" },
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
      { label: "Internal Dashboard", path: "/internal", icon: Boxes, module: "internal" },
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
      { label: "Vendors", path: "/vendors", icon: Store, module: "vendor" },
      { label: "Workshops", path: "/org/workshops", icon: Wrench, module: "workshop" },
      { label: "Providers", path: "/providers", icon: Handshake, module: "service_provider" },
      { label: "Internal", path: "/internal-teams", icon: Boxes, module: "internal" },
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
      { label: "New RFQ", path: "/rfq-new", icon: FilePlus2, soon: true, module: "workshop" },
      { label: "RFQs Dashboard", path: "/rfqs", icon: Files, module: "workshop" },
      { label: "Orders Dashboard", path: "/orders", icon: ShoppingCart, module: "workshop" },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true, module: "workshop" },
      { label: "Closed Orders", path: "/closed", icon: CheckCircle, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Finance",
    items: [
      { label: "Purchase & Return Invoices", path: "/purchase-invoices", icon: Receipt, soon: true, module: "workshop" },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true, module: "workshop" },
      { label: "Delivery & Return Notes", path: "/notes", icon: FileText, soon: true, module: "workshop" },
      { label: "Statements", path: "/statements", icon: Wallet, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Reports & pricing",
    items: [
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true, module: "workshop", adminOnly: true },
      { label: "Parts Pricing Report", path: "/parts-pricing-report", icon: BarChart3, soon: true, module: "vendor", adminOnly: true },
      { label: "Targets", path: "/targets", icon: Target, soon: true, module: "workshop", adminOnly: true },
      { label: "Profit Percentages", path: "/profit", icon: Percent, soon: true, module: "vendor", adminOnly: true },
      { label: "Pricing Engine", path: "/pricing", icon: SlidersHorizontal, soon: true, module: "vendor", adminOnly: true },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Add supplier / workshop", path: "/onboarding", icon: UserPlus, adminOnly: true },
      { label: "Workshops", path: "/org/workshops", icon: Wrench, module: "workshop", adminOnly: true },
      { label: "Vendors", path: "/vendors", icon: Store, module: "vendor", adminOnly: true },
      { label: "Providers", path: "/providers", icon: Handshake, module: "service_provider", adminOnly: true },
      { label: "Internal", path: "/internal-teams", icon: Boxes, module: "internal", adminOnly: true },
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
      { label: "Overview", path: "/vendor", icon: LayoutDashboard, module: "vendor" },
      { label: "Quotations", path: "/vendor/quotations", icon: Files, module: "vendor" },
      { label: "Confirmed Orders", path: "/vendor/confirmed", icon: ShoppingCart, module: "vendor" },
    ],
  },
  {
    heading: "Fulfillment & finance",
    items: [
      { label: "Purchase & Return Invoices", path: "/vendor/invoices", icon: Receipt, soon: true, module: "vendor" },
      { label: "Statement & Payments", path: "/vendor/statement", icon: Wallet, soon: true, module: "vendor" },
      { label: "Returns & Exchanges", path: "/vendor/returns", icon: Undo2, soon: true, module: "vendor" },
      { label: "Invoice Financing", path: "/vendor/financing", icon: Banknote, soon: true, module: "vendor" },
      { label: "Shipping & Delivery", path: "/vendor/deliveries", icon: Truck, soon: true, module: "vendor" },
    ],
  },
  {
    heading: "Growth",
    items: [
      { label: "Parts Catalog", path: "/vendor/catalog", icon: PackageSearch, soon: true, module: "vendor" },
      { label: "Online Store", path: "/vendor/store", icon: Store, soon: true, module: "vendor" },
      { label: "Paid Quotations", path: "/vendor/paid-quotations", icon: Stamp, soon: true, module: "vendor" },
      { label: "Wallet", path: "/vendor/wallet", icon: Wallet, soon: true, module: "vendor" },
      { label: "Market Index", path: "/vendor/market-index", icon: LineChart, soon: true, module: "vendor" },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Users & Permissions", path: "/vendor/branches", icon: Building2, soon: true, module: "vendor" },
      { label: "Profit Percentages", path: "/vendor/margins", icon: Percent, soon: true, module: "vendor" },
      { label: "Account Managers", path: "/vendor/account-managers", icon: CalendarClock, soon: true, module: "vendor" },
      { label: "My Profile", path: "/vendor/profile", icon: UserCircle, module: "vendor" },
      { label: "Settings", path: "/vendor/settings", icon: Settings, soon: true, module: "vendor" },
    ],
  },
];

export const workshopNav: NavGroup[] = [
  {
    heading: "Overview",
    items: [
      { label: "Overview", path: "/workshop", icon: LayoutDashboard, module: "workshop" },
    ],
  },
  {
    heading: "Storefront",
    items: [
      { label: "Online Store", path: "/workshop/store", icon: Store, soon: true, module: "workshop" },
      { label: "Shipping & Delivery", path: "/shipping", icon: Truck, soon: true, module: "workshop" },
      { label: "Paid Quotations", path: "/paid-quotations", icon: Stamp, soon: true, module: "workshop" },
      { label: "Wallet", path: "/wallet", icon: Wallet, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Requests",
    items: [
      { label: "New RFQ", path: "/workshop/requests/new", icon: FilePlus2, module: "workshop",
        children: [
          { label: "Regular RFQ", path: "/workshop/requests/new/regular", icon: FileText, soon: true, module: "workshop" },
        ] },
      { label: "RFQs Dashboard", path: "/workshop/requests", icon: Files, module: "workshop" },
    ],
  },
  {
    heading: "Orders",
    items: [
      { label: "Orders Dashboard", path: "/workshop/orders", icon: ShoppingCart, module: "workshop" },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true, module: "workshop" },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Billing",
    items: [
      { label: "Invoices", path: "/invoices", icon: Receipt, soon: true, module: "workshop" },
      { label: "Statement & Payments", path: "/statement", icon: Wallet, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Records",
    items: [
      { label: "Notes Archive", path: "/notes-archive", icon: History, soon: true, module: "workshop" },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Branches", path: "/workshop/branches", icon: Building2, module: "workshop" },
      { label: "Users & Permissions", path: "/admin/users", icon: Users, module: "workshop" },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true, module: "workshop" },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true, module: "workshop" },
      { label: "My Profile", path: "/workshop/profile", icon: UserCircle, soon: true, module: "workshop" },
      { label: "Settings", path: "/settings", icon: UserCircle, module: "workshop" },
    ],
  },
];

export const providerNav: NavGroup[] = [
  {
    heading: "Provider",
    items: [
      { label: "Overview", path: "/provider", icon: LayoutDashboard, module: "service_provider" },
      { label: "Assignments", path: "/provider/assignments", icon: ClipboardList, soon: true, module: "service_provider" },
    ],
  },
  {
    heading: "Part numbers",
    items: [
      { label: "Part Number Extraction", path: "/provider/extraction", icon: PackageSearch, soon: true, module: "service_provider" },
      { label: "Part Number Request Settings", path: "/provider/extraction-settings", icon: SlidersHorizontal, soon: true, module: "service_provider" },
    ],
  },
  {
    heading: "Procurement",
    items: [
      { label: "New RFQ", path: "/provider/rfq-new", icon: FilePlus2, soon: true, module: "service_provider",
        children: [
          { label: "Regular RFQ", path: "/provider/rfq-new/regular", icon: FileText, soon: true, module: "service_provider" },
        ] },
      { label: "RFQs Dashboard", path: "/provider/rfqs", icon: Files, soon: true, module: "service_provider" },
      { label: "Orders Dashboard", path: "/provider/orders", icon: ShoppingCart, soon: true, module: "service_provider" },
    ],
  },
  {
    heading: "Finance",
    items: [
      { label: "Invoices", path: "/provider/invoices", icon: Receipt, soon: true, module: "service_provider" },
      { label: "Wallet", path: "/provider/wallet", icon: Wallet, soon: true, module: "service_provider" },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Users & Permissions", path: "/provider/users", icon: Users, soon: true, module: "service_provider" },
      { label: "Account Managers", path: "/provider/account-managers", icon: CalendarClock, soon: true, module: "service_provider" },
      { label: "My Profile", path: "/provider/profile", icon: UserCircle, soon: true, module: "service_provider" },
    ],
  },
];

export const internalNav: NavGroup[] = [
  {
    heading: "Dashboard",
    items: [
      { label: "Overview", path: "/overview", icon: LayoutDashboard, module: "internal" },
      { label: "Internal Dashboard", path: "/internal", icon: Boxes, module: "internal" },
      { label: "Part Number Extraction", path: "/internal/extraction", icon: PackageSearch, soon: true, module: "internal" },
      { label: "Assignments", path: "/internal/assignments", icon: ClipboardList, soon: true, module: "internal" },
    ],
  },
  {
    heading: "Operations",
    items: [
      { label: "Delivery & Return Notes", path: "/notes", icon: FileText, soon: true, module: "internal" },
      { label: "Notes Archive", path: "/notes-archive", icon: History, soon: true, module: "internal" },
      { label: "Status Logs", path: "/status-logs", icon: History, module: "internal" },
      { label: "Purchase & Return Invoices", path: "/purchase-invoices", icon: Receipt, soon: true, module: "internal" },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true, module: "internal" },
    ],
  },
  {
    heading: "Fulfilment",
    items: [
      { label: "Shipping & Delivery", path: "/shipping", icon: Truck, soon: true, module: "internal" },
      { label: "Paid Quotations", path: "/paid-quotations", icon: Stamp, soon: true, module: "internal" },
      { label: "Wallet", path: "/wallet", icon: Wallet, soon: true, module: "internal" },
    ],
  },
  {
    heading: "Reports",
    items: [
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true, module: "internal" },
      { label: "Parts Pricing Report", path: "/parts-pricing-report", icon: BarChart3, soon: true, module: "internal" },
      { label: "Profit Percentages", path: "/profit", icon: Percent, soon: true, module: "internal" },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Users & Permissions", path: "/admin/users", icon: Users, module: "internal" },
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true, module: "internal" },
      { label: "Vendors", path: "/vendors", icon: Store, module: "vendor" },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "My Profile", path: "/internal/profile", icon: UserCircle, soon: true, module: "internal" },
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
