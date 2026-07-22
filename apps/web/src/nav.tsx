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
  ScrollText,
  Webhook,
  UserCircle,
  LineChart,
  Banknote,
  Wallet,
  PackageSearch,
  Building2,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  soon?: boolean;
  platformOnly?: boolean;
}
export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** Internal / client (workshop + Qparts staff) navigation — mirrors the old ERP, our structure. */
export const internalNav: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { label: "Overview", path: "/overview", icon: LayoutDashboard },
      { label: "Management Overview", path: "/management", icon: LineChart, soon: true },
    ],
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
      { label: "Profit Percentages", path: "/pricing", icon: Percent },
      { label: "Parts Pricing Report", path: "/parts-pricing", icon: BarChart3, soon: true },
    ],
  },
  {
    heading: "Setup",
    items: [
      { label: "Workspaces", path: "/admin/workspaces", icon: Building2, platformOnly: true },
      { label: "Workshops & Branches", path: "/org/workshops", icon: Wrench },
      { label: "Vendors", path: "/vendors", icon: Store },
      { label: "Users & Permissions", path: "/admin/users", icon: Users },
    ],
  },
  {
    heading: "Operations",
    items: [
      { label: "Account Managers", path: "/account-managers", icon: CalendarClock, soon: true },
      { label: "Performance Reports", path: "/reports", icon: LineChart, soon: true },
      { label: "Delivery & Return Notes", path: "/notes", icon: ScrollText, soon: true },
      { label: "Status Logs", path: "/status-logs", icon: History, soon: true },
      { label: "Webhook Logs", path: "/webhook-logs", icon: Webhook, soon: true },
    ],
  },
];

/** Vendor-facing navigation. */
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
      { label: "Wallet", path: "/vendor/wallet", icon: Wallet, soon: true },
    ],
  },
  {
    heading: "Catalog",
    items: [
      { label: "Parts Catalog", path: "/vendor/catalog", icon: PackageSearch, soon: true },
      { label: "Online Store", path: "/vendor/store", icon: Store, soon: true },
      { label: "Shipping & Delivery", path: "/vendor/shipping", icon: Truck, soon: true },
      { label: "Vendor Profile", path: "/vendor/profile", icon: UserCircle, soon: true },
    ],
  },
];
