import { describe, expect, it } from "vitest";
import {
  ClinicScheduleEntry,
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
  DEFAULT_MIN_GAP_MINUTES,
  SLOT_STEP_MINUTES,
  parseTimeToMinutes,
  offsetMinutesForTz,
  isWithinClinicHours,
  hasMinGap,
  isSlotAvailable,
  generateSlots,
  dayOfWeekIndexForClinicDate,
  resolveClinicHoursForDate,
} from "./appointment-rules";

describe("constants", () => {
  it("exposes the expected defaults", () => {
    expect(DEFAULT_APPOINTMENT_DURATION_MINUTES).toBe(30);
    expect(SLOT_STEP_MINUTES).toBe(15);
    expect(DEFAULT_MIN_GAP_MINUTES).toBe(15);
  });
});

describe("parseTimeToMinutes", () => {
  it("parses HH:MM and HH:MM:SS time strings", () => {
    expect(parseTimeToMinutes("08:00")).toBe(480);
    expect(parseTimeToMinutes("08:00:00")).toBe(480);
    expect(parseTimeToMinutes("19:30:00")).toBe(1170);
  });

  it("rejects invalid time values", () => {
    expect(() => parseTimeToMinutes("abc")).toThrow();
    expect(() => parseTimeToMinutes("25:00")).toThrow();
    expect(() => parseTimeToMinutes("08:75")).toThrow();
  });
});

describe("offsetMinutesForTz", () => {
  it("returns the UTC offset in minutes for a given timezone", () => {
    expect(offsetMinutesForTz("UTC", new Date(Date.UTC(2026, 5, 15, 12)))).toBe(0);
    expect(offsetMinutesForTz("Africa/Algiers", new Date(Date.UTC(2026, 5, 15, 12)))).toBe(60);
  });
});

describe("isWithinClinicHours", () => {
  const opening = "08:00";
  const closing = "19:00";

  it("returns true when the interval is inside clinic hours", () => {
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        new Date(Date.UTC(2026, 5, 15, 10, 30)),
        opening,
        closing,
      ),
    ).toBe(true);
  });

  it("returns false when the interval starts before opening or ends after closing", () => {
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 7, 30)),
        new Date(Date.UTC(2026, 5, 15, 8, 0)),
        opening,
        closing,
      ),
    ).toBe(false);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 18, 30)),
        new Date(Date.UTC(2026, 5, 15, 19, 30)),
        opening,
        closing,
      ),
    ).toBe(false);
  });

  it("treats opening and closing boundaries as inclusive and rejects end <= start", () => {
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 8, 0)),
        new Date(Date.UTC(2026, 5, 15, 8, 30)),
        opening,
        closing,
      ),
    ).toBe(true);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 18, 30)),
        new Date(Date.UTC(2026, 5, 15, 19, 0)),
        opening,
        closing,
      ),
    ).toBe(true);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        opening,
        closing,
      ),
    ).toBe(false);
  });

  it("shifts the boundaries by the clinic UTC offset", () => {
    const offset = 60;
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 7, 0)),
        new Date(Date.UTC(2026, 5, 15, 7, 30)),
        opening,
        closing,
        offset,
      ),
    ).toBe(true);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 6, 30)),
        new Date(Date.UTC(2026, 5, 15, 7, 0)),
        opening,
        closing,
        offset,
      ),
    ).toBe(false);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 17, 30)),
        new Date(Date.UTC(2026, 5, 15, 18, 0)),
        opening,
        closing,
        offset,
      ),
    ).toBe(true);
    expect(
      isWithinClinicHours(
        new Date(Date.UTC(2026, 5, 15, 18, 30)),
        new Date(Date.UTC(2026, 5, 15, 19, 0)),
        opening,
        closing,
        offset,
      ),
    ).toBe(false);
  });
});

