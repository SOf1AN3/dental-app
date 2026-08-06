/**
 * Pure business rules for clinical sessions ("Séance clinique").
 *
 * This module is intentionally dependency-free: no "use server", no Drizzle,
 * no auth, no database. Everything here is a pure function or constant so the
 * rules can be unit-tested in isolation (see session-rules.test.ts).
 */

/**
 * Line-item total: fee × quantity − discount.
 *
 * fee/quantity are integers; discount is an integer that is never negative.
 * An omitted discount (undefined) is treated as 0.
 */
export function sessionItemTotal(
  fee: number,
  quantity: number,
  discount?: number,
): number {
  return fee * quantity - (discount ?? 0);
}

/**
 * Session subtotal: sum of every line-item total, starting at 0.
 *
 * `discount` may be `null` (the DB column is nullable), which is treated as 0.
 */
export function sessionSubtotal(
  items: Array<{ fee: number; quantity: number; discount?: number | null }>,
): number {
  return items.reduce(
    (sum, item) =>
      sum + sessionItemTotal(item.fee, item.quantity, item.discount ?? undefined),
    0,
  );
}

/**
 * Whitelist of allowed clinical session status transitions.
 * No skipping and no backwards transitions; `paid` is terminal.
 */
export const SESSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  completed: ["invoiced"],
  invoiced: ["paid"],
};

/**
 * Returns true when the `from → to` transition is part of the whitelist.
 * Unknown statuses are never allowed.
 */
export function isSessionStatusTransitionAllowed(
  from: string,
  to: string,
): boolean {
  return (SESSION_STATUS_TRANSITIONS[from] ?? []).includes(to);
}
