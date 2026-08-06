import { describe, expect, it } from "vitest";
import { isStoredKey, resolveStoredUrl } from "./storage";

describe("isStoredKey", () => {
  it("returns true for a stored key", () => {
    expect(isStoredKey("clinic/radiograph-x.jpg")).toBe(true);
  });

  it("returns false for an /uploads/ path", () => {
    expect(isStoredKey("/uploads/x.jpg")).toBe(false);
  });

  it("returns false for http(s) URLs", () => {
    expect(isStoredKey("http://a/b")).toBe(false);
    expect(isStoredKey("https://a/b")).toBe(false);
  });
});

describe("resolveStoredUrl", () => {
  it("returns null for null or empty input", async () => {
    await expect(resolveStoredUrl(null)).resolves.toBeNull();
    await expect(resolveStoredUrl("")).resolves.toBeNull();
  });

  it("passes through non-stored keys", async () => {
    const url = "https://bucket.s3.amazonaws.com/key";
    await expect(resolveStoredUrl(url)).resolves.toBe(url);
  });

  it("returns null when the stored file cannot be resolved", async () => {
    await expect(resolveStoredUrl("clinic/nonexistent-key")).resolves.toBeNull();
  });
});
