import { requireAuth } from "@/lib/auth-utils"
import { getCurrentClinicId } from "@/lib/multi-tenant"
import { db } from "@/lib/db/db"
import { appointments, patients, invoices, waitingRoomEntries } from "@/lib/db/schema"
import { eq, and, gte, lt, count, sum, desc } from "drizzle-orm"
import { formatCurrency, formatDate } from "@/lib/utils"
import { LayoutDashboard } from "lucide-react"
import { RevenueChart } from "@/components/clinic/revenue-chart"
import { TrendsChart } from "@/components/clinic/trends-chart"
import { getMonthlyTrends, getRevenueData, getOccupancyRate } from "@/lib/actions/reports"

const STATUS_LABELS: Record<string, string> = {
  scheduled: "Planifié",
  confirmed: "Confirmé",
  in_progress: "En cours",
  completed: "Terminé",
  cancelled: "Annulé",
  no_show: "Absent",
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: "text-blue-600 bg-blue-50",
  confirmed: "text-emerald-600 bg-emerald-50",
  in_progress: "text-amber-600 bg-amber-50",
  completed: "text-cool-600 bg-cool-100",
  cancelled: "text-red-600 bg-red-50",
  no_show: "text-cool-400 bg-cool-50",
}

export default async function ClinicDashboard() {
  const user = await requireAuth()
  const clinicId = await getCurrentClinicId()

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const tomorrowStart = new Date(todayStart)
  tomorrowStart.setDate(tomorrowStart.getDate() + 1)

  const [
    [{ count: todayApptCount }],
    [{ count: totalPatients }],
    [{ count: waitingCount }],
    [{ total: todayRevenue }],
    recentAppointments,
    todayAppointments,
    monthlyTrends,
    revenueData,
    occupancy,
  ] = await Promise.all([
    db
      .select({ count: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.clinicId, clinicId),
          gte(appointments.startTime, todayStart),
          lt(appointments.startTime, tomorrowStart)
        )
      ),
    db
      .select({ count: count() })
      .from(patients)
      .where(eq(patients.clinicId, clinicId)),
    db
      .select({ count: count() })
      .from(waitingRoomEntries)
      .where(
        and(
          eq(waitingRoomEntries.clinicId, clinicId),
          eq(waitingRoomEntries.status, "waiting")
        )
      ),
    db
      .select({ total: sum(invoices.total) })
      .from(invoices)
      .where(
        and(
          eq(invoices.clinicId, clinicId),
          gte(invoices.date, todayStart),
          lt(invoices.date, tomorrowStart)
        )
      ),
    db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        status: appointments.status,
        type: appointments.type,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .where(eq(appointments.clinicId, clinicId))
      .orderBy(desc(appointments.startTime))
      .limit(5),
    db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        endTime: appointments.endTime,
        patientFirstName: patients.firstName,
        patientLastName: patients.lastName,
        status: appointments.status,
        type: appointments.type,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .where(
        and(
          eq(appointments.clinicId, clinicId),
          gte(appointments.startTime, todayStart),
          lt(appointments.startTime, tomorrowStart)
        )
      )
      .orderBy(appointments.startTime),
    getMonthlyTrends(),
    getRevenueData(),
    getOccupancyRate(),
  ])

  const stats = [
    { label: "Patients aujourd'hui", value: String(totalPatients), color: "bg-cerulean" },
    { label: "Rendez-vous aujourd'hui", value: String(todayApptCount), color: "bg-mint" },
    { label: "En salle d'attente", value: String(waitingCount), color: "bg-amber" },
    { label: "Chiffre d'aujourd'hui", value: formatCurrency(Number(todayRevenue) || 0), color: "bg-teal" },
  ]

  return (
    <div>
      <h1 className="text-2xl font-bold text-cool-900">Tableau de bord</h1>
      <p className="mt-1 text-cool-500">Bienvenue, {user.name ?? user.email}.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
            <div className={`inline-flex rounded-lg ${stat.color} p-3 text-white`}>
              <LayoutDashboard className="h-6 w-6" />
            </div>
            <p className="mt-4 text-2xl font-bold text-cool-900">{stat.value}</p>
            <p className="text-sm text-cool-500">{stat.label}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
          <h2 className="text-lg font-semibold text-cool-900">Rendez-vous du jour</h2>
          {todayAppointments.length === 0 ? (
            <p className="mt-4 text-cool-400">Aucun rendez-vous aujourd&apos;hui.</p>
          ) : (
            <ul className="mt-4 divide-y divide-cool-100">
              {todayAppointments.map((appt) => (
                <li key={appt.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-cool-900">
                      {appt.patientFirstName} {appt.patientLastName}
                    </p>
                    <p className="text-xs text-cool-500">
                      {formatDate(appt.startTime)} · {appt.type ?? "Consultation"}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      STATUS_COLORS[appt.status] ?? "text-cool-600 bg-cool-50"
                    }`}
                  >
                    {STATUS_LABELS[appt.status] ?? appt.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
          <h2 className="text-lg font-semibold text-cool-900">Derniers rendez-vous</h2>
          {recentAppointments.length === 0 ? (
            <p className="mt-4 text-cool-400">Aucun rendez-vous récent.</p>
          ) : (
            <ul className="mt-4 divide-y divide-cool-100">
              {recentAppointments.map((appt) => (
                <li key={appt.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-cool-900">
                      {appt.patientFirstName} {appt.patientLastName}
                    </p>
                    <p className="text-xs text-cool-500">
                      {formatDate(appt.startTime)} · {appt.type ?? "Consultation"}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      STATUS_COLORS[appt.status] ?? "text-cool-600 bg-cool-50"
                    }`}
                  >
                    {STATUS_LABELS[appt.status] ?? appt.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Charts: Revenue + Trends */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
          <h2 className="text-lg font-semibold text-cool-900">Revenus (6 mois)</h2>
          <div className="mt-4">
            <RevenueChart data={revenueData.monthlyRevenue} />
          </div>
        </div>
        <div className="rounded-xl bg-white p-6 shadow-sm border border-cool-100">
          <h2 className="text-lg font-semibold text-cool-900">Tendance (6 mois)</h2>
          <div className="mt-4">
            <TrendsChart data={monthlyTrends} />
          </div>
        </div>
      </div>

      {/* Occupancy Rate */}
      <div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
        <h2 className="text-lg font-semibold text-cool-900">Taux d&apos;occupation</h2>
        <div className="mt-4 flex flex-wrap items-center gap-6">
          <div className="flex flex-col items-center">
            <span className="text-3xl font-bold text-cerulean">{occupancy.rate}%</span>
            <span className="text-xs text-cool-500">Ce mois</span>
          </div>
          <div className="flex flex-wrap gap-8 text-sm text-cool-600">
            <div><span className="font-semibold text-cool-900">{occupancy.thisMonth}</span> RDV ce mois</div>
            <div><span className="font-semibold text-cool-900">{occupancy.lastMonth}</span> RDV mois dernier</div>
            <div><span className="font-semibold text-cool-900">{occupancy.estimatedMonthlySlots}</span> Créneaux estimés</div>
          </div>
        </div>
      </div>
    </div>
  )
}
