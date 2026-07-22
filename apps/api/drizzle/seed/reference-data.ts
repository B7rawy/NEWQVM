/**
 * Reference vocabulary — seed data.
 *
 * The STATUS vocabularies (item_status, vendor_status) are preserved EXACTLY as the old system
 * (Kareem's instruction: "الحالات خليها نفس القديم"). `legacyId` = the old list_data_id, so the
 * Phase-6 migration can map old rows onto these directly.
 *
 * The one intentional cleanup (engineering call): the old duplicate `Canceled` (18) and
 * `Cancelled` (268) collapse into a single canonical `cancelled` row carrying BOTH legacy ids.
 * Everything else is 1:1 with the old vocabulary.
 *
 * Source: docs/reference/old-system-schema.md §1.3 (list 3) and §1.4 (list 15).
 */

export type RefRow = {
  code: string;
  labelEn: string;
  labelAr: string;
  sortOrder: number;
  legacyIds: number[]; // usually 1; >1 only where old duplicates were merged
};

/** item_status — old list 3 (English vocabulary, preserved). */
export const ITEM_STATUSES: RefRow[] = [
  { code: "new_rfq", labelEn: "New RFQ", labelAr: "طلب تسعير جديد", sortOrder: 10, legacyIds: [15] },
  { code: "extract_pn", labelEn: "Extract PN", labelAr: "استخراج رقم القطعة", sortOrder: 20, legacyIds: [236] },
  { code: "ready_for_quotation", labelEn: "Ready For Quotation", labelAr: "جاهز للتسعير", sortOrder: 30, legacyIds: [235] },
  { code: "tendering", labelEn: "Tendering", labelAr: "جاري التسعير", sortOrder: 40, legacyIds: [16] },
  { code: "sent_to_vendor", labelEn: "Sent To Vendor", labelAr: "أُرسل للمورّد", sortOrder: 45, legacyIds: [237] },
  { code: "added_by_vendor", labelEn: "Added by Vendor", labelAr: "أُضيف بواسطة المورّد", sortOrder: 47, legacyIds: [267] },
  { code: "priced", labelEn: "Priced", labelAr: "تم التسعير", sortOrder: 50, legacyIds: [17] },
  { code: "unavailable", labelEn: "Unavailable", labelAr: "غير متوفر", sortOrder: 55, legacyIds: [20] },
  { code: "confirmed", labelEn: "Confirmed", labelAr: "مؤكَّد", sortOrder: 60, legacyIds: [19] },
  { code: "processing", labelEn: "Processing", labelAr: "قيد التجهيز", sortOrder: 70, legacyIds: [21] },
  { code: "out_for_delivery", labelEn: "Out for Delivery", labelAr: "خرج للتوصيل", sortOrder: 80, legacyIds: [22] },
  { code: "dn_sign_pending", labelEn: "DN Sign Pending", labelAr: "بانتظار توقيع إذن التسليم", sortOrder: 85, legacyIds: [213] },
  { code: "delivered", labelEn: "Delivered", labelAr: "تم التسليم", sortOrder: 90, legacyIds: [23] },
  { code: "pending_invoice", labelEn: "Pending Invoice", labelAr: "بانتظار الفاتورة", sortOrder: 100, legacyIds: [25] },
  { code: "invoice_issued", labelEn: "Invoice Issued", labelAr: "تم إصدار الفاتورة", sortOrder: 110, legacyIds: [26] },
  { code: "cancellation_request", labelEn: "Cancellation Request", labelAr: "طلب إلغاء", sortOrder: 120, legacyIds: [24] },
  { code: "cancelled", labelEn: "Cancelled", labelAr: "ملغى", sortOrder: 125, legacyIds: [18, 268] }, // merged duplicate
  { code: "claim_sent", labelEn: "Claim Sent", labelAr: "تم إرسال مطالبة", sortOrder: 130, legacyIds: [27] },
  { code: "return_request", labelEn: "Return Request", labelAr: "طلب إرجاع", sortOrder: 140, legacyIds: [28] },
  { code: "return", labelEn: "Return", labelAr: "إرجاع", sortOrder: 150, legacyIds: [29] },
  { code: "rn_sign_pending", labelEn: "RN Sign Pending", labelAr: "بانتظار توقيع إذن المرتجع", sortOrder: 155, legacyIds: [214] },
  { code: "pending_credit_note", labelEn: "Pending Credit Note", labelAr: "بانتظار إشعار الخصم", sortOrder: 160, legacyIds: [215] },
  { code: "credit_note_issued", labelEn: "Credit Note Issued", labelAr: "تم إصدار إشعار الخصم", sortOrder: 170, legacyIds: [30] },
  { code: "settled", labelEn: "Settled", labelAr: "تمت التسوية", sortOrder: 180, legacyIds: [31] },
];

/** vendor_status — old list 15 (Arabic vocabulary, preserved). */
export const VENDOR_STATUSES: RefRow[] = [
  { code: "rfq", labelEn: "RFQ Sent", labelAr: "طلب تسعير", sortOrder: 10, legacyIds: [157] },
  { code: "priced", labelEn: "Priced", labelAr: "تم التسعير", sortOrder: 20, legacyIds: [158] },
  { code: "prior_price_confirmed", labelEn: "Prior Price Confirmed", labelAr: "تأكيد سعر سابق", sortOrder: 25, legacyIds: [207] },
  { code: "confirmed", labelEn: "Confirmed Order", labelAr: "طلب مؤكد", sortOrder: 30, legacyIds: [159] },
  { code: "cancelled", labelEn: "Cancelled", labelAr: "الغاء", sortOrder: 35, legacyIds: [160] },
  { code: "unavailable", labelEn: "Unavailable", labelAr: "غير متوفر", sortOrder: 40, legacyIds: [161] },
  { code: "processing", labelEn: "Processing", labelAr: "قيد التجهيز", sortOrder: 50, legacyIds: [162] },
  { code: "ready_for_pickup", labelEn: "Ready for Pickup", labelAr: "جاهز للاستلام", sortOrder: 60, legacyIds: [163] },
  { code: "delivered", labelEn: "Delivered", labelAr: "تم التسليم", sortOrder: 70, legacyIds: [164] },
  { code: "invoice_uploaded", labelEn: "Invoice Uploaded", labelAr: "تم رفع الفاتورة", sortOrder: 80, legacyIds: [165] },
  { code: "return_request", labelEn: "Return Request", labelAr: "طلب ارجاع", sortOrder: 90, legacyIds: [166] },
  { code: "returned", labelEn: "Returned", labelAr: "تم الارجاع", sortOrder: 100, legacyIds: [167] },
  { code: "return_invoice_uploaded", labelEn: "Return Invoice Uploaded", labelAr: "تم رفع فاتورة المرتجع", sortOrder: 110, legacyIds: [168] },
  { code: "settled", labelEn: "Settled", labelAr: "تم التسوية", sortOrder: 120, legacyIds: [169] },
];
