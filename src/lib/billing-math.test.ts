import { describe, expect, it } from "vitest";
import {
  docTotals,
  lineBase,
  lineDiscount,
  lineTax,
  lineTotal,
  recalcInvoiceStatus,
  round2,
} from "./billing-math";

describe("round2", () => {
  it("rounds to two decimals", () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(1.999)).toBe(2);
    expect(round2(1900)).toBe(1900);
  });

  it("avoids float drift on repeated sums", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it("rounds exact half cents away from zero (regression Z-17)", () => {
    // 2.135 * 100 vaut 213.49999999999997 en flottant : l'arrondi doit se
    // décider sur les chiffres décimaux, jamais sur la valeur binaire.
    expect(round2(2.135)).toBe(2.14);
    expect(round2(8.075)).toBe(8.08);
    expect(round2(34.105)).toBe(34.11);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68); // toFixed(2) rendrait "2.67"
    expect(round2(-2.135)).toBe(-2.14); // commercial : half away from zero
  });

  it("leaves values already at cent precision untouched", () => {
    expect(round2(42.5)).toBe(42.5);
    expect(round2(99.99)).toBe(99.99);
    expect(round2(1e12)).toBe(1e12);
  });
});

describe("lineBase", () => {
  it("multiplies quantity by unit price", () => {
    expect(lineBase(3, 19.99)).toBe(59.97);
    expect(lineBase(1, 10000)).toBe(10000);
  });

  it("handles zero quantity", () => {
    expect(lineBase(0, 500)).toBe(0);
  });
});

describe("lineTax", () => {
  it("applies a 19% rate on the base", () => {
    expect(lineTax(1, 10000, 19)).toBe(1900);
  });

  it("rounds the tax amount to two decimals", () => {
    // base = 99.99, tax = 18.9981 → 19
    expect(lineTax(3, 33.33, 19)).toBe(19);
  });

  it("treats null and undefined rates as zero", () => {
    expect(lineTax(2, 500, null)).toBe(0);
    expect(lineTax(2, 500)).toBe(0);
  });

  it("applies a 0% rate without adding anything", () => {
    expect(lineTax(4, 250, 0)).toBe(0);
  });

  it("rounds half-cent tax amounts up (regression Z-17)", () => {
    // 42,50 × 19 % = 8,075 → 8,08 (et non 8,07) ; de même pour les lignes
    // à 49,50 / 86,50 / 179,50 qui étaient sous-perçues d'un centime.
    expect(lineTax(1, 42.5, 19)).toBe(8.08);
    expect(lineTax(1, 49.5, 19)).toBe(9.41);
    expect(lineTax(1, 86.5, 19)).toBe(16.44);
    expect(lineTax(1, 179.5, 19)).toBe(34.11);
  });
});

describe("lineDiscount", () => {
  it("treats null and undefined as zero", () => {
    expect(lineDiscount(null)).toBe(0);
    expect(lineDiscount()).toBe(0);
  });

  it("returns the discount as given", () => {
    expect(lineDiscount(150.5)).toBe(150.5);
  });
});

describe("lineTotal", () => {
  it("computes base + tax − discount", () => {
    // base 10000 + tax 1900 − remise 400 = 11500
    expect(lineTotal({ quantity: 1, unitPrice: 10000, taxRate: 19, discount: 400 })).toBe(11500);
  });

  it("equals base when no tax and no discount", () => {
    expect(lineTotal({ quantity: 2, unitPrice: 750 })).toBe(1500);
  });

  it("treats missing tax and discount as zero", () => {
    expect(
      lineTotal({ quantity: 2, unitPrice: 750, taxRate: null, discount: null })
    ).toBe(1500);
  });

  it("includes a correctly rounded half-cent tax", () => {
    // 42,50 + 8,08 = 50,58 ; 179,50 + 34,11 − 10 = 203,61
    expect(lineTotal({ quantity: 1, unitPrice: 42.5, taxRate: 19 })).toBe(50.58);
    expect(
      lineTotal({ quantity: 1, unitPrice: 179.5, taxRate: 19, discount: 10 })
    ).toBe(203.61);
  });
});

