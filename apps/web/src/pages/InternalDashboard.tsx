import { Fragment, useMemo, useState } from "react";
import {
  Search,
  SlidersHorizontal,
  RefreshCw,
  Download,
  Plus,
  Tag,
  Send,
  ChevronRight,
  ChevronDown,
  StickyNote,
  X,
  Sparkles,
  ShoppingCart,
  Loader2,
  DollarSign,
  ClipboardList,
  Copy,
  Undo2,
} from "lucide-react";
import { PageHeader, Card, StatStrip, Badge, EmptyState } from "../components/ui";

/* ────────────────────────────────────────────────────────────────────────────
   Internal Dashboard (Orders & RFQs) — frontend-only rebuild.
   Faithful to the old Supabase-backed page: KPI strip, multi-tab workspace
   (By-Item / By-Order table, Flow board, Extract-PN queue), filters, bulk bar.
   All data below is hardcoded Saudi B2B auto-parts MOCK data. No API calls.
   Money = SAR; renders correctly in both light and dark mode via semantic tokens.
──────────────────────────────────────────────────────────────────────────── */

/* ── Status system (list_data ids → label + badge tone) ──────────────────── */
type Tone = "gray" | "green" | "amber" | "red" | "blue";
interface StatusDef {
  id: number;
  label: string;
  tone: Tone;
}
const STATUS: Record<number, StatusDef> = {
  15: { id: 15, label: "New RFQ", tone: "blue" },
  16: { id: 16, label: "Tendering", tone: "amber" },
  17: { id: 17, label: "Priced", tone: "blue" },
  18: { id: 18, label: "Canceled", tone: "red" },
  19: { id: 19, label: "Confirmed", tone: "green" },
  21: { id: 21, label: "Processing", tone: "amber" },
  22: { id: 22, label: "Out for Delivery", tone: "amber" },
  23: { id: 23, label: "Delivered", tone: "green" },
  25: { id: 25, label: "Pending Invoice", tone: "amber" },
  26: { id: 26, label: "Invoice Issued", tone: "blue" },
  28: { id: 28, label: "Return Request", tone: "red" },
  31: { id: 31, label: "Settled", tone: "green" },
  235: { id: 235, label: "Ready For Quotation", tone: "blue" },
  236: { id: 236, label: "Extract PN", tone: "amber" },
  237: { id: 237, label: "Sent To Vendor", tone: "amber" },
  267: { id: 267, label: "Added by Vendor", tone: "amber" },
};
const st = (id: number): StatusDef => STATUS[id] ?? { id, label: `#${id}`, tone: "gray" };

/* ── Formatting helpers ──────────────────────────────────────────────────── */
const sar = new Intl.NumberFormat("en-US", { style: "currency", currency: "SAR", minimumFractionDigits: 2 });
function Money({ value, bold = false }: { value: number; bold?: boolean }) {
  if (!value) return <span className="text-faint">—</span>;
  return <span className={`tnum ${bold ? "font-semibold text-ink" : "text-ink"}`}>{sar.format(value)}</span>;
}
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB");

/* ── Mock data model ─────────────────────────────────────────────────────── */
interface Item {
  itemId: string;
  partDescription: string;
  partNumber: string;
  finalPartNumber: string | null;
  requestedQty: number;
  approvedQty: number | null;
  brandClass: "Genuine" | "OEM" | "Aftermarket";
  statusId: number;
  estimatedPrice: number;
  mainSellingPrice: number;
  discountAmount: number;
  totalAfterDiscount: number;
  purchaseCost: number;
  purchaseSupplier: string;
  notes: number;
}
interface Order {
  orderId: string;
  orderNumber: string;
  confirmedOrderId: string | null;
  rfqDate: string;
  confirmationDate: string | null;
  branchName: string;
  clientName: string;
  accountManager: string;
  mainBrand: string;
  model: string;
  year: number;
  plate: string;
  vin: string;
  orderType: string;
  deliveryType: string;
  serviceAdvisor: string;
  isBulk: boolean;
  items: Item[];
}

const BRAND_TINT: Record<string, string> = {
  Toyota: "bg-red-500",
  Nissan: "bg-slate-500",
  Hyundai: "bg-sky-500",
  Lexus: "bg-zinc-600",
  Kia: "bg-rose-500",
  GMC: "bg-orange-500",
};

