import { describe, expect, it } from "vitest";
import { selectSubscriptionsDueForReminder } from "./subscription-reminders";

const NOW = new Date("2026-08-04T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const subs = [
  { id: "active-10d", clinicId: "c1", endDate: new Date(NOW.getTime() + 10 * DAY), status: "active" },
  { id: "active-today", clinicId: "c2", endDate: new Date(NOW.getTime()), status: "active" },
  { id: "active-30d", clinicId: "c3", endDate: new Date(NOW.getTime() + 30 * DAY), status: "active" },
  { id: "active-31d", clinicId: "c4", endDate: new Date(NOW.getTime() + 31 * DAY), status: "active" },
  { id: "cancelled-10d", clinicId: "c5", endDate: new Date(NOW.getTime() + 10 * DAY), status: "cancelled" },
  { id: "no-enddate", clinicId: "c6", endDate: null, status: "active" },
];

describe("selectSubscriptionsDueForReminder", () => {
  it("includes only active subscriptions ending within the reminder window", () => {
    const result = selectSubscriptionsDueForReminder(subs, NOW, 30);
    expect(result.map((sub) => sub.id)).toEqual(["active-10d", "active-30d"]);
  });

  it("excludes subscriptions ending exactly at now (strict >)", () => {
    const result = selectSubscriptionsDueForReminder(subs, NOW, 30);
    expect(result.map((sub) => sub.id)).not.toContain("active-today");
  });

  it("excludes subscriptions ending more than daysBefore away", () => {
    const result = selectSubscriptionsDueForReminder(subs, NOW, 30);
    expect(result.map((sub) => sub.id)).not.toContain("active-31d");
  });

  it("excludes cancelled subscriptions and subscriptions without an end date", () => {
    const result = selectSubscriptionsDueForReminder(subs, NOW, 30);
    expect(result.map((sub) => sub.id)).not.toContain("cancelled-10d");
    expect(result.map((sub) => sub.id)).not.toContain("no-enddate");
  });

  it("returns exactly the two subscriptions due (10d and 30d)", () => {
    const result = selectSubscriptionsDueForReminder(subs, NOW, 30);
    expect(result).toHaveLength(2);
  });
});
