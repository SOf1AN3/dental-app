"use server"

import { db } from "@/lib/db/db"
import { patients, appointments, payments, clinicalSessions, clinics, clinicSchedule } from "@/lib/db/schema"
import { getCurrentClinicId } from "@/lib/multi-tenant"
import { requireAuth, requireClinicAccessOrThrow, getCurrentUser, hasAbility } from "@/lib/auth-utils"
import { eq, and, gte, lt, desc, asc, count, sum, ne } from "drizzle-orm"
import {
  DEFAULT_APPOINTMENT_DURATION_MINUTES,
  DEFAULT_MIN_GAP_MINUTES,
  getClinicDateString,
  offsetMinutesForTz,
  parseTimeToMinutes,
  resolveClinicHoursForDate,
  type ClinicScheduleEntry,
} from "@/lib/appointment-rules"

/**
 * Report helpers accept an optional practitioner scope so role dashboards
 * (DB-2/DB-3/DB-4) reuse the same aggregations:
 * - dentistId on appointments → per-practitioner activity (DB-3);
 * - payments.createdBy is the honest per-dentist cash attribution available
 *   in the schema (invoices carry no practitioner column);
 * - global revenue stays gated by the `revenue:view_global` ability (RAP-1).
 *
 * Metric families (Z-65) — two distinct concepts, named explicitly:
 * - « Production » : value of performed work, sum of
 *   `clinical_session.total_amount`. Used by `totalRevenue` (all-time) and
 *   `monthlyRevenue` (last 6 months) so that Σ monthlyRevenue ≤ totalRevenue.
 * - « Encaissé » : money actually collected (table `payment`). Used by
 *   `byMethod` only, because the payment method lives exclusively on
 *   `payment`. Σ byMethod = total encaissé (cumul), which is a different
 *   family from `totalRevenue` → the UI must label it as cash, not production.
 *
 * Timezone (Z-66): every month/day boundary and every month key is computed in
 * the CLINIC timezone via `getClinicDateString`/`offsetMinutesForTz` (already
 * used by the agenda), never in the server timezone.
 */

type MonthlyTrendEntry = { month: string; patients: number; appointments: number; revenue: number }

const NOON_PROBE_MS = 12 * 60 * 60 * 1000
const DEFAULT_CLINIC_TIMEZONE = "Africa/Algiers"

async function getClinicTimezone(clinicId: string): Promise<string> {
  const rows = await db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, clinicId))
  return rows[0]?.timezone ?? DEFAULT_CLINIC_TIMEZONE
}

/**
 * First instant `[start, …)` of the clinic-local month `monthOffset` months
 * away from `now` (0 = current month). Offset is probed at local noon — same
 * convention as the agenda (`clinicDayBounds` in appointment.ts) — so a month
 * boundary crossed by a DST transition stays exact.
 */
function clinicMonthStart(timeZone: string, now: Date, monthOffset: number): Date {
  const [year, month] = getClinicDateString(timeZone, now).split("-").map(Number)
  const monthStartUtc = Date.UTC(year, month - 1 + monthOffset, 1)
  const offset = offsetMinutesForTz(timeZone, new Date(monthStartUtc + NOON_PROBE_MS))
  return new Date(monthStartUtc - offset * 60_000)
}

/** Z-66 — `[start, end)` bounds of a clinic-local day, in UTC instants. */
function clinicDayBounds(timeZone: string, clinicDate: string): { start: Date; end: Date } {
  const [year, month, day] = clinicDate.split("-").map(Number)
  const dayStartUtc = Date.UTC(year, month - 1, day)
  const nextDayStartUtc = Date.UTC(year, month - 1, day + 1)
  const startOffset = offsetMinutesForTz(timeZone, new Date(dayStartUtc + NOON_PROBE_MS))
  const endOffset = offsetMinutesForTz(timeZone, new Date(nextDayStartUtc + NOON_PROBE_MS))
  return {
    start: new Date(dayStartUtc - startOffset * 60_000),
    end: new Date(nextDayStartUtc - endOffset * 60_000),
  }
}

