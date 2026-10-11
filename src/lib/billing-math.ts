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

/**
 * Round to 2 decimals (DZD cents) with commercial rounding: **half away from
 * zero**, decided on the exact decimal digits of the value.
 *
 * Why not `Math.round(v * 100) / 100`? Doubles cannot represent most half
 * cents (`2.135 * 100 === 213.49999999999997`, `42.5 * 0.19` is
 * `8.0749999999999993`…), so a value written as an exact half cent in decimal
 * rounds DOWN and silently under-bills one centime per line. Adding
 * `Number.EPSILON` (~2.2e-16) does not help: it is smaller than half the ULP
 * of `v * 100` as soon as `|v| >= 4`, so it never flips the rounding.
 * `toFixed(2)` is not a solution either: it rounds on the exact *binary*
 * value (`(2.675).toFixed(2) === "2.67"`).
 *
 * Instead, this function takes the shortest decimal representation of the
 * double (`String(v)` — i.e. the decimal the caller wrote/intended) and
 * rounds on those digits with pure string/integer arithmetic: no binary
 * approximation takes part in the tie-break. A value already at cent
 * precision is returned untouched (identity), which also preserves full
 * precision for magnitudes beyond the `numeric(12,2)` money domain.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return 0;

  const parts = parseDecimal(String(value));
  // Exponent notation (|v| >= 1e21 or < 1e-6): far outside the money domain,
  // keep the historical numeric rounding for those magnitudes.
  if (!parts) return Math.round(value * 100) / 100;
  // Already exact at cent precision: nothing to round.
  if (parts.fraction.length <= 2) return value;

  const cents = roundToCentsDigits(parts);
  return Number(
    `${parts.negative ? "-" : ""}${cents.slice(0, -2)}.${cents.slice(-2)}`,
  );
}

interface DecimalParts {
  negative: boolean;
  /** Digits before the decimal point (never empty). */
  integer: string;
  /** Digits after the decimal point (may be empty). */
  fraction: string;
}

/** Splits `String(number)` into decimal digits; null on exponent notation. */
function parseDecimal(s: string): DecimalParts | null {
  if (s.includes("e") || s.includes("E")) return null;
  const negative = s.startsWith("-");
  const body = negative ? s.slice(1) : s;
  const dot = body.indexOf(".");
  return {
    negative,
    integer: dot === -1 ? body : body.slice(0, dot),
    fraction: dot === -1 ? "" : body.slice(dot + 1),
  };
}

/**
 * Digits of |value| × 100 rounded to an integer, half away from zero.
 * The tie is decided on the decimal digits only: the first dropped digit
 * being >= 5 rounds up.
 */
function roundToCentsDigits(parts: DecimalParts): string {
  const all = parts.integer + parts.fraction;
  const dropCount = parts.fraction.length - 2;
  const kept = all.slice(0, all.length - dropCount);
  const dropped = all.slice(all.length - dropCount);
  if (dropped.charCodeAt(0) < 53 /* "5" */) return kept;
  return incrementDigits(kept);
}

/** Adds 1 to a decimal digit string, propagating the carry ("1999" → "2000"). */
function incrementDigits(digits: string): string {
  let i = digits.length - 1;
  while (i >= 0 && digits[i] === "9") i -= 1;
  if (i < 0) return `1${"0".repeat(digits.length)}`;
  return (
    digits.slice(0, i) +
    String.fromCharCode(digits.charCodeAt(i) + 1) +
    "0".repeat(digits.length - i - 1)
  );
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

/**
 * Tax amount of a line: base × rate/100, rounded to 2 decimals.
 *
 * Computed in **integer cents** (`base_cents × rate / 100`) so the half-cent
 * tie of the division is decided by exact integer arithmetic:
 * 42.50 × 19 % = 4250 × 19 / 100 = 807.5 cents → 808 cents = 8.08 DZD.
 * Computing it in floats first (`42.5 × 0.19 = 8.0749999999999993…`) rounds
 * down to 8.07 and under-bills one centime per affected line (Z-17).
 */
export function lineTax(
  quantity: number,
  unitPrice: number,
  taxRate?: number | null,
): number {
  const rate = taxRate ?? 0;
  // lineBase() is cent-precision, so ×100 recovers the integer cents exactly
  // within the numeric(12,2) money domain (rounding error < 0.02 centime).
  const baseCents = Math.round(lineBase(quantity, unitPrice) * 100);
  // baseCents × rate is an exact integer — worst case in the money domain is
  // 9 999 999 999 999 cents (max numeric(12,2)) × rate 100 = 1e15, still
  // below 2^53 (9.007e15), so no precision loss. A tie (…50 / 100) is
  // exactly representable, so Math.round is exact here.
  const scaled = baseCents * rate;
  const cents = (scaled < 0 ? -1 : 1) * Math.round(Math.abs(scaled) / 100);
  return cents / 100;
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
