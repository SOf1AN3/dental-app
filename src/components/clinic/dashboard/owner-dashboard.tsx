import { Suspense } from "react";
import Link from "next/link";
import { db } from "@/lib/db/db";
import { appointments, patients, invoices, waitingRoomEntries } from "@/lib/db/schema";
import { eq, and, gte, lt, count, sum } from "drizzle-orm";
import { formatCurrency } from "@/lib/utils";
import { UserPlus } from "lucide-react";
import { RevenueChart } from "@/components/clinic/revenue-chart";
import { TrendsChart } from "@/components/clinic/trends-chart";
import { getMonthlyTrends, getRevenueData, getOccupancyRate } from "@/lib/actions/reports";
import { StatCards } from "./stat-cards";
import { TodayAgenda, AgendaLegend, getTodayAgenda } from "./today-agenda";

/**
 * DB-4 — Owner/admin dashboard: all-dentist agenda as the main block,
 * clinic-wide counters and global revenue + history.
 */
export async function OwnerDashboard({ clinicId }: { clinicId: string }) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Tableau de bord</h1>
          <p className="mt-1 text-cool-500">Vue globale de la clinique.</p>
        </div>
        <Link
          href="/patients/new"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          Nouveau patient
        </Link>
      </div>

      {/* Main block: all-dentist agenda (DB-1) */}
      <Suspense fallback={<div className="mt-8 rounded-xl bg-white p-6 shadow-sm border border-cool-100"><div className="h-48 animate-pulse rounded-lg bg-cool-100" /></div>}>
        <AllAgenda clinicId={clinicId} />
      </Suspense>

      <Suspense fallback={<div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-cool-100" />)}</div>}>
        <OwnerStats
          clinicId={clinicId}
          todayStart={todayStart}
          tomorrowStart={tomorrowStart}
        />
      </Suspense>

      <Suspense fallback={<div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">{[0, 1].map((i) => <div key={i} className="h-72 animate-pulse rounded-xl bg-cool-100" />)}</div>}>
        <OwnerCharts />
      </Suspense>

      <Suspense fallback={<div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100"><div className="h-16 animate-pulse rounded-lg bg-cool-100" /></div>}>
        <OccupancyBlock />
      </Suspense>
    </div>
  );
}

async function AllAgenda({ clinicId }: { clinicId: string }) {
  const agenda = await getTodayAgenda(clinicId);
  return (
    <div className="mt-8 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
      <h2 className="text-lg font-semibold text-cool-900">Agenda du jour — tous dentistes</h2>
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
    [{ count: waitingCount }],
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
      .where(and(eq(waitingRoomEntries.clinicId, clinicId), eq(waitingRoomEntries.status, "waiting"))),
    db
      .select({ total: sum(invoices.total) })
      .from(invoices)
      .where(and(eq(invoices.clinicId, clinicId), gte(invoices.date, todayStart), lt(invoices.date, tomorrowStart))),
  ]);

  return (
    <StatCards
      stats={[
        { label: "Patients", value: String(totalPatients), color: "bg-cerulean" },
        { label: "RDV aujourd'hui", value: String(todayApptCount), color: "bg-mint" },
        { label: "En salle d'attente", value: String(waitingCount), color: "bg-amber" },
        {
          label: "Revenu global du jour",
          value: formatCurrency(Number(todayRevenue) || 0),
          color: "bg-teal",
        },
      ]}
    />
  );
}

async function OwnerCharts() {
  const [monthlyTrends, revenueData] = await Promise.all([
    getMonthlyTrends(),
    getRevenueData(),
  ]);

  return (
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
  );
}

async function OccupancyBlock() {
  const occupancy = await getOccupancyRate();

  return (
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
  );
}
