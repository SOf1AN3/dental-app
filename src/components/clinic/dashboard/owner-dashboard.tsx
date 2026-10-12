import { Suspense } from "react";
import Link from "next/link";
import { db } from "@/lib/db/db";
import { appointments, patients, invoices, waitingRoomEntries } from "@/lib/db/schema";
import { eq, and, gte, lt, count, sum, inArray } from "drizzle-orm";
import { formatCurrency } from "@/lib/utils";
import { CalendarDays, CircleDollarSign, Sofa, UserPlus, Users } from "lucide-react";
import { RevenueChart } from "@/components/clinic/revenue-chart";
import { TrendsChart } from "@/components/clinic/trends-chart";
import { getMonthlyTrends, getRevenueData, getOccupancyRate } from "@/lib/actions/reports";
import { StatCards } from "./stat-cards";
import { TodayAgenda, AgendaLegend, getTodayAgenda } from "./today-agenda";
import { PageHeader } from "@/components/ui/page-header";

/**
 * DB-4 — Owner/admin dashboard: KPI counters first, then the all-dentist
 * agenda, then global revenue + history and the occupancy rate.
 */
export async function OwnerDashboard({ clinicId }: { clinicId: string }) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  return (
    <div>
      <PageHeader
        title="Tableau de bord"
        description="Vue globale de la clinique."
        actions={
          <Link
            href="/patients/new"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
          >
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Nouveau patient
          </Link>
        }
      />

      {/* KPI first: the numbers a practitioner comes to check */}
      <Suspense fallback={<div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-cool-100" />)}</div>}>
        <OwnerStats
          clinicId={clinicId}
          todayStart={todayStart}
          tomorrowStart={tomorrowStart}
        />
      </Suspense>

      {/* All-dentist agenda (DB-1) */}
      <Suspense fallback={<div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card"><div className="h-48 animate-pulse rounded-lg bg-cool-100 dark:bg-cool-200" /></div>}>
        <AllAgenda clinicId={clinicId} />
      </Suspense>

      <Suspense fallback={<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-72 animate-pulse rounded-xl bg-cool-100" />)}</div>}>
        <OwnerCharts />
      </Suspense>

      <Suspense fallback={<div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card"><div className="h-16 animate-pulse rounded-lg bg-cool-100 dark:bg-cool-200" /></div>}>
        <OccupancyBlock />
      </Suspense>
    </div>
  );
}

async function AllAgenda({ clinicId }: { clinicId: string }) {
  const agenda = await getTodayAgenda(clinicId);
  return (
    <div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card">
      <h2 className="text-lg font-semibold text-foreground">Agenda du jour — tous dentistes</h2>
      <TodayAgenda entries={agenda.entries} colorByDentist={agenda.colorByDentist} showDentist />
      <AgendaLegend colorByDentist={agenda.colorByDentist} nameByDentist={agenda.nameByDentist} />
    </div>
  );
}

async function OwnerStats({
  clinicId,
  todayStart,
  tomorrowStart,
}: {
  clinicId: string;
  todayStart: Date;
  tomorrowStart: Date;
}) {
  const [
    [{ count: totalPatients }],
    [{ count: todayApptCount }],
    [{ count: presentCount }],
    [{ total: todayRevenue }],
  ] = await Promise.all([
    db.select({ count: count() }).from(patients).where(eq(patients.clinicId, clinicId)),
    db
      .select({ count: count() })
      .from(appointments)
      .where(and(eq(appointments.clinicId, clinicId), gte(appointments.startTime, todayStart), lt(appointments.startTime, tomorrowStart))),
    db
      .select({ count: count() })
      .from(waitingRoomEntries)
      // Mêmes statuts « actifs » que l'unicité `uq_waiting_room_active_patient_clinic`
      // (et que `getWaitingRoom`) : filtrer sur `waiting` seul masquait les
      // patients appelés / en soin qui continuaient de bloquer le ré-ajout.
      .where(and(eq(waitingRoomEntries.clinicId, clinicId), inArray(waitingRoomEntries.status, ["waiting", "called", "in_treatment"]))),
    db
      .select({ total: sum(invoices.total) })
      .from(invoices)
      .where(and(eq(invoices.clinicId, clinicId), gte(invoices.date, todayStart), lt(invoices.date, tomorrowStart))),
  ]);

  return (
    <div className="mt-8">
      <StatCards
        stats={[
          { label: "Patients", value: String(totalPatients), color: "bg-cerulean", icon: Users },
          { label: "RDV aujourd'hui", value: String(todayApptCount), color: "bg-mint", icon: CalendarDays },
          { label: "Présents en salle d'attente", value: String(presentCount), color: "bg-amber", icon: Sofa },
          {
            label: "Revenu global du jour",
            value: formatCurrency(Number(todayRevenue) || 0),
            color: "bg-teal",
            icon: CircleDollarSign,
          },
        ]}
      />
    </div>
  );
}

async function OwnerCharts() {
  const [monthlyTrends, revenueData] = await Promise.all([
    getMonthlyTrends(),
    getRevenueData(),
  ]);

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="rounded-xl bg-card p-6 shadow-sm border border-border-card">
        <h2 className="text-lg font-semibold text-foreground">Production (6 mois)</h2>
        <div className="mt-4">
          <RevenueChart data={revenueData.monthlyRevenue} />
        </div>
      </div>
      <div className="rounded-xl bg-card p-6 shadow-sm border border-border-card">
        <h2 className="text-lg font-semibold text-foreground">Tendance encaissé (6 mois)</h2>
        <div className="mt-4">
          <TrendsChart data={monthlyTrends} />
        </div>
      </div>
    </div>
  );
}

async function OccupancyBlock() {
  const occupancy = await getOccupancyRate();

  return (
    <div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card">
      <h2 className="text-lg font-semibold text-foreground">Taux d&apos;occupation</h2>
      <div className="mt-4 flex flex-wrap items-center gap-6">
        <div className="flex flex-col items-center">
          <span className="text-3xl font-bold text-cerulean">{occupancy.rate}%</span>
          <span className="text-xs text-muted-fg">Ce mois</span>
        </div>
        <div className="flex flex-wrap gap-8 text-sm text-muted-fg">
          <div><span className="font-semibold text-foreground">{occupancy.thisMonth}</span> RDV ce mois</div>
          <div><span className="font-semibold text-foreground">{occupancy.lastMonth}</span> RDV mois dernier</div>
          <div><span className="font-semibold text-foreground">{occupancy.estimatedMonthlySlots}</span> Créneaux estimés</div>
        </div>
      </div>
    </div>
  );
}
