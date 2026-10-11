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
 *
 * Z-34 — the result is floored at 0. The sentence above describes what
 * *callers are expected* to pass, but nothing enforced it: a stored row whose
 * discount exceeds `fee × quantity` produced a negative line total, and a
 * negative line corrupted `sessionSubtotal()` (and any patient-facing total
 * derived from it). A line can never owe the patient money.
 */
export function sessionItemTotal(
  fee: number,
  quantity: number,
  discount?: number,
): number {
  return Math.max(0, fee * quantity - (discount ?? 0));
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
 * Z-29 — Whitelist of allowed clinical session status transitions.
 *
 * The real status domain is the PostgreSQL enum `clinical_session_status`:
 * `pending | in_progress | completed | invoiced | paid` (see
 * `src/lib/db/schema/sessions.ts` and drizzle/0010). The retained flow, which
 * now matches what the actions actually do:
 *
 *   pending → in_progress → completed → invoiced → paid
 *                             │            │
 *                             └────────────┴──▶ paid
 *
 * Rationale for each edge:
 * - `closeSession` claims the session with `status = 'in_progress'` and sets
 *   it to `completed` in the same transaction that CREATES the invoice
 *   (`draft`): `completed` therefore means "session closed, draft invoice
 *   created" — that is why the invoice exists before `invoiced` is reached;
 * - `updateSessionStatus(…, "invoiced")` mirrors the invoice being sent
 *   (`invoices.status = 'sent'`);
 * - `paid` is reached by `recordPayment` (invoice fully settled) or by
 *   `updateSessionStatus(…, "paid")` (manual settlement). `completed → paid`
 *   is deliberately allowed: a patient can settle the invoice without it ever
 *   being "sent" (direct cash payment at closing). Requiring the detour
 *   through `invoiced` would force a meaningless "sent" step before encaissement;
 * - `in_progress → invoiced | paid` is refused: no invoice exists before
 *   closing, so there is nothing to send or settle;
 * - `pending` is only the column DEFAULT (legacy rows); every insert in the
 *   codebase writes `in_progress` explicitly. The edge to `in_progress`
 *   documents the intended "start" transition; `pending → completed` keeps
 *   legacy rows closable.
 * - `paid` is terminal; backwards transitions are never allowed.
 * - `completed | invoiced → in_progress` — REOUVERTURE après annulation de la
 *   facture liée (`updateInvoiceStatus` vers `cancelled`) : le verrou
 *   « séance déjà facturée » (`lockSessionForItemEdit`) exclut désormais les
 *   factures `cancelled`, et une re-clôture (`closeSession`, qui exige
 *   `in_progress`) attribue une NOUVELLE facture avec un nouveau numéro. Sans
 *   ces deux arêtes, une facture annulée laissait la séance figée à jamais et
 *   AUCUN chemin de re-facturation n'existait. Elles ne servent QUE cette
 *   réconciliation : `updateSessionStatus` rejette par ailleurs toute cible
 *   hors `completed | invoiced | paid` (contrôle runtime — le paramètre
 *   Server Action n'est pas validé par Zod), donc un appelant ne peut pas
 *   régresser une séance facturée via cette action.
 *
 * Unknown statuses are never allowed (see `isSessionStatusTransitionAllowed`).
 */
export const SESSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: ["invoiced", "paid", "in_progress"],
  invoiced: ["paid", "in_progress"],
  paid: [],
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