describe("docTotals", () => {
  it("returns zeros for an empty document", () => {
    expect(docTotals([])).toEqual({
      subtotal: 0,
      taxTotal: 0,
      discountTotal: 0,
      total: 0,
    });
  });

  it("computes subtotal, tax, discount and total across mixed lines", () => {
    const totals = docTotals([
      { quantity: 1, unitPrice: 10000, taxRate: 19 },        // base 10000, tax 1900
      { quantity: 2, unitPrice: 2500, taxRate: 0, discount: 500 }, // base 5000, tax 0, remise 500
      { quantity: 3, unitPrice: 33.33, taxRate: 19 },        // base 99.99, tax 19
    ]);
    expect(totals.subtotal).toBe(15099.99);
    expect(totals.taxTotal).toBe(1919);
    expect(totals.discountTotal).toBe(500);
    expect(totals.total).toBe(16518.99);
  });

  it("keeps total equal to subtotal when no tax applies", () => {
    const totals = docTotals([{ quantity: 1, unitPrice: 800 }]);
    expect(totals.total).toBe(totals.subtotal);
    expect(totals.taxTotal).toBe(0);
  });

  it("is consistent with the sum of line totals", () => {
    const lines = [
      { quantity: 1, unitPrice: 10000, taxRate: 19 },
      { quantity: 2, unitPrice: 2500, taxRate: 9, discount: 300 },
    ];
    const totals = docTotals(lines);
    const sumOfLines = round2(lines.reduce((s, l) => s + lineTotal(l), 0));
    expect(totals.total).toBe(sumOfLines);
  });

  it("is consistent with the sum of line totals on half-cent lines", () => {
    // Cas Z-17 : des lignes dont la TVA tombe pile sur un demi-centime.
    const lines = [
      { quantity: 1, unitPrice: 42.5, taxRate: 19 },        // tax 8,08
      { quantity: 1, unitPrice: 179.5, taxRate: 19, discount: 10 }, // tax 34,11
      { quantity: 3, unitPrice: 33.33, taxRate: 19 },       // base 99,99, tax 19
    ];
    const totals = docTotals(lines);
    expect(totals.subtotal).toBe(321.99);
    expect(totals.taxTotal).toBe(61.19);   // 8,08 + 34,11 + 19,00
    expect(totals.discountTotal).toBe(10);
    expect(totals.total).toBe(373.18);     // 321,99 + 61,19 − 10
    const sumOfLines = round2(lines.reduce((s, l) => s + lineTotal(l), 0));
    expect(totals.total).toBe(sumOfLines);
  });
});

describe("recalcInvoiceStatus", () => {
  const total = 11900;

  it("marks paid when payments reach the total", () => {
    expect(recalcInvoiceStatus("sent", total, total)).toBe("paid");
    expect(recalcInvoiceStatus("draft", total, total + 50)).toBe("paid");
  });

  it("marks partially_paid for a positive partial payment", () => {
    expect(recalcInvoiceStatus("sent", total, 5000)).toBe("partially_paid");
  });

  it("upgrades overdue invoices too", () => {
    expect(recalcInvoiceStatus("overdue", total, 2000)).toBe("partially_paid");
    expect(recalcInvoiceStatus("overdue", total, total)).toBe("paid");
  });

  it("keeps the current status when no payment exists", () => {
    expect(recalcInvoiceStatus("draft", total, 0)).toBe("draft");
    expect(recalcInvoiceStatus("sent", total, 0)).toBe("sent");
  });

  it("never resurrects a cancelled invoice", () => {
    expect(recalcInvoiceStatus("cancelled", total, total)).toBe("cancelled");
    expect(recalcInvoiceStatus("cancelled", total, 100)).toBe("cancelled");
  });

  it("ignores zero-total invoices", () => {
    expect(recalcInvoiceStatus("draft", 0, 0)).toBe("draft");
  });
});
