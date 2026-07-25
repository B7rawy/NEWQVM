/**
 * THE ROUTABLE PAGE CATALOG.
 *
 * "Which status shows on which page" needs a vocabulary of pages, and that vocabulary has to live
 * somewhere both the workflow builder and the list endpoints agree on. Declaring it here — rather
 * than letting an admin type a free-text route — means a page key can be validated at save time
 * instead of failing silently at read time, and it means renaming a route is one edit.
 *
 * `wired` is deliberately part of the record and deliberately honest. Several screens in this app
 * are still mock or partially built; routing a live status to one of them would make real work
 * disappear from the queue people actually watch. The builder shows these differently and activation
 * warns about them, so nobody discovers it from a customer phone call.
 *
 * `personas` is who normally looks at that page. It drives ordering in the picker and lets the
 * activation check ask the useful question: "you routed this to a vendor screen, but the step is
 * owned by purchasing — did you mean that?"
 */

export interface RoutablePage {
  /** Stable key stored in workflow_steps.pages. Never the URL — routes move, keys must not. */
  key: string;
  path: string;
  labelEn: string;
  labelAr: string;
  /** Which record kinds can appear here. A page that lists orders cannot show a vendor quote. */
  entities: Array<"rfq" | "order" | "quote">;
  personas: Array<"internal" | "workshop" | "vendor">;
  /** False when the screen is still mock or not fed by a real endpoint yet. */
  wired: boolean;
}

export const ROUTABLE_PAGES: RoutablePage[] = [
  { key: "rfqs", path: "/rfqs", labelEn: "Requests", labelAr: "الطلبات",
    entities: ["rfq"], personas: ["internal"], wired: true },
  { key: "orders", path: "/orders", labelEn: "Orders", labelAr: "أوامر الشراء",
    entities: ["order"], personas: ["internal"], wired: true },
  { key: "workshop_requests", path: "/workshop/requests", labelEn: "Workshop · Requests", labelAr: "الورشة · الطلبات",
    entities: ["rfq"], personas: ["workshop"], wired: true },
  { key: "workshop_orders", path: "/workshop/orders", labelEn: "Workshop · Orders", labelAr: "الورشة · الأوامر",
    entities: ["order"], personas: ["workshop"], wired: true },
  { key: "vendor_quotations", path: "/vendor/quotations", labelEn: "Vendor · Quotations", labelAr: "المورّد · التسعيرات",
    entities: ["quote", "rfq"], personas: ["vendor"], wired: true },
  { key: "vendor_confirmed", path: "/vendor/confirmed", labelEn: "Vendor · Confirmed", labelAr: "المورّد · المؤكدة",
    entities: ["order"], personas: ["vendor"], wired: true },
  { key: "internal", path: "/internal", labelEn: "Internal desk", labelAr: "المكتب الداخلي",
    entities: ["rfq", "order"], personas: ["internal"], wired: false },
];

const BY_KEY = new Map(ROUTABLE_PAGES.map((p) => [p.key, p]));

export const isPageKey = (k: string): boolean => BY_KEY.has(k);
export const pageByKey = (k: string): RoutablePage | undefined => BY_KEY.get(k);