/** `YYYY-MM` key of an instant, in the clinic timezone. */
function clinicMonthKey(timeZone: string, date: Date): string {
  return getClinicDateString(timeZone, date).slice(0, 7)
}

function lastSixMonthKeys(timeZone: string, now: Date): string[] {
  const [year, month] = getClinicDateString(timeZone, now).split("-").map(Number)
  const current = year * 12 + (month - 1)
  const keys: string[] = []
  for (let i = 5; i >= 0; i--) {
    const index = current - i
    keys.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`)
  }
  return keys
}

function emptyMonthlyTrends(timeZone: string, now: Date): MonthlyTrendEntry[] {
  return lastSixMonthKeys(timeZone, now).map((month) => ({ month, patients: 0, appointments: 0, revenue: 0 }))
}

export async function getPatientStats() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    // Z-66 — « this month » bounded in the clinic timezone, not the server one.
    // `getClinicTimezone` runs INSIDE the try: a DB error degrades to the
    // zeroed payload below instead of throwing to the caller.
    const timezone = await getClinicTimezone(clinicId)
    const startOfMonth = clinicMonthStart(timezone, new Date(), 0)

    const [totalRow, newRow, genderRows, wilayaRows] = await Promise.all([
      db.select({ value: count() }).from(patients).where(eq(patients.clinicId, clinicId)),
      db.select({ value: count() }).from(patients).where(and(eq(patients.clinicId, clinicId), gte(patients.createdAt, startOfMonth))),
      db.select({ gender: patients.gender, value: count() }).from(patients).where(eq(patients.clinicId, clinicId)).groupBy(patients.gender),
      db.select({ wilayaCode: patients.wilayaCode, value: count() }).from(patients).where(eq(patients.clinicId, clinicId)).groupBy(patients.wilayaCode).orderBy(desc(count())),
    ])

    return {
      total: Number(totalRow[0]?.value ?? 0),
      newThisMonth: Number(newRow[0]?.value ?? 0),
      genderDistribution: genderRows.map((r) => ({ gender: r.gender, count: Number(r.value) })),
      wilayaDistribution: wilayaRows.map((r) => ({ wilayaCode: r.wilayaCode, count: Number(r.value) })),
    }
  } catch {
    return {
      total: 0,
      newThisMonth: 0,
      genderDistribution: [],
      wilayaDistribution: [],
    }
  }
}

export async function getAppointmentStats(opts?: { dentistId?: string }) {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    const scope = opts?.dentistId
      ? and(eq(appointments.clinicId, clinicId), eq(appointments.dentistId, opts.dentistId))
      : eq(appointments.clinicId, clinicId)

    const [totalRow, completedRow, cancelledRow, noShowRow, typeRows] = await Promise.all([
      db.select({ value: count() }).from(appointments).where(scope),
      db.select({ value: count() }).from(appointments).where(and(scope, eq(appointments.status, "completed"))),
      db.select({ value: count() }).from(appointments).where(and(scope, eq(appointments.status, "cancelled"))),
      db.select({ value: count() }).from(appointments).where(and(scope, eq(appointments.status, "no_show"))),
      db.select({ type: appointments.type, value: count() }).from(appointments).where(scope).groupBy(appointments.type),
    ])

    return {
      total: Number(totalRow[0]?.value ?? 0),
      completed: Number(completedRow[0]?.value ?? 0),
      cancelled: Number(cancelledRow[0]?.value ?? 0),
      noShow: Number(noShowRow[0]?.value ?? 0),
      byType: typeRows.map((r) => ({ type: r.type, count: Number(r.value) })),
    }
  } catch {
    return {
      total: 0,
      completed: 0,
      cancelled: 0,
      noShow: 0,
      byType: [],
    }
  }
}

/**
 * Clinic revenue report — see the metric-family block at the top of this file
 * (Z-65): `totalRevenue` + `monthlyRevenue` are « Production », `byMethod` is
 * « Encaissé ». Owner-only figures: callers without the
 * `revenue:view_global` ability get zeros (page-level gating is the primary
 * guard; this is defense in depth).
 */
export async function getRevenueData(opts?: { dentistId?: string }) {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  // A dentist scoped to themselves may read their own numbers; anything
  // global requires revenue:view_global.
  if (opts?.dentistId) {
    const user = await getCurrentUser()
    if (user?.id !== opts.dentistId && !(await hasAbility(clinicId, "revenue:view_global"))) {
      return { totalRevenue: 0, monthlyRevenue: [], byMethod: [] }
    }
  } else if (!(await hasAbility(clinicId, "revenue:view_global"))) {
    return { totalRevenue: 0, monthlyRevenue: [], byMethod: [] }
  }

  try {
    const timezone = await getClinicTimezone(clinicId)

    // Z-66 — window bounded at the clinic-local month start. Offset `-5`
    // (not `-6`) matches `lastSixMonthKeys`: exactly 6 buckets, so
    // `monthlyRevenue` keys line up with `getMonthlyTrends`.
    const sixMonthsAgo = clinicMonthStart(timezone, new Date(), -5)

    // Z-65 — both scopes share the same two families:
    // - Production: clinical sessions totalAmount (global = whole clinic,
    //   practitioner = sessions they performed);
    // - Encaissé: payments (global = clinic, practitioner = cash recorded by
    //   them via payments.createdBy — the honest per-dentist attribution).
    const sessionScope = opts?.dentistId
      ? and(eq(clinicalSessions.clinicId, clinicId), eq(clinicalSessions.dentistId, opts.dentistId))
      : eq(clinicalSessions.clinicId, clinicId)

    const paymentScope = opts?.dentistId
      ? and(eq(payments.clinicId, clinicId), eq(payments.createdBy, opts.dentistId))
      : eq(payments.clinicId, clinicId)

    const [productionTotalRow, recentSessions, methodRows] = await Promise.all([
      db.select({ value: sum(clinicalSessions.totalAmount) }).from(clinicalSessions).where(sessionScope),
      db
        .select({ createdAt: clinicalSessions.createdAt, totalAmount: clinicalSessions.totalAmount })
        .from(clinicalSessions)
        .where(and(sessionScope, gte(clinicalSessions.createdAt, sixMonthsAgo))),
      db.select({ method: payments.method, value: sum(payments.amount) }).from(payments).where(paymentScope).groupBy(payments.method),
    ])

    const monthlyMap = new Map<string, number>()
    for (const session of recentSessions) {
      const key = clinicMonthKey(timezone, session.createdAt)
      monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + session.totalAmount)
    }
    const monthlyRevenue = Array.from(monthlyMap.entries())
      .map(([month, amount]) => ({ month, amount: Number(amount) }))
      .sort((a, b) => a.month.localeCompare(b.month))

    return {
      totalRevenue: Number(productionTotalRow[0]?.value ?? 0),
      monthlyRevenue,
      byMethod: methodRows.map((r) => ({ method: r.method, amount: Number(r.value) })),
    }
  } catch {
    return {
      totalRevenue: 0,
      monthlyRevenue: [],
      byMethod: [],
    }
  }
}

export async function getMonthlyTrends(opts?: { dentistId?: string }) {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  const now = new Date()

  try {
    const timezone = await getClinicTimezone(clinicId)

    // Z-64 — this report aggregates the same payments as `getRevenueData`, so it
    // carries the same `revenue:view_global` gate, including the “zeros, no
    // refusal” behaviour (defense in depth). A dentist scoped to themselves may
    // still read their own trends.
    if (opts?.dentistId) {
      const user = await getCurrentUser()
      if (user?.id !== opts.dentistId && !(await hasAbility(clinicId, "revenue:view_global"))) {
        return emptyMonthlyTrends(timezone, now)
      }
    } else if (!(await hasAbility(clinicId, "revenue:view_global"))) {
      return emptyMonthlyTrends(timezone, now)
    }

    // Z-66 — window bounded at the clinic-local month start; month keys below
    // are derived from the clinic-local date of each row.
    const sixMonthsAgo = clinicMonthStart(timezone, now, -5)

    const apptScope = opts?.dentistId
      ? and(eq(appointments.clinicId, clinicId), eq(appointments.dentistId, opts.dentistId), gte(appointments.startTime, sixMonthsAgo))
      : and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, sixMonthsAgo))

    const paymentScope = opts?.dentistId
      ? and(eq(payments.clinicId, clinicId), eq(payments.createdBy, opts.dentistId), gte(payments.date, sixMonthsAgo))
      : and(eq(payments.clinicId, clinicId), gte(payments.date, sixMonthsAgo))

    const [appointmentsData, paymentsData] = await Promise.all([
      db.select({ startTime: appointments.startTime, patientId: appointments.patientId }).from(appointments).where(apptScope),
      db.select({ date: payments.date, amount: payments.amount }).from(payments).where(paymentScope),
    ])

    const monthEntries = emptyMonthlyTrends(timezone, now)
    const byMonth = new Map(monthEntries.map((entry) => [entry.month, entry]))
    const patientPerMonth = new Map<string, Set<string>>()

    for (const apt of appointmentsData) {
      const key = clinicMonthKey(timezone, apt.startTime)
      const month = byMonth.get(key)
      if (month) {
        month.appointments++
        let patientsSeen = patientPerMonth.get(key)
        if (!patientsSeen) {
          patientsSeen = new Set()
          patientPerMonth.set(key, patientsSeen)
        }
        patientsSeen.add(apt.patientId)
      }
    }

    for (const [key, patientsSeen] of patientPerMonth) {
      const month = byMonth.get(key)
      if (month) month.patients = patientsSeen.size
    }

    for (const pmt of paymentsData) {
      const key = clinicMonthKey(timezone, pmt.date)
      const month = byMonth.get(key)
      if (month) month.revenue += pmt.amount
    }

    return monthEntries
  } catch {
    // A DB failure (including the timezone lookup) degrades to the same
    // zeroed payload, keyed in the default clinic timezone.
    return emptyMonthlyTrends(DEFAULT_CLINIC_TIMEZONE, now)
  }
}

/**
 * Occupancy report. Z-67: `estimatedMonthlySlots` is now computed from the
 * real `clinic_schedule` (falling back to clinic opening/closing times, same
 * resolution as the agenda) instead of “jours ouvrés × 8”. Cancelled/no_show
 * appointments are excluded from every counter so the rate reflects actual
 * booked time. `rate` remains “booked this month ÷ clinic capacity” — a
 * dentist-scoped call keeps the clinic-wide denominator (per-dentist working
 * days are not stored anywhere; documented limitation, pre-existing).
 */
export async function getOccupancyRate(opts?: { dentistId?: string }) {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  const now = new Date()

  try {
    // `getClinicTimezone` runs INSIDE the try: a DB error degrades to the
    // zeroed payload below instead of throwing to the caller.
    const timezone = await getClinicTimezone(clinicId)

    const clinicRows = await db
      .select({ openingTime: clinics.openingTime, closingTime: clinics.closingTime })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
    const fallbackOpen = clinicRows[0]?.openingTime ?? "08:00"
    const fallbackClose = clinicRows[0]?.closingTime ?? "19:00"

    // Z-66 — today / this month / last month bounded in the clinic timezone.
    const todayBounds = clinicDayBounds(timezone, getClinicDateString(timezone, now))
    const monthStart = clinicMonthStart(timezone, now, 0)
    const lastMonthStart = clinicMonthStart(timezone, now, -1)

    const base = opts?.dentistId
      ? and(eq(appointments.clinicId, clinicId), eq(appointments.dentistId, opts.dentistId))
      : eq(appointments.clinicId, clinicId)

    // Z-67 — cancelled / no_show appointments do not consume a slot.
    const booked = and(ne(appointments.status, "cancelled"), ne(appointments.status, "no_show"))

    const [scheduleRows, todayAppts, thisMonth, lastMonth] = await Promise.all([
      db
        .select({
          dayOfWeek: clinicSchedule.dayOfWeek,
          openTime: clinicSchedule.openTime,
          closeTime: clinicSchedule.closeTime,
          isClosed: clinicSchedule.isClosed,
        })
        .from(clinicSchedule)
        .where(eq(clinicSchedule.clinicId, clinicId)),
      db.select({ value: count() }).from(appointments).where(and(base, booked, gte(appointments.startTime, todayBounds.start), lt(appointments.startTime, todayBounds.end))),
      db.select({ value: count() }).from(appointments).where(and(base, booked, gte(appointments.startTime, monthStart))),
      db.select({ value: count() }).from(appointments).where(and(base, booked, gte(appointments.startTime, lastMonthStart), lt(appointments.startTime, monthStart))),
    ])

    const scheduleMap: Partial<Record<number, ClinicScheduleEntry>> = {}
    for (const row of scheduleRows) {
      scheduleMap[row.dayOfWeek] = { openTime: row.openTime, closeTime: row.closeTime, isClosed: row.isClosed }
    }

    const estimatedMonthlySlots = monthlyClinicCapacity(timezone, now, fallbackOpen, fallbackClose, scheduleMap)

    return {
      today: Number(todayAppts[0]?.value ?? 0),
      thisMonth: Number(thisMonth[0]?.value ?? 0),
      lastMonth: Number(lastMonth[0]?.value ?? 0),
      estimatedMonthlySlots,
      rate: estimatedMonthlySlots > 0 ? Math.round((Number(thisMonth[0]?.value ?? 0) / estimatedMonthlySlots) * 100) : 0,
    }
  } catch {
    return { today: 0, thisMonth: 0, lastMonth: 0, estimatedMonthlySlots: 0, rate: 0 }
  }
}

/**
 * Theoretical capacity of the current clinic-local month: per open day, the
 * number of appointments packed back-to-back using the same constants the
 * agenda enforces (`DEFAULT_APPOINTMENT_DURATION_MINUTES` followed by
 * `DEFAULT_MIN_GAP_MINUTES`): n appointments span n*dur + (n-1)*gap minutes.
 * Days without a `clinic_schedule` row fall back to the clinic opening/closing
 * times — exactly what the availability grid generates.
 */
function monthlyClinicCapacity(
  timeZone: string,
  now: Date,
  fallbackOpen: string,
  fallbackClose: string,
  scheduleMap: Partial<Record<number, ClinicScheduleEntry>>,
): number {
  const [year, month] = getClinicDateString(timeZone, now).split("-").map(Number)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  let capacity = 0
  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
    const hours = resolveClinicHoursForDate(date, timeZone, scheduleMap, fallbackOpen, fallbackClose)
    if (hours.isClosed || !hours.openTime || !hours.closeTime) continue
    capacity += slotsPerDay(hours.openTime, hours.closeTime)
  }
  return capacity
}

function slotsPerDay(openTime: string, closeTime: string): number {
  const span = parseTimeToMinutes(closeTime) - parseTimeToMinutes(openTime)
  if (span <= 0) return 0
  const perAppointment = DEFAULT_APPOINTMENT_DURATION_MINUTES + DEFAULT_MIN_GAP_MINUTES
  return Math.floor((span + DEFAULT_MIN_GAP_MINUTES) / perAppointment)
}
