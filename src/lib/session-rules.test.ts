import { describe, expect, it } from "vitest";
import {
  isSessionStatusTransitionAllowed,
  SESSION_STATUS_TRANSITIONS,
  sessionItemTotal,
  sessionSubtotal,
} from "./session-rules";

describe("sessionItemTotal", () => {
  it("computes fee × quantity with no discount", () => {
    expect(sessionItemTotal(100, 1)).toBe(100);
  });

  it("subtracts the discount", () => {
    expect(sessionItemTotal(100, 1, 20)).toBe(80);
  });

  it("handles quantity > 1", () => {
    expect(sessionItemTotal(150, 3, 5)).toBe(445);
  });

  it("treats a zero discount as no discount", () => {
    expect(sessionItemTotal(250, 2, 0)).toBe(500);
  });

  // Z-34
  it("floors the total at 0 when the discount exceeds the line amount", () => {
    expect(sessionItemTotal(100, 1, 150)).toBe(0);
  });

  it("floors the total at 0 when the discount exactly equals the line amount (frontière)", () => {
    // Frontière exacte de Z-34 : 100 × 1 − 100 = 0 → plafonné à 0 (pas de −0).
    expect(sessionItemTotal(100, 1, 100)).toBe(0);
  });

  it("keeps a positive remainder when the discount is just below the line amount", () => {
    expect(sessionItemTotal(100, 1, 99.5)).toBe(0.5);
  });
});

describe("sessionSubtotal", () => {
  it("returns 0 for an empty array", () => {
    expect(sessionSubtotal([])).toBe(0);
  });

  it("sums a single item", () => {
    expect(sessionSubtotal([{ fee: 120, quantity: 1 }])).toBe(120);
  });

  it("sums multiple items", () => {
    expect(
      sessionSubtotal([
        { fee: 100, quantity: 2 }, // 200
        { fee: 50, quantity: 1, discount: 10 }, // 40
      ]),
    ).toBe(240);
  });

  it("treats a null discount as zero", () => {
    expect(
      sessionSubtotal([{ fee: 300, quantity: 2, discount: null }]),
    ).toBe(600);
  });

  it("handles a mix of items with and without discounts", () => {
    expect(
      sessionSubtotal([
        { fee: 200, quantity: 1 }, // 200
        { fee: 300, quantity: 2, discount: 50 }, // 550
        { fee: 100, quantity: 3, discount: null }, // 300
      ]),
    ).toBe(1050);
  });

  it("never lets an over-discounted item push the subtotal below zero", () => {
    expect(
      sessionSubtotal([
        { fee: 500, quantity: 1 }, // 500
        { fee: 100, quantity: 1, discount: 500 }, // floored at 0 (Z-34)
      ]),
    ).toBe(500);
  });

  it("returns 0 when every line is over-discounted (subtotal never negative)", () => {
    expect(
      sessionSubtotal([
        { fee: 100, quantity: 1, discount: 250 }, // floored at 0
        { fee: 50, quantity: 2, discount: 100 }, // floored at 0
      ]),
    ).toBe(0);
  });
});

describe("session status transitions", () => {
  it("defines the exact transition whitelist", () => {
    // Z-29 : le graphe reflète le flux réel (closeSession crée la facture en
    // même temps qu'elle passe la séance `completed`).
    // `completed | invoiced → in_progress` : reprise après annulation de la
    // facture liée (réouverture de séance → re-clôture → nouveau numéro).
    expect(SESSION_STATUS_TRANSITIONS).toEqual({
      pending: ["in_progress", "completed"],
      in_progress: ["completed"],
      completed: ["invoiced", "paid", "in_progress"],
      invoiced: ["paid", "in_progress"],
      paid: [],
    });
  });

  it("allows in_progress → completed (closeSession)", () => {
    expect(isSessionStatusTransitionAllowed("in_progress", "completed")).toBe(true);
  });

  it("allows completed → invoiced", () => {
    expect(isSessionStatusTransitionAllowed("completed", "invoiced")).toBe(true);
  });

  it("allows invoiced → paid", () => {
    expect(isSessionStatusTransitionAllowed("invoiced", "paid")).toBe(true);
  });

  it("allows reopening completed | invoiced → in_progress (after invoice cancellation)", () => {
    // BLOQUANT 2 : une facture annulée doit pouvoir laisser la séance repartir
    // en in_progress pour re-clôture et nouveau numéro.
    expect(isSessionStatusTransitionAllowed("completed", "in_progress")).toBe(true);
    expect(isSessionStatusTransitionAllowed("invoiced", "in_progress")).toBe(true);
  });

  it("allows completed → paid (direct settlement, e.g. cash at closing)", () => {
    expect(isSessionStatusTransitionAllowed("completed", "paid")).toBe(true);
  });

  it("does not allow invoicing or paying a session that is still in progress", () => {
    expect(isSessionStatusTransitionAllowed("in_progress", "invoiced")).toBe(false);
    expect(isSessionStatusTransitionAllowed("in_progress", "paid")).toBe(false);
  });

  it("does not allow backwards transitions (invoiced → completed)", () => {
    expect(isSessionStatusTransitionAllowed("invoiced", "completed")).toBe(false);
  });

  it("does not allow any transition from a terminal state (paid)", () => {
    expect(isSessionStatusTransitionAllowed("paid", "completed")).toBe(false);
    expect(isSessionStatusTransitionAllowed("paid", "invoiced")).toBe(false);
  });

  it("does not allow reopening a paid session (paid → in_progress is terminal)", () => {
    // Une séance réglée ne repart jamais en in_progress, même après annulation
    // de la facture : le rééquilibrage se fait côté facture, pas côté séance.
    expect(isSessionStatusTransitionAllowed("paid", "in_progress")).toBe(false);
    expect(isSessionStatusTransitionAllowed("paid", "pending")).toBe(false);
  });

  it("returns false for unknown statuses", () => {
    expect(isSessionStatusTransitionAllowed("unknown", "paid")).toBe(false);
    expect(isSessionStatusTransitionAllowed("completed", "unknown")).toBe(false);
  });
});