const ORDERS: Order[] = [
  {
    orderId: "o1", orderNumber: "QP-24-01187", confirmedOrderId: null, rfqDate: "2026-07-21", confirmationDate: null,
    branchName: "الورشة الرئيسية - الرياض", clientName: "مؤسسة الفهد للسيارات", accountManager: "Faisal Al-Otaibi",
    mainBrand: "Toyota", model: "Land Cruiser", year: 2022, plate: "ABC-1234", vin: "JTMHV05J8N4021573",
    orderType: "Retail", deliveryType: "Pickup", serviceAdvisor: "Sultan Al-Harbi", isBulk: false,
    items: [
      { itemId: "o1i1", partDescription: "Front brake pads set", partNumber: "04465-60320", finalPartNumber: null, requestedQty: 2, approvedQty: null, brandClass: "Genuine", statusId: 15, estimatedPrice: 480, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 1 },
      { itemId: "o1i2", partDescription: "Oil filter", partNumber: "90915-YZZE1", finalPartNumber: null, requestedQty: 4, approvedQty: null, brandClass: "Genuine", statusId: 15, estimatedPrice: 45, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 0 },
      { itemId: "o1i3", partDescription: "Cabin air filter", partNumber: "", finalPartNumber: null, requestedQty: 2, approvedQty: null, brandClass: "OEM", statusId: 236, estimatedPrice: 0, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 0 },
    ],
  },
  {
    orderId: "o2", orderNumber: "QP-24-01185", confirmedOrderId: null, rfqDate: "2026-07-20", confirmationDate: null,
    branchName: "فرع جدة", clientName: "شركة البحر الأحمر للورش", accountManager: "Noura Al-Qahtani",
    mainBrand: "Nissan", model: "Patrol", year: 2021, plate: "JED-7788", vin: "JN8AY2NC5L9350214",
    orderType: "Fleet", deliveryType: "Delivery", serviceAdvisor: "Maha Al-Zahrani", isBulk: false,
    items: [
      { itemId: "o2i1", partDescription: "Alternator assembly", partNumber: "23100-1LB0A", finalPartNumber: "23100-1LB0A", requestedQty: 1, approvedQty: 1, brandClass: "OEM", statusId: 17, estimatedPrice: 1250, mainSellingPrice: 1690, discountAmount: 90, totalAfterDiscount: 1600, purchaseCost: 1180, purchaseSupplier: "Al-Jazira Parts", notes: 2 },
      { itemId: "o2i2", partDescription: "Serpentine belt", partNumber: "11720-EA00A", finalPartNumber: "11720-EA00A", requestedQty: 2, approvedQty: 2, brandClass: "Aftermarket", statusId: 17, estimatedPrice: 120, mainSellingPrice: 180, discountAmount: 0, totalAfterDiscount: 360, purchaseCost: 95, purchaseSupplier: "Gulf Auto Supply", notes: 0 },
    ],
  },
  {
    orderId: "o3", orderNumber: "QP-24-01180", confirmedOrderId: "C-3391", rfqDate: "2026-07-18", confirmationDate: "2026-07-19",
    branchName: "فرع الدمام", clientName: "مركز الخليج لصيانة السيارات", accountManager: "Faisal Al-Otaibi",
    mainBrand: "Hyundai", model: "Sonata", year: 2020, plate: "DAM-4521", vin: "5NPE34AF4LH012894",
    orderType: "Retail", deliveryType: "Delivery", serviceAdvisor: "Turki Al-Dosari", isBulk: false,
    items: [
      { itemId: "o3i1", partDescription: "Radiator assembly", partNumber: "25310-C1000", finalPartNumber: "25310-C1000", requestedQty: 1, approvedQty: 1, brandClass: "Genuine", statusId: 19, estimatedPrice: 890, mainSellingPrice: 1150, discountAmount: 50, totalAfterDiscount: 1100, purchaseCost: 820, purchaseSupplier: "Modern Parts Co.", notes: 1 },
      { itemId: "o3i2", partDescription: "Thermostat", partNumber: "25500-2E000", finalPartNumber: "25500-2E000", requestedQty: 1, approvedQty: 1, brandClass: "OEM", statusId: 21, estimatedPrice: 140, mainSellingPrice: 210, discountAmount: 0, totalAfterDiscount: 210, purchaseCost: 110, purchaseSupplier: "Modern Parts Co.", notes: 0 },
    ],
  },
  {
    orderId: "o4", orderNumber: "QP-24-01172", confirmedOrderId: "C-3380", rfqDate: "2026-07-15", confirmationDate: "2026-07-16",
    branchName: "الورشة الرئيسية - الرياض", clientName: "مؤسسة الفهد للسيارات", accountManager: "Noura Al-Qahtani",
    mainBrand: "Lexus", model: "ES 350", year: 2023, plate: "RUH-9012", vin: "58ADZ1B15PU142307",
    orderType: "Retail", deliveryType: "Pickup", serviceAdvisor: "Sultan Al-Harbi", isBulk: false,
    items: [
      { itemId: "o4i1", partDescription: "Headlight assembly (LH)", partNumber: "81150-33B60", finalPartNumber: "81150-33B60", requestedQty: 1, approvedQty: 1, brandClass: "Genuine", statusId: 22, estimatedPrice: 2100, mainSellingPrice: 2650, discountAmount: 150, totalAfterDiscount: 2500, purchaseCost: 1980, purchaseSupplier: "Al-Jazira Parts", notes: 3 },
    ],
  },
  {
    orderId: "o5", orderNumber: "QP-24-01166", confirmedOrderId: "C-3372", rfqDate: "2026-07-12", confirmationDate: "2026-07-13",
    branchName: "فرع مكة", clientName: "ورشة الحرم للسيارات", accountManager: "Faisal Al-Otaibi",
    mainBrand: "Kia", model: "Sportage", year: 2019, plate: "MAK-3345", vin: "KNDPMCAC7K7593028",
    orderType: "Fleet", deliveryType: "Delivery", serviceAdvisor: "Maha Al-Zahrani", isBulk: true,
    items: [
      { itemId: "o5i1", partDescription: "Front shock absorber pair", partNumber: "54650-D9000", finalPartNumber: "54650-D9000", requestedQty: 2, approvedQty: 2, brandClass: "OEM", statusId: 23, estimatedPrice: 640, mainSellingPrice: 860, discountAmount: 60, totalAfterDiscount: 1660, purchaseCost: 600, purchaseSupplier: "Gulf Auto Supply", notes: 0 },
      { itemId: "o5i2", partDescription: "Control arm bushing", partNumber: "54551-D3000", finalPartNumber: "54551-D3000", requestedQty: 4, approvedQty: 4, brandClass: "Aftermarket", statusId: 28, estimatedPrice: 80, mainSellingPrice: 130, discountAmount: 0, totalAfterDiscount: 520, purchaseCost: 62, purchaseSupplier: "Gulf Auto Supply", notes: 1 },
    ],
  },
  {
    orderId: "o6", orderNumber: "QP-24-01159", confirmedOrderId: "C-3361", rfqDate: "2026-07-08", confirmationDate: "2026-07-09",
    branchName: "فرع المدينة", clientName: "مؤسسة طيبة للمعدات", accountManager: "Noura Al-Qahtani",
    mainBrand: "GMC", model: "Sierra", year: 2021, plate: "MED-5567", vin: "3GTP9EED4MG198744",
    orderType: "Fleet", deliveryType: "Delivery", serviceAdvisor: "Turki Al-Dosari", isBulk: true,
    items: [
      { itemId: "o6i1", partDescription: "Brake rotor front", partNumber: "13529542", finalPartNumber: "13529542", requestedQty: 2, approvedQty: 2, brandClass: "OEM", statusId: 31, estimatedPrice: 520, mainSellingPrice: 720, discountAmount: 40, totalAfterDiscount: 1400, purchaseCost: 480, purchaseSupplier: "Modern Parts Co.", notes: 2 },
      { itemId: "o6i2", partDescription: "Wheel hub bearing", partNumber: "13500599", finalPartNumber: "13500599", requestedQty: 2, approvedQty: 2, brandClass: "Genuine", statusId: 31, estimatedPrice: 410, mainSellingPrice: 560, discountAmount: 0, totalAfterDiscount: 1120, purchaseCost: 380, purchaseSupplier: "Al-Jazira Parts", notes: 0 },
    ],
  },
  {
    orderId: "o7", orderNumber: "QP-24-01153", confirmedOrderId: null, rfqDate: "2026-07-06", confirmationDate: null,
    branchName: "فرع جدة", clientName: "شركة البحر الأحمر للورش", accountManager: "Faisal Al-Otaibi",
    mainBrand: "Toyota", model: "Camry", year: 2022, plate: "JED-1190", vin: "4T1G11AK7NU678120",
    orderType: "Retail", deliveryType: "Pickup", serviceAdvisor: "Sultan Al-Harbi", isBulk: false,
    items: [
      { itemId: "o7i1", partDescription: "AC compressor", partNumber: "88310-06550", finalPartNumber: "88310-06550", requestedQty: 1, approvedQty: 1, brandClass: "Genuine", statusId: 237, estimatedPrice: 1650, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 0 },
      { itemId: "o7i2", partDescription: "Condenser fan motor", partNumber: "16363-0T030", finalPartNumber: null, requestedQty: 1, approvedQty: null, brandClass: "OEM", statusId: 235, estimatedPrice: 0, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 0 },
    ],
  },
  {
    orderId: "o8", orderNumber: "QP-24-01148", confirmedOrderId: null, rfqDate: "2026-07-03", confirmationDate: null,
    branchName: "فرع الدمام", clientName: "مركز الخليج لصيانة السيارات", accountManager: "Noura Al-Qahtani",
    mainBrand: "Nissan", model: "Altima", year: 2020, plate: "DAM-2278", vin: "1N4BL4BV7LC201956",
    orderType: "Retail", deliveryType: "Delivery", serviceAdvisor: "Maha Al-Zahrani", isBulk: false,
    items: [
      { itemId: "o8i1", partDescription: "Timing chain kit", partNumber: "13028-3TA0A", finalPartNumber: null, requestedQty: 1, approvedQty: null, brandClass: "OEM", statusId: 16, estimatedPrice: 720, mainSellingPrice: 0, discountAmount: 0, totalAfterDiscount: 0, purchaseCost: 0, purchaseSupplier: "", notes: 0 },
    ],
  },
];

