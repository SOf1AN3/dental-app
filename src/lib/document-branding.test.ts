import { describe, expect, it } from "vitest";
import {
  FALLBACK_A5_TEMPLATE,
  DEFAULT_DOCUMENT_BRANDING,
  buildA5Template,
  computeAge,
  resolveBranding,
  resolveFooter,
} from "./document-branding";

describe("resolveBranding", () => {
  it("returns defaults for null/undefined", () => {
    expect(resolveBranding(null)).toEqual(DEFAULT_DOCUMENT_BRANDING);
    expect(resolveBranding(undefined)).toEqual(DEFAULT_DOCUMENT_BRANDING);
  });

  it("fills missing fields from defaults and trims tagline/footer", () => {
    const b = resolveBranding({ template: "bold" });
    expect(b.template).toBe("bold");
    expect(b.primary).toBe(DEFAULT_DOCUMENT_BRANDING.primary);
    expect(b.tagline).toBeNull();
  });

  it("drops invalid hex colors", () => {
    const b = resolveBranding({ primary: "red" as unknown as string });
    expect(b.template).toBe(DEFAULT_DOCUMENT_BRANDING.template);
    expect(b.primary).toBe(DEFAULT_DOCUMENT_BRANDING.primary);
  });

  it("keeps valid colors", () => {
    const b = resolveBranding({ primary: "#abcdef" });
    expect(b.primary).toBe("#abcdef");
  });
});

describe("buildA5Template", () => {
  it("returns the fallback template when no clinic", () => {
    expect(buildA5Template(null)).toEqual(FALLBACK_A5_TEMPLATE);
    expect(buildA5Template(undefined)).toEqual(FALLBACK_A5_TEMPLATE);
  });

  it("resolves branding and urls for a clinic", () => {
    const t = buildA5Template(
      {
        name: "Cabinet Test",
        address: "10 rue X",
        watermarkEnabled: true,
        documentBranding: { template: "corporate", primary: "#1e3a5f" },
      },
      { logoUrl: "logo-key", headerUrl: "header-key" },
    );
    expect(t.name).toBe("Cabinet Test");
    expect(t.address).toBe("10 rue X");
    expect(t.watermarkEnabled).toBe(true);
    expect(t.logoUrl).toBe("logo-key");
    expect(t.headerUrl).toBe("header-key");
    expect(t.branding.template).toBe("corporate");
    expect(t.branding.primary).toBe("#1e3a5f");
    expect(t.branding.secondary).toBe(DEFAULT_DOCUMENT_BRANDING.secondary);
  });

  it("coerces empty name to fallback and null urls", () => {
    const t = buildA5Template({ name: "" }, {});
    expect(t.name).toBe(FALLBACK_A5_TEMPLATE.name);
    expect(t.logoUrl).toBeNull();
  });
});

describe("resolveFooter", () => {
  const base = buildA5Template(
    {
      name: "Cabinet",
      address: "Rue A",
      phone: "0550123456",
      email: "a@b.c",
      legalInfo: "RC 123",
    },
    {},
  );

  it("prefers the explicit branding footer", () => {
    const t = { ...base, branding: { ...base.branding, footer: "Merci !" } };
    expect(resolveFooter(t)).toBe("Merci !");
  });

  it("derives a footer from contact + legal info when empty", () => {
    expect(resolveFooter(base)).toContain("Rue A");
    expect(resolveFooter(base)).toContain("Tél: 0550123456");
    expect(resolveFooter(base)).toContain("Email: a@b.c");
    expect(resolveFooter(base)).toContain("RC 123");
  });

  it("omits empty contact lines", () => {
    const t = buildA5Template({ name: "Cabinet", address: "Rue A" }, {});
    expect(resolveFooter(t)).toBe("Rue A");
  });
});

describe("computeAge", () => {
  it("returns null for unknown/invalid", () => {
    expect(computeAge(null)).toBeNull();
    expect(computeAge(undefined)).toBeNull();
    expect(computeAge("not-a-date")).toBeNull();
  });

  it("computes age on a given date", () => {
    const on = new Date("2026-08-28");
    expect(computeAge("1990-01-15", on)).toBe(36);
    expect(computeAge("2000-08-28", on)).toBe(26);
    expect(computeAge("2000-08-29", on)).toBe(25);
  });
});
