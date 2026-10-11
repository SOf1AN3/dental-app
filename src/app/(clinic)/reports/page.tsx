import { requireAuth, getCurrentRole } from "@/lib/auth-utils"
import { getCurrentClinicId } from "@/lib/multi-tenant"
import { can } from "@/lib/permissions"
import { getPatientStats, getAppointmentStats, getRevenueData, getMonthlyTrends } from "@/lib/actions/reports"
import { formatCurrency } from "@/lib/utils"
import { redirect } from "next/navigation"

const methodLabels: Record<string, string> = {
  cash: "Espèces",
  check: "Chèque",
  card: "Carte bancaire",
  transfer: "Virement",
}

function formatMonthKey(key: string): string {
  const [year, month] = key.split("-")
  const date = new Date(parseInt(year), parseInt(month) - 1, 1)
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(date)
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl bg-white dark:bg-cool-100 p-6 shadow-sm border border-cool-200">
      <p className="text-sm text-cool-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-cool-900">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 rounded-xl bg-white dark:bg-cool-100 p-6 shadow-sm border border-cool-200">
      <h2 className="text-lg font-semibold text-cool-900">{title}</h2>
      <div className="mt-4">{children}</div>
    </div>
  )
}

export default async function ReportsPage() {
  await requireAuth()
  const clinicId = await getCurrentClinicId()

  // RAP-1: global reports are owner-only. Direct URL access by any other
  // role is refused (nav entry is already hidden).
  const role = await getCurrentRole(clinicId)
  if (!role || !can(role, "reports:view")) {
    redirect("/?denied=reports")
  }

  const [patientStats, appointmentStats, revenueData, monthlyTrends] = await Promise.all([
    getPatientStats(),
    getAppointmentStats(),
    getRevenueData(),
    getMonthlyTrends(),
  ])

  return (
    <div>
      <h1 className="text-2xl font-bold text-cool-900">Rapports &amp; Analyses</h1>
      <p className="mt-1 text-cool-500">Aperçu des statistiques de votre clinique.</p>

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <StatCard label="Total patients" value={patientStats.total} />
        <StatCard label="Rendez-vous" value={appointmentStats.total} />
        <StatCard label="Production totale" value={formatCurrency(revenueData.totalRevenue)} />
      </div>

      <Section title="Aperçu mensuel">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-cool-200 text-cool-500">
                <th className="pb-3 font-medium">Mois</th>
                <th className="pb-3 font-medium">Patients</th>
                <th className="pb-3 font-medium">Rendez-vous</th>
                <th className="pb-3 font-medium">Encaissé</th>
              </tr>
            </thead>
            <tbody>
              {monthlyTrends.map((row) => (
                <tr key={row.month} className="border-b border-cool-100 last:border-0">
                  <td className="py-3 text-cool-900 capitalize">{formatMonthKey(row.month)}</td>
                  <td className="py-3 text-cool-700">{row.patients}</td>
                  <td className="py-3 text-cool-700">{row.appointments}</td>
                  <td className="py-3 text-cool-700">{formatCurrency(row.revenue)}</td>
                </tr>
              ))}
              {monthlyTrends.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-cool-400">
                    Aucune donnée disponible.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Répartition des rendez-vous">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[
            { label: "Total", value: appointmentStats.total, color: "bg-cerulean" },
            { label: "Terminés", value: appointmentStats.completed, color: "bg-mint" },
            { label: "Annulés", value: appointmentStats.cancelled, color: "bg-amber" },
            { label: "Absents", value: appointmentStats.noShow, color: "bg-rose" },
          ].map((item) => (
            <div
              key={item.label}
              className="flex items-center gap-4 rounded-lg border border-cool-100 p-4"
            >
              <div className={`h-3 w-3 rounded-full ${item.color}`} />
              <div>
                <p className="text-sm text-cool-500">{item.label}</p>
                <p className="text-xl font-bold text-cool-900">{item.value}</p>
              </div>
            </div>
          ))}
        </div>
        {appointmentStats.byType.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-3 text-sm font-medium text-cool-700">Par type</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-cool-200 text-cool-500">
                    <th className="pb-3 font-medium">Type</th>
                    <th className="pb-3 font-medium">Nombre</th>
                  </tr>
                </thead>
                <tbody>
                  {appointmentStats.byType.map((t) => (
                    <tr key={t.type} className="border-b border-cool-100 last:border-0">
                      <td className="py-3 text-cool-900">{t.type}</td>
                      <td className="py-3 text-cool-700">{t.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section title="Méthodes de paiement">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-cool-200 text-cool-500">
                <th className="pb-3 font-medium">Méthode</th>
                <th className="pb-3 font-medium">Montant</th>
              </tr>
            </thead>
            <tbody>
              {revenueData.byMethod.map((m) => (
                <tr key={m.method} className="border-b border-cool-100 last:border-0">
                  <td className="py-3 text-cool-900">{methodLabels[m.method] ?? m.method}</td>
                  <td className="py-3 text-cool-700">{formatCurrency(m.amount)}</td>
                </tr>
              ))}
              {revenueData.byMethod.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-cool-400">
                    Aucun paiement enregistré.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  )
}
