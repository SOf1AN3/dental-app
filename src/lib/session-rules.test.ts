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
});

describe("session status transitions", () => {
  it("defines the exact transition whitelist", () => {
    expect(SESSION_STATUS_TRANSITIONS).toEqual({
      completed: ["invoiced"],
      invoiced: ["paid"],
    });
  });

  it("allows completed → invoiced", () => {
    expect(isSessionStatusTransitionAllowed("completed", "invoiced")).toBe(true);
  });

  it("allows invoiced → paid", () => {
    expect(isSessionStatusTransitionAllowed("invoiced", "paid")).toBe(true);
  });

  it("does not allow skipping invoiced (completed → paid)", () => {
    expect(isSessionStatusTransitionAllowed("completed", "paid")).toBe(false);
  });

  it("does not allow backwards transitions (invoiced → completed)", () => {
    expect(isSessionStatusTransitionAllowed("invoiced", "completed")).toBe(false);
  });

  it("does not allow any transition from a terminal state (paid)", () => {
    expect(isSessionStatusTransitionAllowed("paid", "completed")).toBe(false);
    expect(isSessionStatusTransitionAllowed("paid", "invoiced")).toBe(false);
  });

  it("returns false for unknown statuses", () => {
    expect(isSessionStatusTransitionAllowed("unknown", "paid")).toBe(false);
    expect(isSessionStatusTransitionAllowed("completed", "unknown")).toBe(false);
  });
});
