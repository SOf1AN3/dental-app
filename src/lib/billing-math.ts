/**
 * Pure billing math for invoices and quotes ("Facturation").
 *
 * This module is intentionally dependency-free: no "use server", no Drizzle,
 * no auth, no database. Everything here is a pure function or constant so the
 * rules can be unit-tested in isolation (see billing-math.test.ts) and reused
 * on both the server (authoritative totals) and the client (live preview).
 *
 * Business formula (FACT-5):
 *
 *   line_base      = quantity × unit_price
 *   line_tax       = round2(line_base × tax_rate / 100)
 *   line_discount  = discount (absolute amount, never applied on tax)
 *   line_total     = line_base + line_tax − line_discount
 *
 *   doc_subtotal      = Σ line_base
 *   doc_tax_total     = Σ line_tax
 *   doc_discount_total = Σ line_discount
 *   doc_total         = doc_subtotal + doc_tax_total − doc_discount_total
 *
 * Money is stored as numeric(12,2) read into JS floats, so every aggregate is
 * rounded to 2 decimals at the boundary (round2) to avoid drift.
 */

/** Round to 2 decimals (DZD cents), guarding against float drift. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export interface BillableLine {
  quantity: number;
  unitPrice: number;
  /** Integer percent (0–100); null/undefined treated as 0. */
  taxRate?: number | null;
  /** Absolute amount subtracted after tax; null/undefined treated as 0. */
  discount?: number | null;
}

/** Base amount of a line: quantity × unit price. */
export function lineBase(quantity: number, unitPrice: number): number {
  return round2(quantity * unitPrice);
}

/** Tax amount of a line: base × rate/100, rounded to 2 decimals. */
export function lineTax(
  quantity: number,
  unitPrice: number,
  taxRate?: number | null,
): number {
  const rate = taxRate ?? 0;
  return round2(lineBase(quantity, unitPrice) * (rate / 100));
}

/** Discount of a line (absolute amount); null/undefined treated as 0. */
export function lineDiscount(discount?: number | null): number {
  return discount ?? 0;
}

/** Final total of a line: base + tax − discount. */
export function lineTotal(line: BillableLine): number {
  return round2(
    lineBase(line.quantity, line.unitPrice) +
      lineTax(line.quantity, line.unitPrice, line.taxRate) -
      lineDiscount(line.discount),
  );
}

export interface DocumentTotals {
  subtotal: number;
  taxTotal: number;
  discountTotal: number;
  total: number;
}

/**
 * Document-level totals for an invoice or quote, computed from its lines.
 * Each aggregate is rounded independently so stored columns stay consistent
 * with the sum of displayed rows.
 */
export function docTotals(lines: BillableLine[]): DocumentTotals {
  const subtotal = round2(lines.reduce((s, l) => s + lineBase(l.quantity, l.unitPrice), 0));
  const taxTotal = round2(lines.reduce((s, l) => s + lineTax(l.quantity, l.unitPrice, l.taxRate), 0));
  const discountTotal = round2(lines.reduce((s, l) => s + lineDiscount(l.discount), 0));
  const total = round2(subtotal + taxTotal - discountTotal);
  return { subtotal, taxTotal, discountTotal, total };
}

export type InvoiceStatus =
  | "draft"
  | "sent"
  | "paid"
  | "partially_paid"
  | "overdue"
  | "cancelled";

/**
 * Status recalculation rule after a payment (specs §10.2):
 * - `paid`    when Σ payments ≥ invoice total (and total > 0)
 * - `partially_paid` when Σ payments > 0
 * - unchanged otherwise.
 *
 * A cancelled invoice is never resurrected: it stays cancelled regardless of
 * payments (the action layer additionally refuses new payments on it).
 */
export function recalcInvoiceStatus(
  current: InvoiceStatus,
  invoiceTotal: number,
  paidAmount: number,
): InvoiceStatus {
  if (current === "cancelled") return current;
  if (invoiceTotal <= 0) return current;
  if (paidAmount >= invoiceTotal) return "paid";
  if (paidAmount > 0) return "partially_paid";
  return current;
}
