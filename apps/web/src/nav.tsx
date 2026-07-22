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
  type LucideIcon,
} from "lucide-react";

export type Persona = "platform" | "workspace" | "vendor" | "service_provider";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  soon?: boolean;
  superAdminOnly?: boolean; // platform portal — only super_admin
  adminOnly?: boolean; // workspace portal — only company_admin
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
      { label: "Internal Dashboard", path: "/internal", icon: Boxes, soon: true },
      { label: "Management Overview", path: "/management", icon: Gauge, soon: true },
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
      { label: "Pricing Engine", path: "/pricing", icon: Percent },
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
    ],
  },
  {
    heading: "Admin",
    items: [
      { label: "Workspaces", path: "/admin/workspaces", icon: Building2, superAdminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
      { label: "Status Logs", path: "/status-logs", icon: History, soon: true },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
    ],
  },
];

/** Workspace portal — a client company, scoped to one workspace. */
export const workspaceNav: NavGroup[] = [
  {
    heading: "Workspace",
    items: [{ label: "Overview", path: "/overview", icon: LayoutDashboard }],
  },
  {
    heading: "Procurement",
    items: [
      { label: "New RFQ", path: "/rfq-new", icon: FilePlus2 },
      { label: "RFQs Dashboard", path: "/rfqs", icon: Files },
      { label: "Orders Dashboard", path: "/orders", icon: ShoppingCart },
      { label: "Delivered Orders", path: "/delivered", icon: Truck, soon: true },
    ],
  },
  {
    heading: "Finance",
    items: [
      { label: "Purchase & Return Invoices", path: "/purchase-invoices", icon: Receipt, soon: true },
      { label: "Returns & Exchanges", path: "/returns", icon: Undo2, soon: true },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Workshops & Branches", path: "/org/workshops", icon: Wrench, adminOnly: true },
      { label: "Vendors", path: "/vendors", icon: Store, adminOnly: true },
      { label: "Users & Permissions", path: "/admin/users", icon: Users, adminOnly: true },
      { label: "Settings", path: "/settings", icon: UserCircle, adminOnly: true },
    ],
  },
];

/** Vendor portal — a supplier, across the workspaces it's linked to. */
export const vendorNav: NavGroup[] = [
  {
    heading: "Vendor",
    items: [
      { label: "Overview", path: "/vendor", icon: LayoutDashboard },
      { label: "Quotations", path: "/vendor/quotations", icon: Files, soon: true },
      { label: "Confirmed Orders", path: "/vendor/confirmed", icon: ShoppingCart, soon: true },
      { label: "Invoices", path: "/vendor/invoices", icon: Receipt, soon: true },
      { label: "Returns & Exchanges", path: "/vendor/returns", icon: Undo2, soon: true },
    ],
  },
  {
    heading: "Financials",
    items: [
      { label: "Statement & Payments", path: "/vendor/statement", icon: Wallet, soon: true },
      { label: "Invoice Financing", path: "/vendor/financing", icon: Banknote, soon: true },
    ],
  },
  {
    heading: "Account",
    items: [
      { label: "Branches & Users", path: "/vendor/branches", icon: Users, soon: true },
      { label: "Vendor Profile", path: "/vendor/profile", icon: UserCircle, soon: true },
    ],
  },
];

/** Pick + filter the nav tree for the resolved persona and role. */
export function navForPersona(
  persona: Persona,
  opts: { isSuperAdmin?: boolean; isCompanyAdmin?: boolean },
): NavGroup[] {
  if (persona === "vendor") return vendorNav;
  if (persona === "platform") {
    return platformNav
      .map((g) => ({ ...g, items: g.items.filter((it) => !it.superAdminOnly || opts.isSuperAdmin) }))
      .filter((g) => g.items.length);
  }
  // workspace
  return workspaceNav
    .map((g) => ({ ...g, items: g.items.filter((it) => !it.adminOnly || opts.isCompanyAdmin) }))
    .filter((g) => g.items.length);
}