/* ── Derived option lists (for filters) ──────────────────────────────────── */
const ACCOUNT_MANAGERS = ["Faisal Al-Otaibi", "Noura Al-Qahtani"];
const CLIENTS = Array.from(new Set(ORDERS.map((o) => o.clientName)));
const BRANCHES = Array.from(new Set(ORDERS.map((o) => o.branchName)));
const BRANDS = Array.from(new Set(ORDERS.map((o) => o.mainBrand)));

/* ── KPI definitions ─────────────────────────────────────────────────────── */
const KPIS: { label: string; statusId: number }[] = [
  { label: "New RFQs", statusId: 15 },
  { label: "Priced", statusId: 17 },
  { label: "Delivered", statusId: 23 },
  { label: "Settled", statusId: 31 },
];

/* Seeded mini sparkline (decorative trend — NOT real history). */
function Sparkline({ seed }: { seed: number }) {
  const pts = useMemo(() => {
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    const vals = Array.from({ length: 9 }, () => 6 + rnd() * 18);
    const max = Math.max(...vals);
    return vals.map((v, i) => `${(i / 8) * 100},${24 - (v / max) * 22}`).join(" ");
  }, [seed]);
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-6 w-16 text-accent/60">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ── Flow stages ─────────────────────────────────────────────────────────── */
type FlowStageKey = "price" | "confirm" | "process";
interface FlowStageDef {
  key: FlowStageKey;
  label: string;
  icon: typeof DollarSign;
  statuses: number[];
}
const FLOW_STAGES: FlowStageDef[] = [
  { key: "price", label: "Needs Pricing", icon: DollarSign, statuses: [15, 16, 235, 237, 267] },
  { key: "confirm", label: "Confirm & Purchase", icon: ShoppingCart, statuses: [17, 19] },
  { key: "process", label: "Processing", icon: Loader2, statuses: [21, 22] },
];

type ViewTab = "all" | "flow" | "rfqs" | "orders" | "tender";
type Group = "item" | "order";
type Mode = "regular" | "bulk";

export default function InternalDashboard() {
  const [mode, setMode] = useState<Mode>("regular");
  const [view, setView] = useState<ViewTab>("rfqs");
  const [group, setGroup] = useState<Group>("item");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<number[]>([]);
  const [amFilter, setAmFilter] = useState<string[]>([]);
  const [clientFilter, setClientFilter] = useState<string[]>([]);
  const [branchFilter, setBranchFilter] = useState<string[]>([]);
  const [brandFilter, setBrandFilter] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [notesFor, setNotesFor] = useState<{ order: Order; item: Item } | null>(null);
  const [flowStage, setFlowStage] = useState<FlowStageKey>("price");

  const flash = (text: string, ok = true) => {
    setToast({ text, ok });
    window.setTimeout(() => setToast(null), 2200);
  };

  /* ── Filter pipeline (mode → view → filters → search) ──────────────────── */
  const orders = useMemo(() => {
    let list = ORDERS;
    if (mode === "bulk") list = list.filter((o) => o.isBulk);
    if (view === "rfqs") list = list.filter((o) => o.confirmedOrderId == null);
    if (view === "orders") list = list.filter((o) => o.confirmedOrderId != null);
    if (amFilter.length) list = list.filter((o) => amFilter.includes(o.accountManager));
    if (clientFilter.length) list = list.filter((o) => clientFilter.includes(o.clientName));
    if (branchFilter.length) list = list.filter((o) => branchFilter.includes(o.branchName));
    if (brandFilter.length) list = list.filter((o) => brandFilter.includes(o.mainBrand));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (o) =>
          o.orderNumber.toLowerCase().includes(q) ||
          o.vin.toLowerCase().includes(q) ||
          o.plate.toLowerCase().includes(q) ||
          o.items.some((it) => it.partDescription.toLowerCase().includes(q) || it.partNumber.toLowerCase().includes(q)),
      );
    }
    if (statusFilter.length) {
      list = list
        .map((o) => ({ ...o, items: o.items.filter((it) => statusFilter.includes(it.statusId)) }))
        .filter((o) => o.items.length > 0);
    }
    return list;
  }, [mode, view, amFilter, clientFilter, branchFilter, brandFilter, search, statusFilter]);

  const flatItems = useMemo(() => orders.flatMap((o) => o.items.map((it) => ({ order: o, item: it }))), [orders]);

  /* KPI counts — items across loaded dataset (before status filter narrowing). */
  const kpiCounts = useMemo(() => {
    const base = mode === "bulk" ? ORDERS.filter((o) => o.isBulk) : ORDERS;
    const all = base.flatMap((o) => o.items);
    return KPIS.map((k) => all.filter((it) => it.statusId === k.statusId).length);
  }, [mode]);

  const activeFilterCount =
    amFilter.length + clientFilter.length + branchFilter.length + brandFilter.length + statusFilter.length;

  const toggleStatusKpi = (id: number) =>
    setStatusFilter((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const toggleSelect = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const toggleExpand = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const allItemIds = flatItems.map((r) => r.item.itemId);
  const allSelected = allItemIds.length > 0 && allItemIds.every((id) => selected.has(id));
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(allItemIds));

  const doRefresh = () => {
    setRefreshing(true);
    window.setTimeout(() => {
      setRefreshing(false);
      flash("Table refreshed");
    }, 700);
  };

  const clearFilters = () => {
    setAmFilter([]);
    setClientFilter([]);
    setBranchFilter([]);
    setBrandFilter([]);
    setStatusFilter([]);
  };

  return (
    <>
      {/* ── Hero banner ──────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-xl2 border border-line bg-[#0d4151] px-6 py-6 text-white shadow-card sm:px-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 right-24 h-56 w-56 rounded-full bg-accent/20 blur-3xl" />
        <div className="relative max-w-2xl">
          <div className="flex items-center gap-1.5 text-[12px] text-white/60">
            <span>Home</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span>Internal</span>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="text-white/90">Orders &amp; RFQs</span>
          </div>
          <h1 className="mt-2 text-[26px] font-bold tracking-tight sm:text-[30px]">Internal Dashboard</h1>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-white/70">
            Manage RFQs, pricing and order fulfillment in one place — track every request from quotation to delivery,
            compare vendor costs, and keep your whole team aligned.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="inline-flex items-center rounded-full bg-white/10 p-0.5 text-[12px] font-medium ring-1 ring-white/15">
              {(["regular", "bulk"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-full px-3 py-1 capitalize transition ${
                    mode === m ? "bg-white text-[#0d4151]" : "text-white/75 hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <button
              onClick={() => flash("Create Order — opens the RFQ form")}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-white shadow-btn transition hover:bg-accent-hover"
            >
              <Plus className="h-4 w-4" /> Create Order
            </button>
          </div>
        </div>
      </div>

      {/* ── KPI strip (overlapping banner) ───────────────────────────────── */}
      <div className="relative z-10 -mt-8 mb-5">
        <StatStrip>
          {KPIS.map((k, i) => {
            const active = statusFilter.includes(k.statusId);
            return (
              <button
                key={k.statusId}
                onClick={() => toggleStatusKpi(k.statusId)}
                title={active ? `Click to clear ${k.label} filter` : `Click to filter by ${k.label}`}
                className={`group relative flex items-center justify-between px-4 py-4 text-left transition ${
                  active ? "bg-accent-50" : "hover:bg-surface"
                }`}
              >
                <div>
                  <div className={`text-[11px] font-medium uppercase tracking-wide ${active ? "text-accent" : "text-muted"}`}>
                    {k.label}
                  </div>
                  <div className="mt-0.5 text-[22px] font-semibold tracking-tight tnum text-ink">{kpiCounts[i]}</div>
                </div>
                <div className="hidden md:block">
                  <Sparkline seed={k.statusId} />
                </div>
                {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-accent" />}
              </button>
            );
          })}
        </StatStrip>
      </div>

      <PageHeader
        title="Orders & RFQs"
        subtitle="Internal command center — RFQs, pricing, purchasing and delivery."
        actions={<Badge tone="blue">{mode === "bulk" ? "Bulk clients" : "Regular"}</Badge>}
      />

      {/* ── View tab bar ─────────────────────────────────────────────────── */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {(
          [
            { key: "all", label: "All" },
            { key: "flow", label: "Flow" },
            { key: "rfqs", label: "RFQs" },
            { key: "orders", label: "Orders" },
            { key: "tender", label: "Extract PN" },
          ] as { key: ViewTab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setView(t.key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${
              view === t.key ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── FLOW view ────────────────────────────────────────────────────── */}
      {view === "flow" && <FlowView stage={flowStage} setStage={setFlowStage} flash={flash} />}

      {/* ── EXTRACT PN view ──────────────────────────────────────────────── */}
      {view === "tender" && <TenderView flash={flash} />}

      {/* ── DEFAULT table views (all / rfqs / orders) ────────────────────── */}
      {view !== "flow" && view !== "tender" && (
        <>
          {/* search bar */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto h-4 w-4 text-faint" />
              <input
                className="input ps-9"
                placeholder="Search by order #, VIN, part number, description, plate…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button
              onClick={() => flash(selected.size ? `Copied ${selected.size} row(s) as a table` : "Select rows to copy", selected.size > 0)}
              className="btn btn-sm rounded-md"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>

          <Card pad={false}>
            {/* toolbar */}
            <div className="flex flex-wrap items-center gap-2 border-b border-line-2 bg-surface/60 px-4 py-2.5">
              <button onClick={() => setDrawerOpen(true)} className="btn btn-sm rounded-md">
                <SlidersHorizontal className="h-3.5 w-3.5" /> Filters
                {activeFilterCount > 0 && (
                  <span className="ms-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#0d4151] px-1 text-[10px] font-semibold text-white">
                    {activeFilterCount}
                  </span>
                )}
              </button>
              <div className="ms-auto flex flex-wrap items-center gap-2">
                <div className="inline-flex overflow-hidden rounded-md border border-line text-[12px] font-medium">
                  {(["item", "order"] as Group[]).map((g) => (
                    <button
                      key={g}
                      onClick={() => setGroup(g)}
                      className={`px-2.5 py-1.5 transition ${
                        group === g ? "bg-[#0d4151] text-white" : "bg-panel text-muted hover:text-ink"
                      }`}
                    >
                      By {g === "item" ? "Item" : "Order"}
                    </button>
                  ))}
                </div>
                <button onClick={doRefresh} className="btn btn-sm rounded-md">
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
                </button>
                <button onClick={() => flash("Exported CSV")} className="btn-primary btn-sm rounded-md">
                  <Download className="h-3.5 w-3.5" /> Export
                </button>
              </div>
            </div>

            {/* body */}
            {flatItems.length === 0 ? (
              <EmptyState title="No orders found." hint="Try adjusting your filters." icon={<ClipboardList className="h-6 w-6" />} />
            ) : (
              <div className="relative overflow-x-auto">
                {refreshing && (
                  <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
                    <span className="inline-flex items-center gap-2 rounded-full bg-panel px-3 py-1 text-[12px] text-muted shadow-pop">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
                    </span>
                  </div>
                )}
                <div className={refreshing ? "opacity-50 transition" : "transition"}>
                  {group === "item" ? (
                    <ByItemTable
                      rows={flatItems}
                      selected={selected}
                      allSelected={allSelected}
                      onToggle={toggleSelect}
                      onToggleAll={toggleSelectAll}
                      onNotes={(order, item) => setNotesFor({ order, item })}
                      flash={flash}
                    />
                  ) : (
                    <ByOrderTable
                      orders={orders}
                      selected={selected}
                      onToggle={toggleSelect}
                      expanded={expanded}
                      onExpand={toggleExpand}
                      flash={flash}
                    />
                  )}
                </div>
              </div>
            )}

            {/* pagination */}
            {flatItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 border-t border-line-2 bg-surface/60 px-4 py-2.5 text-[12px] text-muted">
                <span className="inline-flex items-center gap-2">
                  Rows per page
                  <select className="rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink" defaultValue={10}>
                    {[10, 25, 50, 100].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </span>
                <span>Total: {flatItems.length}</span>
                {selected.size > 0 && <span className="font-medium text-accent">{selected.size} selected</span>}
                <div className="ms-auto flex items-center gap-2">
                  <span>Page 1</span>
                  <button className="btn btn-sm rounded-md" disabled>
                    Prev
                  </button>
                  <button className="btn btn-sm rounded-md" disabled>
                    Next
                  </button>
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {/* ── Filter drawer ────────────────────────────────────────────────── */}
      {drawerOpen && (
        <FilterDrawer
          onClose={() => setDrawerOpen(false)}
          activeCount={activeFilterCount}
          state={{ amFilter, clientFilter, branchFilter, brandFilter, statusFilter }}
          set={{ setAmFilter, setClientFilter, setBranchFilter, setBrandFilter, setStatusFilter }}
          clear={clearFilters}
        />
      )}

      {/* ── Notes modal ──────────────────────────────────────────────────── */}
      {notesFor && <NotesModal ctx={notesFor} onClose={() => setNotesFor(null)} flash={flash} />}

      {/* ── Bulk actions bar ─────────────────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-5 z-30 flex justify-center px-4">
          <div className="flex items-center gap-2 rounded-full bg-[#0d4151] px-3 py-2 text-[13px] text-white shadow-pop">
            <span className="ps-1 font-medium">{selected.size} order(s) selected</span>
            <span className="mx-1 h-4 w-px bg-white/20" />
            <button onClick={() => flash("Exported CSV")} className="rounded-full px-2.5 py-1 hover:bg-white/10">
              Export
            </button>
            <button onClick={() => flash("Archived selection")} className="rounded-full px-2.5 py-1 hover:bg-white/10">
              Archive
            </button>
            <button
              onClick={() => {
                flash("Orders reassigned to next available manager");
                setSelected(new Set());
              }}
              className="rounded-full px-2.5 py-1 hover:bg-white/10"
            >
              Reassign Orders
            </button>
            <button onClick={() => setSelected(new Set())} className="rounded-full p-1 hover:bg-white/10" aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Toast ────────────────────────────────────────────────────────── */}
      {toast && (
        <div className="fixed bottom-5 end-5 z-40">
          <div
            className={`rounded-md px-3.5 py-2 text-[13px] font-medium text-white shadow-pop ${
              toast.ok ? "bg-emerald-600" : "bg-accent"
            }`}
          >
            {toast.text}
          </div>
        </div>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   By-Item table
══════════════════════════════════════════════════════════════════════════ */
function BrandChip({ brand }: { brand: string }) {
  return (
    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-bold text-white ${BRAND_TINT[brand] ?? "bg-slate-500"}`}>
      {brand[0]}
    </span>
  );
}

function ByItemTable({
  rows,
  selected,
  allSelected,
  onToggle,
  onToggleAll,
  onNotes,
  flash,
}: {
  rows: { order: Order; item: Item }[];
  selected: Set<string>;
  allSelected: boolean;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onNotes: (o: Order, i: Item) => void;
  flash: (t: string, ok?: boolean) => void;
}) {
  return (
    <table className="w-full min-w-[1180px]">
      <thead>
        <tr>
          <th className="th w-8">
            <input type="checkbox" checked={allSelected} onChange={onToggleAll} className="accent-accent" />
          </th>
          <th className="th">Account Manager</th>
          <th className="th">Order No</th>
          <th className="th">RFQ Date</th>
          <th className="th">Branch</th>
          <th className="th">Status</th>
          <th className="th">Part Description</th>
          <th className="th">Part Number</th>
          <th className="th text-right">Req. Qty</th>
          <th className="th text-right">Appr. Qty</th>
          <th className="th">Brand Class</th>
          <th className="th text-right">Estimated</th>
          <th className="th text-right">Selling</th>
          <th className="th text-right">Total After Disc.</th>
          <th className="th">Vehicle</th>
          <th className="th text-center">Actions</th>
          <th className="th">Notes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ order, item }) => {
          const s = st(item.statusId);
          const isReturn = item.statusId === 28;
          return (
            <tr key={item.itemId} className="trow">
              <td className="td">
                <input
                  type="checkbox"
                  checked={selected.has(item.itemId)}
                  onChange={() => onToggle(item.itemId)}
                  className="accent-accent"
                />
              </td>
              <td className="td text-muted">{order.accountManager}</td>
              <td className="td font-semibold text-accent tnum">{order.orderNumber}</td>
              <td className="td tnum">
                {fmtDate(order.rfqDate)}
                {order.confirmationDate && (
                  <div className="text-[11px] text-faint">Confirmed: {fmtDate(order.confirmationDate)}</div>
                )}
              </td>
              <td className="td">
                <div className="font-medium text-ink">{order.branchName}</div>
                <div className="text-[11px] text-muted">{order.clientName}</div>
              </td>
              <td className="td">
                <Badge tone={s.tone}>{s.label}</Badge>
              </td>
              <td className="td max-w-[220px]">
                <span className="text-ink">{item.partDescription || <span className="text-faint">—</span>}</span>
              </td>
              <td className="td font-mono text-[12px] text-ink">{item.partNumber || <span className="font-sans text-faint">—</span>}</td>
              <td className="td text-right tnum">{item.requestedQty}</td>
              <td className="td text-right tnum">{item.approvedQty ?? <span className="text-faint">—</span>}</td>
              <td className="td text-muted">{item.brandClass}</td>
              <td className="td text-right">
                <Money value={item.estimatedPrice} />
              </td>
              <td className="td text-right">
                <Money value={item.mainSellingPrice} />
                {item.discountAmount > 0 && (
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 tnum">−{item.discountAmount}</div>
                )}
              </td>
              <td className="td text-right">
                <Money value={item.totalAfterDiscount} bold />
              </td>
              <td className="td">
                <div className="flex items-center gap-2">
                  <BrandChip brand={order.mainBrand} />
                  <div>
                    <div className="font-medium text-ink">
                      {order.mainBrand} {order.model}
                    </div>
                    <div className="text-[11px] text-muted tnum">{order.plate}</div>
                  </div>
                </div>
              </td>
              <td className="td">
                <div className="flex items-center justify-center gap-1">
                  <button onClick={() => flash("Add Item drawer opened")} title="Add Item" className="rounded-md p-1.5 text-accent hover:bg-accent-50">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  {isReturn && (
                    <button onClick={() => flash("Return note")} title="Return Note" className="rounded-md p-1.5 text-muted hover:bg-surface">
                      <Undo2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button onClick={() => flash("Pricing modal opened")} title="Pricing" className="rounded-md p-1.5 text-muted hover:bg-surface">
                    <Tag className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => flash("Vendor RFQ sent")} title="Send Vendor Request" className="rounded-md p-1.5 text-accent hover:bg-accent-50">
                    <Send className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
              <td className="td">
                {item.notes > 0 ? (
                  <button onClick={() => onNotes(order, item)} className="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-ink">
                    <StickyNote className="h-3.5 w-3.5" />
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-panel-2 px-1 text-[10px] font-semibold text-sub">
                      {item.notes}
                    </span>
                  </button>
                ) : (
                  <button onClick={() => onNotes(order, item)} className="text-faint hover:text-muted">
                    <StickyNote className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   By-Order (master/detail) table
══════════════════════════════════════════════════════════════════════════ */
function ByOrderTable({
  orders,
  selected,
  onToggle,
  expanded,
  onExpand,
  flash,
}: {
  orders: Order[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  expanded: Set<string>;
  onExpand: (id: string) => void;
  flash: (t: string, ok?: boolean) => void;
}) {
  return (
    <table className="w-full min-w-[860px]">
      <thead>
        <tr>
          <th className="th w-8" />
          <th className="th w-8" />
          <th className="th">Account Manager</th>
          <th className="th">Order No</th>
          <th className="th">RFQ Date</th>
          <th className="th">Branch</th>
          <th className="th">Status</th>
          <th className="th text-center">Items</th>
          <th className="th text-right">Actions</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((order) => {
          const open = expanded.has(order.orderId);
          const distinct = Array.from(new Set(order.items.map((i) => i.statusId)));
          return (
            <Fragment key={order.orderId}>
              <tr className="trow cursor-pointer" onClick={() => onExpand(order.orderId)}>
                <td className="td">
                  <ChevronDown className={`h-4 w-4 text-muted transition ${open ? "" : "-rotate-90 rtl:rotate-90"}`} />
                </td>
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={order.items.every((i) => selected.has(i.itemId))}
                    onChange={() => order.items.forEach((i) => onToggle(i.itemId))}
                    className="accent-accent"
                  />
                </td>
                <td className="td text-muted">{order.accountManager}</td>
                <td className="td font-semibold text-accent tnum">{order.orderNumber}</td>
                <td className="td tnum">{fmtDate(order.rfqDate)}</td>
                <td className="td">
                  <div className="font-medium text-ink">{order.branchName}</div>
                  <div className="text-[11px] text-muted">{order.clientName}</div>
                </td>
                <td className="td">
                  <div className="flex flex-wrap items-center gap-1">
                    {distinct.slice(0, 3).map((sid) => (
                      <Badge key={sid} tone={st(sid).tone}>
                        {st(sid).label}
                      </Badge>
                    ))}
                    {distinct.length > 3 && <span className="text-[11px] text-muted">+{distinct.length - 3}</span>}
                  </div>
                </td>
                <td className="td text-center">
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-panel-2 px-1.5 text-[11px] font-semibold text-sub tnum">
                    {order.items.length}
                  </span>
                </td>
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    <button onClick={() => flash("Add Item drawer opened")} className="btn btn-sm rounded-md">
                      <Plus className="h-3 w-3" /> Add
                    </button>
                    <button onClick={() => flash("Pricing modal opened")} className="btn btn-sm rounded-md">
                      <Tag className="h-3 w-3" /> Price
                    </button>
                    <button onClick={() => flash("Vendor RFQ sent")} className="btn-primary btn-sm rounded-md">
                      <Send className="h-3 w-3" /> Vendors
                    </button>
                  </div>
                </td>
              </tr>
              {open && (
                <tr key={`${order.orderId}-detail`} className="border-t border-line-2 bg-surface/40">
                  <td colSpan={9} className="px-4 py-3">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="th py-2">Status</th>
                          <th className="th py-2">Part Description</th>
                          <th className="th py-2">Part Number</th>
                          <th className="th py-2 text-right">Req. Qty</th>
                          <th className="th py-2 text-right">Appr. Qty</th>
                          <th className="th py-2">Brand Class</th>
                          <th className="th py-2 text-right">Selling</th>
                          <th className="th py-2 text-right">Total After Disc.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {order.items.map((it) => (
                          <tr key={it.itemId} className="border-t border-line-2">
                            <td className="td py-2.5">
                              <Badge tone={st(it.statusId).tone}>{st(it.statusId).label}</Badge>
                            </td>
                            <td className="td py-2.5">{it.partDescription || <span className="text-faint">—</span>}</td>
                            <td className="td py-2.5 font-mono text-[12px]">
                              {it.partNumber || <span className="font-sans text-faint">—</span>}
                            </td>
                            <td className="td py-2.5 text-right tnum">{it.requestedQty}</td>
                            <td className="td py-2.5 text-right tnum">{it.approvedQty ?? <span className="text-faint">—</span>}</td>
                            <td className="td py-2.5 text-muted">{it.brandClass}</td>
                            <td className="td py-2.5 text-right">
                              <Money value={it.mainSellingPrice} />
                            </td>
                            <td className="td py-2.5 text-right">
                              <Money value={it.totalAfterDiscount} bold />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Flow view (stage board)
══════════════════════════════════════════════════════════════════════════ */
function FlowView({
  stage,
  setStage,
  flash,
}: {
  stage: FlowStageKey;
  setStage: (s: FlowStageKey) => void;
  flash: (t: string, ok?: boolean) => void;
}) {
  const stageCount = (statuses: readonly number[]) =>
    ORDERS.reduce((n, o) => n + o.items.filter((i) => statuses.includes(i.statusId)).length, 0);
  const total = FLOW_STAGES.reduce((n, s) => n + stageCount(s.statuses), 0) || 1;

  const active = FLOW_STAGES.find((s) => s.key === stage)!;
  const stageOrders = ORDERS.filter((o) => o.items.some((i) => active.statuses.includes(i.statusId)));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FLOW_STAGES.map((s) => {
          const count = stageCount(s.statuses);
          const Icon = s.icon;
          const on = s.key === stage;
          return (
            <button
              key={s.key}
              onClick={() => setStage(s.key)}
              className={`card p-4 text-left transition ${on ? "ring-2 ring-accent" : "hover:bg-surface"}`}
            >
              <div className="flex items-center gap-2">
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${on ? "bg-accent text-white" : "bg-panel-2 text-muted"}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <div className="text-[13px] font-semibold text-ink">{s.label}</div>
                <span className="ms-auto text-[20px] font-semibold tabular-nums text-ink">{count}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(count / total) * 100}%` }} />
              </div>
            </button>
          );
        })}
      </div>

      <div className="mb-1 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent-50 text-accent">
          <active.icon className="h-4 w-4" />
        </span>
        <h3 className="text-[15px] font-semibold text-ink">{active.label}</h3>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 text-[11px] font-semibold text-sub">{stageOrders.length} orders</span>
      </div>

      {stageOrders.length === 0 ? (
        <Card>
          <EmptyState title="All caught up" hint="No orders in this stage." icon={<Sparkles className="h-6 w-6" />} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {stageOrders.map((o) => {
            const stageItems = o.items.filter((i) => active.statuses.includes(i.statusId));
            return (
              <Card key={o.orderId}>
                <div className="mb-3 flex items-start gap-2">
                  <BrandChip brand={o.mainBrand} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-accent tnum">{o.orderNumber}</span>
                      <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] font-semibold text-sub">
                        {stageItems.length} items
                      </span>
                    </div>
                    <div className="text-[13px] font-medium text-ink">
                      {o.mainBrand} {o.model} · {o.year}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      {o.clientName} · {o.accountManager} · {o.plate} · {fmtDate(o.rfqDate)}
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-line-2 border-t border-line-2">
                  {stageItems.map((it) => (
                    <div key={it.itemId} className="flex items-center gap-2 py-2 text-[12px]">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-ink">{it.partDescription || "—"}</div>
                        <div className="font-mono text-[11px] text-muted">{it.partNumber || "—"}</div>
                      </div>
                      <span className="tnum text-muted">×{it.requestedQty}</span>
                      <Badge tone={st(it.statusId).tone}>{st(it.statusId).label}</Badge>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex items-center gap-2">
                  {stage === "price" && (
                    <>
                      <button onClick={() => flash("Vendor RFQ sent")} className="btn btn-sm rounded-md">
                        <Send className="h-3 w-3" /> Send to Vendors
                      </button>
                      <button onClick={() => flash("Pricing modal opened")} className="btn-primary btn-sm rounded-md">
                        <Tag className="h-3 w-3" /> Compare &amp; Price
                      </button>
                    </>
                  )}
                  {stage === "confirm" && (
                    <button onClick={() => flash("Pricing modal opened")} className="btn-primary btn-sm rounded-md">
                      <ShoppingCart className="h-3 w-3" /> Open &amp; Purchase
                    </button>
                  )}
                  {stage === "process" && <span className="text-[12px] text-muted">In progress</span>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Extract PN view (tender review queue)
══════════════════════════════════════════════════════════════════════════ */
interface TenderItem {
  id: string;
  orderNumber: string;
  brand: string;
  model: string;
  year: number;
  vin: string;
  branch: string;
  accountManager: string;
  plate: string;
  brandClass: "Genuine" | "OEM" | "Aftermarket";
  partDescription: string;
  partNumber: string;
  requestedQty: number;
}
const TENDER_SEED: TenderItem[] = [
  { id: "t1", orderNumber: "QP-24-01187", brand: "Toyota", model: "Land Cruiser", year: 2022, vin: "JTMHV05J8N4021573", branch: "الورشة الرئيسية - الرياض", accountManager: "Faisal Al-Otaibi", plate: "ABC-1234", brandClass: "OEM", partDescription: "Cabin air filter", partNumber: "", requestedQty: 2 },
  { id: "t2", orderNumber: "QP-24-01185", brand: "Nissan", model: "Patrol", year: 2021, vin: "JN8AY2NC5L9350214", branch: "فرع جدة", accountManager: "Noura Al-Qahtani", plate: "JED-7788", brandClass: "Genuine", partDescription: "Rear wiper blade", partNumber: "", requestedQty: 1 },
  { id: "t3", orderNumber: "QP-24-01180", brand: "Hyundai", model: "Sonata", year: 2020, vin: "5NPE34AF4LH012894", branch: "فرع الدمام", accountManager: "Faisal Al-Otaibi", plate: "DAM-4521", brandClass: "Aftermarket", partDescription: "Engine mount", partNumber: "", requestedQty: 2 },
  { id: "t4", orderNumber: "QP-24-01166", brand: "Kia", model: "Sportage", year: 2019, vin: "KNDPMCAC7K7593028", branch: "فرع مكة", accountManager: "Faisal Al-Otaibi", plate: "MAK-3345", brandClass: "OEM", partDescription: "Fuel pump assembly", partNumber: "", requestedQty: 1 },
  { id: "t5", orderNumber: "QP-24-01153", brand: "Toyota", model: "Camry", year: 2022, vin: "4T1G11AK7NU678120", branch: "فرع جدة", accountManager: "Faisal Al-Otaibi", plate: "JED-1190", brandClass: "Genuine", partDescription: "Wheel speed sensor (front)", partNumber: "", requestedQty: 1 },
  { id: "t6", orderNumber: "QP-24-01148", brand: "Nissan", model: "Altima", year: 2020, vin: "1N4BL4BV7LC201956", branch: "فرع الدمام", accountManager: "Noura Al-Qahtani", plate: "DAM-2278", brandClass: "OEM", partDescription: "Ignition coil", partNumber: "", requestedQty: 4 },
];

function TenderView({ flash }: { flash: (t: string, ok?: boolean) => void }) {
  const [queue, setQueue] = useState<TenderItem[]>(TENDER_SEED);
  const [pns, setPns] = useState<Record<string, string>>({});
  const total = TENDER_SEED.length;
  const done = total - queue.length;
  const pct = Math.round((done / total) * 100);

  const confirm = (t: TenderItem) => {
    if (!(pns[t.id] ?? t.partNumber).trim()) {
      flash("Enter a part number first", false);
      return;
    }
    setQueue((q) => q.filter((x) => x.id !== t.id));
    flash("Part number set — item cleared");
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Tender Requests</h3>
            <p className="mt-0.5 text-[12px] text-muted">Review and edit each item, then confirm to clear it from the queue.</p>
          </div>
          <div className="ms-auto flex items-center gap-3 text-[12px]">
            <span className="text-emerald-600 dark:text-emerald-400">Done: {done}</span>
            <span className="text-muted">Remaining: {queue.length}</span>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] font-medium text-muted tnum">{pct}%</span>
        </div>
      </Card>

      {queue.length === 0 ? (
        <Card>
          <EmptyState title="All caught up" hint="No tender items waiting for review." icon={<Sparkles className="h-6 w-6" />} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {queue.map((t) => (
            <Card key={t.id}>
              <div className="mb-3 flex items-start gap-2">
                <BrandChip brand={t.brand} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-accent tnum">{t.orderNumber}</span>
                    <span className="rounded-full bg-panel-2 px-1.5 py-0.5 text-[10px] font-semibold text-sub">{t.brandClass}</span>
                  </div>
                  <div className="text-[13px] font-medium text-ink">
                    {t.brand} {t.model} · {t.year}
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted">
                    {t.branch} · {t.accountManager} · {t.plate}
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Part Description</label>
                  <input className="input" defaultValue={t.partDescription} />
                </div>
                <div>
                  <label className="label">Part Number</label>
                  <input
                    className="input font-mono"
                    placeholder="e.g. 88568-0K010"
                    value={pns[t.id] ?? t.partNumber}
                    onChange={(e) => setPns((p) => ({ ...p, [t.id]: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="label">Requested Qty</label>
                  <input className="input" type="number" defaultValue={t.requestedQty} min={1} />
                </div>
                <div>
                  <label className="label">Brand Class</label>
                  <select className="input" defaultValue={t.brandClass}>
                    <option>Genuine</option>
                    <option>OEM</option>
                    <option>Aftermarket</option>
                  </select>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button onClick={() => flash("Marked unclear — timer paused")} className="btn btn-sm rounded-md">
                  Unclear
                </button>
                <button
                  onClick={() => {
                    setQueue((q) => q.filter((x) => x.id !== t.id));
                    flash("Handed to Purchasing");
                  }}
                  className="btn btn-sm rounded-md"
                >
                  Cannot extract
                </button>
                <button onClick={() => confirm(t)} className="btn-primary btn-sm ms-auto rounded-md">
                  Confirm
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Filter drawer (centered modal)
══════════════════════════════════════════════════════════════════════════ */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <label className="label mb-0">{label}</label>
        {selected.length > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[#0d4151] px-1 text-[10px] font-semibold text-white">
            {selected.length}
          </span>
        )}
      </div>
      <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-line bg-panel p-2">
        {options.map((o) => (
          <label key={o} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-ink hover:bg-surface">
            <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} className="accent-accent" />
            <span className="truncate">{o}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function FilterDrawer({
  onClose,
  activeCount,
  state,
  set,
  clear,
}: {
  onClose: () => void;
  activeCount: number;
  state: {
    amFilter: string[];
    clientFilter: string[];
    branchFilter: string[];
    brandFilter: string[];
    statusFilter: number[];
  };
  set: {
    setAmFilter: (v: string[]) => void;
    setClientFilter: (v: string[]) => void;
    setBranchFilter: (v: string[]) => void;
    setBrandFilter: (v: string[]) => void;
    setStatusFilter: (v: number[]) => void;
  };
  clear: () => void;
}) {
  const statusOpts = [15, 16, 17, 19, 23, 28, 31, 235, 236, 237];
  const toggleStatus = (id: number) =>
    set.setStatusFilter(state.statusFilter.includes(id) ? state.statusFilter.filter((x) => x !== id) : [...state.statusFilter, id]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-3xl rounded-xl2 border border-line bg-panel shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line-2 px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-ink">Advanced Filters</h3>
          {activeCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-[#0d4151] px-2 py-0.5 text-[11px] font-semibold text-white">
              {activeCount} active
            </span>
          )}
          <button onClick={onClose} className="ms-auto rounded-md p-1 text-muted hover:bg-surface hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div>
            <label className="label">Statuses</label>
            <div className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-line bg-panel p-2">
              {statusOpts.map((id) => (
                <label key={id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-ink hover:bg-surface">
                  <input type="checkbox" checked={state.statusFilter.includes(id)} onChange={() => toggleStatus(id)} className="accent-accent" />
                  <Badge tone={st(id).tone}>{st(id).label}</Badge>
                </label>
              ))}
            </div>
          </div>
          <MultiSelect label="Account Managers" options={ACCOUNT_MANAGERS} selected={state.amFilter} onChange={set.setAmFilter} />
          <MultiSelect label="Clients" options={CLIENTS} selected={state.clientFilter} onChange={set.setClientFilter} />
          <MultiSelect label="Branches" options={BRANCHES} selected={state.branchFilter} onChange={set.setBranchFilter} />
          <MultiSelect label="Main Brands" options={BRANDS} selected={state.brandFilter} onChange={set.setBrandFilter} />
        </div>
        <div className="flex items-center gap-2 border-t border-line-2 px-5 py-3.5">
          <button onClick={clear} className="btn btn-sm rounded-md">
            Clear All
          </button>
          <button onClick={onClose} className="btn-primary btn-sm ms-auto rounded-md">
            Show Results
          </button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   Notes modal
══════════════════════════════════════════════════════════════════════════ */
interface Note {
  author: string;
  audience: "Client" | "Internal";
  text: string;
  at: string;
}
const MOCK_NOTES: Note[] = [
  { author: "Faisal Al-Otaibi", audience: "Internal", text: "Vendor Al-Jazira quoted higher than list — checking alt supplier.", at: "2026-07-21T09:14:00" },
  { author: "Noura Al-Qahtani", audience: "Client", text: "تم تأكيد توفر القطعة، التسليم خلال يومين عمل.", at: "2026-07-20T15:42:00" },
];

function NotesModal({
  ctx,
  onClose,
  flash,
}: {
  ctx: { order: Order; item: Item };
  onClose: () => void;
  flash: (t: string, ok?: boolean) => void;
}) {
  const [audience, setAudience] = useState<"Client" | "Internal">("Internal");
  const [text, setText] = useState("");
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl2 border border-line bg-panel shadow-pop" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line-2 px-5 py-3.5">
          <h3 className="text-[15px] font-semibold text-ink">Notes</h3>
          <span className="text-[12px] text-muted tnum">{ctx.order.orderNumber}</span>
          <button onClick={onClose} className="ms-auto rounded-md p-1 text-muted hover:bg-surface hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-64 space-y-3 overflow-y-auto px-5 py-4">
          {MOCK_NOTES.map((n, i) => (
            <div key={i} className="rounded-md border border-line-2 bg-surface/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-[11px]">
                <span className="font-medium text-ink">{n.author}</span>
                <Badge tone={n.audience === "Client" ? "blue" : "gray"}>{n.audience === "Client" ? "To Client" : "Internal"}</Badge>
                <span className="ms-auto text-faint tnum">{new Date(n.at).toLocaleString("en-GB")}</span>
              </div>
              <p className="text-[12.5px] text-sub">{n.text}</p>
            </div>
          ))}
        </div>
        <div className="border-t border-line-2 px-5 py-4">
          <div className="mb-2 flex items-center gap-2">
            <select value={audience} onChange={(e) => setAudience(e.target.value as "Client" | "Internal")} className="rounded-md border border-line bg-panel px-2 py-1.5 text-[12.5px] text-ink">
              <option value="Internal">Internal Only</option>
              <option value="Client">To Client</option>
            </select>
            <label className="flex items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" className="accent-accent" /> Apply to entire RFQ/Order
            </label>
          </div>
          <textarea
            className="input min-h-[64px]"
            placeholder="Add a note…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="mt-2 flex justify-end">
            <button
              onClick={() => {
                if (!text.trim()) {
                  flash("Note text is required", false);
                  return;
                }
                flash("Note added");
                setText("");
              }}
              className="btn-primary btn-sm rounded-md"
            >
              Add Note
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
