"use server"

import { db } from "@/lib/db/db"
import { patients, appointments, invoices, payments } from "@/lib/db/schema"
import { getCurrentClinicId } from "@/lib/multi-tenant"
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils"
import { eq, and, gte, lt, desc, asc, count, sum } from "drizzle-orm"

export async function getPatientStats() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  const now = new Date()
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

  try {
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

export async function getAppointmentStats() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    const [totalRow, completedRow, cancelledRow, noShowRow, typeRows] = await Promise.all([
      db.select({ value: count() }).from(appointments).where(eq(appointments.clinicId, clinicId)),
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, "completed"))),
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, "cancelled"))),
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), eq(appointments.status, "no_show"))),
      db.select({ type: appointments.type, value: count() }).from(appointments).where(eq(appointments.clinicId, clinicId)).groupBy(appointments.type),
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

export async function getRevenueData() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    sixMonthsAgo.setDate(1)
    sixMonthsAgo.setHours(0, 0, 0, 0)

    const [totalRow, monthlyInvoices, methodRows] = await Promise.all([
      db.select({ value: sum(invoices.total) }).from(invoices).where(and(eq(invoices.clinicId, clinicId), eq(invoices.status, "paid"))),
      db.select({ date: invoices.date, total: invoices.total }).from(invoices).where(and(eq(invoices.clinicId, clinicId), eq(invoices.status, "paid"), gte(invoices.date, sixMonthsAgo))).orderBy(asc(invoices.date)),
      db.select({ method: payments.method, value: sum(payments.amount) }).from(payments).where(eq(payments.clinicId, clinicId)).groupBy(payments.method),
    ])

    const monthlyMap = new Map<string, number>()
    for (const inv of monthlyInvoices) {
      if (inv.date) {
        const key = `${inv.date.getFullYear()}-${String(inv.date.getMonth() + 1).padStart(2, "0")}`
        monthlyMap.set(key, (monthlyMap.get(key) ?? 0) + inv.total)
      }
    }
    const monthlyRevenue = Array.from(monthlyMap.entries())
      .map(([month, amount]) => ({ month, amount: Number(amount) }))
      .sort((a, b) => a.month.localeCompare(b.month))

    return {
      totalRevenue: Number(totalRow[0]?.value ?? 0),
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

export async function getMonthlyTrends() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    const now = new Date()
    const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1)

    const [appointmentsData, paymentsData] = await Promise.all([
      db.select({ startTime: appointments.startTime, patientId: appointments.patientId }).from(appointments).where(and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, sixMonthsAgo))),
      db.select({ date: payments.date, amount: payments.amount }).from(payments).where(and(eq(payments.clinicId, clinicId), gte(payments.date, sixMonthsAgo))),
    ])

    const monthEntries: { month: string; patients: number; appointments: number; revenue: number }[] = []
    const patientPerMonth = new Map<string, Set<string>>()

    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      monthEntries.push({ month: key, patients: 0, appointments: 0, revenue: 0 })
      patientPerMonth.set(key, new Set())
    }

    for (const apt of appointmentsData) {
      const key = `${apt.startTime.getFullYear()}-${String(apt.startTime.getMonth() + 1).padStart(2, "0")}`
      const month = monthEntries.find((m) => m.month === key)
      if (month) {
        month.appointments++
        patientPerMonth.get(key)?.add(apt.patientId)
      }
    }

    for (const [key, set] of patientPerMonth) {
      const month = monthEntries.find((m) => m.month === key)
      if (month) month.patients = set.size
    }

    for (const pmt of paymentsData) {
      const key = `${pmt.date.getFullYear()}-${String(pmt.date.getMonth() + 1).padStart(2, "0")}`
      const month = monthEntries.find((m) => m.month === key)
      if (month) month.revenue += pmt.amount
    }

    return monthEntries
  } catch {
    const now = new Date()
    const monthEntries: { month: string; patients: number; appointments: number; revenue: number }[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      monthEntries.push({ month: key, patients: 0, appointments: 0, revenue: 0 })
    }
    return monthEntries
  }
}

export async function getOccupancyRate() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()
  await requireClinicAccessOrThrow(clinicId)

  try {
    // Count appointments today
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const tomorrowStart = new Date(todayStart)
    tomorrowStart.setDate(tomorrowStart.getDate() + 1)

    const [todayAppts, thisMonth, lastMonth] = await Promise.all([
      // Today's appointments count
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, todayStart), lt(appointments.startTime, tomorrowStart))),
      // This month appointments count
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, new Date(todayStart.getFullYear(), todayStart.getMonth(), 1)))),
      // Last month appointments
      db.select({ value: count() }).from(appointments).where(and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, new Date(todayStart.getFullYear(), todayStart.getMonth() - 1, 1)), lt(appointments.startTime, new Date(todayStart.getFullYear(), todayStart.getMonth(), 1)))),
    ])

    // Assume 8 slots per day (9h-12h, 14h-19h) x number of weekdays
    const workingDaysThisMonth = getWorkingDays(todayStart.getFullYear(), todayStart.getMonth() + 1)
    const estimatedMonthlySlots = workingDaysThisMonth * 8

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

function getWorkingDays(year: number, month: number): number {
  // month is 1-indexed
  const daysInMonth = new Date(year, month, 0).getDate()
  let count = 0
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = new Date(year, month - 1, day).getDay()
    if (dow !== 5 && dow !== 6) count++ // Exclude Fri, Sat (Algerian weekend)
  }
  return count
}
