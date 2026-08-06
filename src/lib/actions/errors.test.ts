import { describe, expect, it } from "vitest";
import { isRedirectOrReject } from "./errors";

let redirect: typeof import("next/navigation").redirect | null = null;

try {
  const nav = await import("next/navigation");
  redirect = nav.redirect;
} catch {
  redirect = null;
}

function captureRedirectError(): unknown {
  try {
    redirect!("/dashboard");
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("isRedirectOrReject", () => {
  it("returns false for a plain Error", () => {
    expect(isRedirectOrReject(new Error("boom"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isRedirectOrReject(null)).toBe(false);
  });

  it("returns false for a non-object value", () => {
    expect(isRedirectOrReject("nope")).toBe(false);
  });

  describe.skipIf(!redirect)("with a genuine redirect error", () => {
    it("returns true", () => {
      expect(isRedirectOrReject(captureRedirectError())).toBe(true);
    });
  });
});
