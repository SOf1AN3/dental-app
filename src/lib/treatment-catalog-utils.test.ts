import { describe, expect, it } from "vitest";
import {
  matchesCatalogQuery,
  normalizeForSearch,
  type CatalogOption,
} from "./treatment-catalog-utils";

function option(overrides: Partial<CatalogOption> = {}): CatalogOption {
  return {
    id: "opt-1",
    name: "Extraction dentaire",
    code: "EXT01",
    price: 2500,
    ...overrides,
  };
}

describe("normalizeForSearch", () => {
  it("lowercases and trims accents from a plain string", () => {
    expect(normalizeForSearch("Extraction")).toBe("extraction");
  });

  it("strips diacritics", () => {
    expect(normalizeForSearch("Éxtraction")).toBe("extraction");
    expect(normalizeForSearch("Carie dentaire")).toBe("carie dentaire");
  });

  it("handles mixed-case accented strings", () => {
    expect(normalizeForSearch("DÉTARTRAGE")).toBe("detartrage");
  });
});

describe("matchesCatalogQuery", () => {
  it("matches by name case-insensitively", () => {
    expect(matchesCatalogQuery(option(), "extraction")).toBe(true);
    expect(matchesCatalogQuery(option(), "EXTRACTION")).toBe(true);
  });

  it("matches by name accent-insensitively", () => {
    expect(matchesCatalogQuery(option(), "éxtraction")).toBe(true);
    expect(matchesCatalogQuery(option({ name: "Détartrage" }), "detartrage")).toBe(true);
  });

  it("matches by code", () => {
    expect(matchesCatalogQuery(option(), "EXT01")).toBe(true);
    expect(matchesCatalogQuery(option({ code: "ABC-12" }), "abc")).toBe(true);
  });

  it("matches partial substrings", () => {
    expect(matchesCatalogQuery(option(), "extract")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesCatalogQuery(option(), "carie")).toBe(false);
    expect(matchesCatalogQuery(option({ code: null }), "EXT01")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(matchesCatalogQuery(option(), "")).toBe(true);
  });
});