describe("hasMinGap", () => {
  it("returns true when the candidate sits before or after the existing appointment with enough gap", () => {
    const existingStart = new Date(Date.UTC(2026, 5, 15, 9, 0));
    const existingEnd = new Date(Date.UTC(2026, 5, 15, 9, 30));
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 8, 0)),
        new Date(Date.UTC(2026, 5, 15, 8, 30)),
        existingStart,
        existingEnd,
        15,
      ),
    ).toBe(true);
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        new Date(Date.UTC(2026, 5, 15, 10, 30)),
        existingStart,
        existingEnd,
        15,
      ),
    ).toBe(true);
  });

  it("returns true when the gap equals the exact boundary", () => {
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 8, 45)),
        new Date(Date.UTC(2026, 5, 15, 9, 15)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        15,
      ),
    ).toBe(true);
  });

  it("returns false when the gap is one minute short or the intervals overlap", () => {
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 8, 46)),
        new Date(Date.UTC(2026, 5, 15, 9, 16)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        15,
      ),
    ).toBe(false);
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 9, 0)),
        new Date(Date.UTC(2026, 5, 15, 10, 0)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        new Date(Date.UTC(2026, 5, 15, 10, 30)),
        15,
      ),
    ).toBe(false);
  });

  it("allows back-to-back appointments when the gap is zero", () => {
    expect(
      hasMinGap(
        new Date(Date.UTC(2026, 5, 15, 8, 30)),
        new Date(Date.UTC(2026, 5, 15, 9, 0)),
        new Date(Date.UTC(2026, 5, 15, 9, 0)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        0,
      ),
    ).toBe(true);
  });
});

