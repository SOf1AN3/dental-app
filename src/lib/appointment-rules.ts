export const DEFAULT_APPOINTMENT_DURATION_MINUTES = 30;
export const SLOT_STEP_MINUTES = 15;
export const DEFAULT_MIN_GAP_MINUTES = 15;

export function parseTimeToMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time value: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return hours * 60 + minutes;
}

export function utcDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function offsetMinutesForTz(timeZone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

export function getClinicDateString(timeZone: string, date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function isSameClinicDate(
  startTime: Date,
  now: Date,
  timeZone: string,
): boolean {
  return (
    getClinicDateString(timeZone, startTime) === getClinicDateString(timeZone, now)
  );
}

export function isWithinClinicHours(
  start: Date,
  end: Date,
  openingTime: string,
  closingTime: string,
  utcOffsetMinutes = 0,
): boolean {
  if (end.getTime() <= start.getTime()) return false;
  const startMin = start.getUTCHours() * 60 + start.getUTCMinutes();
  const endMin = end.getUTCHours() * 60 + end.getUTCMinutes();
  const openingMin = parseTimeToMinutes(openingTime) - utcOffsetMinutes;
  const closingMin = parseTimeToMinutes(closingTime) - utcOffsetMinutes;
  return startMin >= openingMin && endMin <= closingMin;
}

export function hasMinGap(
  candidateStart: Date,
  candidateEnd: Date,
  existingStart: Date,
  existingEnd: Date,
  gapMinutes: number,
): boolean {
  const gapMs = gapMinutes * 60 * 1000;
  return (
    candidateStart.getTime() >= existingEnd.getTime() + gapMs ||
    candidateEnd.getTime() <= existingStart.getTime() - gapMs
  );
}

export function isSlotAvailable(
  candidateStart: Date,
  candidateEnd: Date,
  existingAppointments: { startTime: Date; endTime: Date }[],
  gapMinutes: number,
): boolean {
  return existingAppointments.every((appointment) =>
    hasMinGap(
      candidateStart,
      candidateEnd,
      appointment.startTime,
      appointment.endTime,
      gapMinutes,
    ),
  );
}

export function generateSlots(
  date: string,
  openingTime: string,
  closingTime: string,
  existingAppointments: { startTime: Date; endTime: Date }[],
  gapMinutes: number,
  now: Date,
  durationMinutes = DEFAULT_APPOINTMENT_DURATION_MINUTES,
  stepMinutes = SLOT_STEP_MINUTES,
  utcOffsetMinutes = 0,
): Date[] {
  const [year, month, day] = date.split("-").map(Number);
  const openingMin = parseTimeToMinutes(openingTime) - utcOffsetMinutes;
  const closingMin = parseTimeToMinutes(closingTime) - utcOffsetMinutes;
  const lastStartMin = closingMin - durationMinutes;
  const isToday = date === utcDateString(now);

  const slots: Date[] = [];
  for (let startMin = openingMin; startMin <= lastStartMin; startMin += stepMinutes) {
    const candidateStart = new Date(
      Date.UTC(year, month - 1, day, Math.floor(startMin / 60), startMin % 60),
    );
    const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60 * 1000);
    if (!isWithinClinicHours(candidateStart, candidateEnd, openingTime, closingTime, utcOffsetMinutes)) continue;
    if (!isSlotAvailable(candidateStart, candidateEnd, existingAppointments, gapMinutes)) continue;
    if (isToday && candidateStart.getTime() < now.getTime()) continue;
    slots.push(candidateStart);
  }
  return slots;
}

export interface ClinicScheduleEntry {
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
  isWeekend?: boolean;
}

export interface ClinicDayInfo {
  dayOfWeek: number
  openTime: string | null
  closeTime: string | null
  isClosed: boolean
  isWeekend: boolean
}

export interface ResolvedClinicHours {
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
}

export function dayOfWeekIndexForClinicDate(date: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(probe);
  const index: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return index[weekday] ?? 0;
}

export function resolveClinicHoursForDate(
  date: string,
  timeZone: string,
  schedule: Partial<Record<number, ClinicScheduleEntry>>,
  fallbackOpen: string,
  fallbackClose: string,
): ResolvedClinicHours {
  const entry = schedule[dayOfWeekIndexForClinicDate(date, timeZone)];
  if (!entry) {
    return { openTime: fallbackOpen, closeTime: fallbackClose, isClosed: false };
  }
  if (entry.isClosed) {
    return { openTime: null, closeTime: null, isClosed: true };
  }
  return {
    openTime: entry.openTime ?? fallbackOpen,
    closeTime: entry.closeTime ?? fallbackClose,
    isClosed: false,
  };
}
