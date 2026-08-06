import { describe, expect, it } from "vitest";
import { cn, formatCurrency, formatDate } from "./utils";

describe("cn", () => {
  it("merges conflicting tailwind classes", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("ignores falsy values", () => {
    expect(cn("a", null, undefined, false, "", "b")).toBe("a b");
  });

  it("returns an empty string when called with no inputs", () => {
    expect(cn()).toBe("");
  });
});

describe("formatCurrency", () => {
  it("formats a DZD amount in dinars", () => {
    expect(formatCurrency(125)).toContain("125");
  });

  it("formats whole dinars", () => {
    expect(formatCurrency(50)).toContain("50");
    expect(formatCurrency(50000).replace(/\s/g, "")).toContain("50000");
  });

  it("formats zero with two decimal places", () => {
    expect(formatCurrency(0)).toContain("0,00");
  });
});

describe("formatDate", () => {
  it("formats a Date input", () => {
    expect(formatDate(new Date("2024-01-15T10:30:00Z"))).toBeTruthy();
  });

  it("formats a date-string input", () => {
    expect(formatDate("2024-01-15")).toBeTruthy();
  });

  it("throws on invalid input", () => {
    expect(() => formatDate(new Date("not-a-date"))).toThrow();
    expect(() => formatDate("not-a-date")).toThrow();
  });
});