describe("isSlotAvailable", () => {
  it("returns true with no existing appointments", () => {
    expect(
      isSlotAvailable(
        new Date(Date.UTC(2026, 5, 15, 9, 0)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        [],
        15,
      ),
    ).toBe(true);
  });

  it("respects the gap against every existing appointment", () => {
    const existing = [
      { startTime: new Date(Date.UTC(2026, 5, 15, 8, 0)), endTime: new Date(Date.UTC(2026, 5, 15, 8, 30)) },
      { startTime: new Date(Date.UTC(2026, 5, 15, 12, 0)), endTime: new Date(Date.UTC(2026, 5, 15, 12, 30)) },
    ];
    expect(
      isSlotAvailable(
        new Date(Date.UTC(2026, 5, 15, 9, 0)),
        new Date(Date.UTC(2026, 5, 15, 9, 30)),
        existing,
        15,
      ),
    ).toBe(true);
  });

  it("returns false when overlapping any appointment", () => {
    const existing = [
      { startTime: new Date(Date.UTC(2026, 5, 15, 9, 0)), endTime: new Date(Date.UTC(2026, 5, 15, 9, 30)) },
    ];
    expect(
      isSlotAvailable(
        new Date(Date.UTC(2026, 5, 15, 9, 15)),
        new Date(Date.UTC(2026, 5, 15, 9, 45)),
        existing,
        15,
      ),
    ).toBe(false);
  });
});

describe("generateSlots", () => {
  it("generates 15-minute slots from opening to the last fitting start", () => {
    const now = new Date(Date.UTC(2026, 5, 14, 0, 0));
    const slots = generateSlots("2026-06-15", "08:00", "19:00", [], 15, now);
    expect(slots.length).toBe(43);
    expect(slots[0].toISOString()).toBe("2026-06-15T08:00:00.000Z");
    expect(slots[slots.length - 1].toISOString()).toBe("2026-06-15T18:30:00.000Z");
    expect(slots.some((s) => s.getUTCHours() === 18 && s.getUTCMinutes() === 45)).toBe(false);
  });

  it("skips past slots when the date is today relative to now", () => {
    const now = new Date(Date.UTC(2026, 5, 15, 8, 30));
    const slots = generateSlots("2026-06-15", "08:00", "19:00", [], 15, now);
    expect(slots[0].toISOString()).toBe("2026-06-15T08:30:00.000Z");
    expect(slots.some((s) => s.getUTCHours() === 8 && s.getUTCMinutes() === 15)).toBe(false);
  });

  it("excludes slots that violate the minimum gap around an existing appointment", () => {
    const existing = [
      { startTime: new Date(Date.UTC(2026, 5, 15, 10, 0)), endTime: new Date(Date.UTC(2026, 5, 15, 10, 30)) },
    ];
    const now = new Date(Date.UTC(2026, 5, 14, 0, 0));
    const slots = generateSlots("2026-06-15", "08:00", "19:00", existing, 15, now);
    expect(slots.some((s) => s.getUTCHours() === 10 && s.getUTCMinutes() === 45)).toBe(true);
    expect(slots.some((s) => s.getUTCHours() === 10 && s.getUTCMinutes() === 30)).toBe(false);
    expect(slots.some((s) => s.getUTCHours() === 9 && s.getUTCMinutes() === 45)).toBe(false);
    expect(slots.some((s) => s.getUTCHours() === 9 && s.getUTCMinutes() === 15)).toBe(true);
  });

  it("builds UTC slots from clinic-local hours using the UTC offset", () => {
    const now = new Date(Date.UTC(2026, 5, 14, 0, 0));
    const slots = generateSlots("2026-06-15", "08:00", "19:00", [], 15, now, undefined, undefined, 60);
    expect(slots[0].toISOString()).toBe("2026-06-15T07:00:00.000Z");
    expect(slots[slots.length - 1].toISOString()).toBe("2026-06-15T17:30:00.000Z");
    expect(slots.some((s) => s.getUTCHours() === 19)).toBe(false);
  });
});

describe("dayOfWeekIndexForClinicDate", () => {
  it("maps August 2026 dates to weekday indices in Africa/Algiers", () => {
    expect(dayOfWeekIndexForClinicDate("2026-08-03", "Africa/Algiers")).toBe(0);
    expect(dayOfWeekIndexForClinicDate("2026-08-04", "Africa/Algiers")).toBe(1);
    expect(dayOfWeekIndexForClinicDate("2026-08-07", "Africa/Algiers")).toBe(4);
    expect(dayOfWeekIndexForClinicDate("2026-08-08", "Africa/Algiers")).toBe(5);
    expect(dayOfWeekIndexForClinicDate("2026-08-09", "Africa/Algiers")).toBe(6);
  });

  it("resolves the weekday in the clinic timezone rather than UTC", () => {
    expect(dayOfWeekIndexForClinicDate("2026-08-03", "UTC")).toBe(0);
    expect(dayOfWeekIndexForClinicDate("2026-08-03", "Pacific/Kiritimati")).toBe(1);
  });
});

describe("resolveClinicHoursForDate", () => {
  it("returns the scheduled open and close when the day is present and open", () => {
    const schedule: Partial<Record<number, ClinicScheduleEntry>> = {
      0: { openTime: "08:30", closeTime: "17:00", isClosed: false },
    };
    expect(
      resolveClinicHoursForDate("2026-08-03", "Africa/Algiers", schedule, "09:00", "18:00"),
    ).toEqual({ openTime: "08:30", closeTime: "17:00", isClosed: false });
  });

  it("returns closed hours when the day is marked closed, ignoring any set times", () => {
    const schedule: Partial<Record<number, ClinicScheduleEntry>> = {
      0: { openTime: "08:00", closeTime: "19:00", isClosed: true },
    };
    expect(
      resolveClinicHoursForDate("2026-08-03", "Africa/Algiers", schedule, "09:00", "18:00"),
    ).toEqual({ openTime: null, closeTime: null, isClosed: true });
  });

  it("falls back to the given hours when the day is missing from the schedule", () => {
    const schedule: Partial<Record<number, ClinicScheduleEntry>> = {
      1: { openTime: "08:00", closeTime: "19:00", isClosed: false },
    };
    expect(
      resolveClinicHoursForDate("2026-08-09", "Africa/Algiers", schedule, "09:00", "18:00"),
    ).toEqual({ openTime: "09:00", closeTime: "18:00", isClosed: false });
  });

  it("falls back to the given hours when the day is open but times are null", () => {
    const schedule: Partial<Record<number, ClinicScheduleEntry>> = {
      0: { openTime: null, closeTime: null, isClosed: false },
    };
    expect(
      resolveClinicHoursForDate("2026-08-03", "Africa/Algiers", schedule, "09:00", "18:00"),
    ).toEqual({ openTime: "09:00", closeTime: "18:00", isClosed: false });
  });
});
