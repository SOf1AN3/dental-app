import { describe, expect, it } from "vitest";
import { ABILITIES, NAV_ABILITY, ROLES, ROLE_ABILITIES, can, isRole } from "./permissions";

describe("permissions matrix", () => {
  it("every role has a non-empty ability list", () => {
    for (const role of ROLES) {
      expect(ROLE_ABILITIES[role].length, role).toBeGreaterThan(0);
    }
  });

  it("all declared abilities are valid and unique", () => {
    expect(new Set(ABILITIES).size).toBe(ABILITIES.length);
    for (const role of ROLES) {
      for (const ability of ROLE_ABILITIES[role]) {
        expect(ABILITIES, `${role}:${ability}`).toContain(ability);
      }
    }
  });

  it("owner can do everything", () => {
    for (const ability of ABILITIES) {
      expect(can("owner", ability), ability).toBe(true);
    }
  });

  it("viewer is strictly view-only (except owner-only global views)", () => {
    for (const ability of ABILITIES) {
      if (ability.endsWith(":view") && ability !== "reports:view") {
        expect(can("viewer", ability), ability).toBe(true);
      } else {
        expect(can("viewer", ability), ability).toBe(false);
      }
    }
  });

  it("global reports and revenue are owner-only (RAP-1)", () => {
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(can(role, "reports:view"), role).toBe(false);
      expect(can(role, "revenue:view_global"), role).toBe(false);
    }
  });

  it("member management beyond invite is owner-only; invite allows dentist", () => {
    expect(can("dentist", "members:invite")).toBe(true);
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(can(role, "members:manage"), role).toBe(false);
      if (role !== "dentist") {
        expect(can(role, "members:invite"), role).toBe(false);
      }
    }
  });

  it("clinic-wide settings are owner-only (PAR-3 surface)", () => {
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(can(role, "settings:clinic_manage"), role).toBe(false);
      expect(can(role, "settings:view"), role).toBe(true);
    }
  });

  it("manual billing management is receptionist + owner only", () => {
    expect(can("receptionist", "billing:manage")).toBe(true);
    expect(can("dentist", "billing:manage")).toBe(false);
    expect(can("assistant", "billing:manage")).toBe(false);
    expect(can("dentist", "billing:session_close")).toBe(true);
    expect(can("receptionist", "billing:session_close")).toBe(true);
    expect(can("assistant", "billing:session_close")).toBe(false);
  });

  it("prescription writing is clinical (owner + dentist) only", () => {
    expect(can("dentist", "prescriptions:manage")).toBe(true);
    expect(can("assistant", "prescriptions:manage")).toBe(false);
    expect(can("receptionist", "prescriptions:manage")).toBe(false);
  });

  it("stock mutations are assistant (+ owner) only", () => {
    expect(can("assistant", "stock:manage")).toBe(true);
    expect(can("receptionist", "stock:manage")).toBe(false);
    expect(can("dentist", "stock:manage")).toBe(false);
  });

  it("every nav route has a known ability mapping", () => {
    const abilities = new Set<string>(ABILITIES);
    for (const ability of Object.values(NAV_ABILITY)) {
      expect(abilities.has(ability)).toBe(true);
    }
  });

  it("isRole narrows correctly", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole("")).toBe(false);
  });
});
