import { requireAuth, getCurrentRole } from "@/lib/auth-utils"
import { getCurrentClinicId } from "@/lib/multi-tenant"
import { can } from "@/lib/permissions"
import { getPatientStats, getAppointmentStats, getRevenueData, getMonthlyTrends } from "@/lib/actions/reports"
import { formatCurrency } from "@/lib/utils"
import { redirect } from "next/navigation"

import { PageHeader } from "@/components/ui/page-header"
import {
  AppointmentTypeTable,
  MonthlyTrendsTable,
  PaymentMethodTable,
} from "@/components/clinic/report-tables"

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border-card bg-card p-6 shadow-sm">
      <p className="text-sm text-muted-fg">{label}</p>
      <p className="mt-2 text-3xl font-bold text-foreground">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 rounded-xl border border-border-card bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
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
      <PageHeader
        title="Rapports & Analyses"
        description="Aperçu des statistiques de votre clinique."
      />

      <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
        <StatCard label="Total patients" value={patientStats.total} />
        <StatCard label="Rendez-vous" value={appointmentStats.total} />
        <StatCard label="Production totale" value={formatCurrency(revenueData.totalRevenue)} />
      </div>

      <Section title="Aperçu mensuel">
        <MonthlyTrendsTable data={monthlyTrends} />
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
              className="flex items-center gap-4 rounded-lg border border-border-card p-4"
            >
              <div className={`h-3 w-3 rounded-full ${item.color}`} />
              <div>
                <p className="text-sm text-muted-fg">{item.label}</p>
                <p className="text-xl font-bold text-foreground">{item.value}</p>
              </div>
            </div>
          ))}
        </div>
        {appointmentStats.byType.length > 0 && (
          <div className="mt-6">
            <h3 className="mb-3 text-sm font-medium text-muted-fg">Par type</h3>
            <AppointmentTypeTable data={appointmentStats.byType} />
          </div>
        )}
      </Section>

      <Section title="Méthodes de paiement">
        <PaymentMethodTable data={revenueData.byMethod} />
      </Section>
    </div>
  )
}
