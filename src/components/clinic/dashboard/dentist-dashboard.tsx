import { Suspense } from "react";
import { db } from "@/lib/db/db";
import { appointments, clinicalSessions, payments } from "@/lib/db/schema";
import { eq, and, gte, lt, count, sum } from "drizzle-orm";
import { formatCurrency } from "@/lib/utils";
import { CalendarCheck, TrendingUp } from "lucide-react";
import { StatCards } from "./stat-cards";
import { TodayAgenda, getTodayAgenda } from "./today-agenda";
import { TrendsChart } from "@/components/clinic/trends-chart";
import { getMonthlyTrends } from "@/lib/actions/reports";
import { PageHeader } from "@/components/ui/page-header";
import { WeekRecapTable } from "./week-recap-table";

/**
 * DB-3 — Dentist dashboard: ONLY their own appointments and their own
 * production/revenue. Never global figures, never colleagues' data.
 * Previous weeks/months recap sits at the bottom of the page.
 */
export async function DentistDashboard({
  clinicId,
  dentistUserId,
  showRevenue,
}: {
  clinicId: string;
  dentistUserId: string;
  showRevenue: boolean;
}) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);

  return (
    <div>
      <PageHeader title="Mon tableau de bord" description="Votre activité du jour." />

      <Suspense fallback={<div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2].map((i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-cool-100" />)}</div>}>
        <DentistStats
          clinicId={clinicId}
          dentistUserId={dentistUserId}
          todayStart={todayStart}
          tomorrowStart={tomorrowStart}
          monthStart={monthStart}
          showRevenue={showRevenue}
        />
      </Suspense>

      <Suspense fallback={<div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card"><div className="h-24 animate-pulse rounded-lg bg-cool-100 dark:bg-cool-200" /></div>}>
        <MyAgenda clinicId={clinicId} dentistUserId={dentistUserId} />
      </Suspense>

      <Suspense fallback={<div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card"><div className="h-64 animate-pulse rounded-lg bg-cool-100 dark:bg-cool-200" /></div>}>
        <MyRecap clinicId={clinicId} dentistUserId={dentistUserId} showRevenue={showRevenue} />
      </Suspense>
    </div>
  );
}

async function DentistStats({
  clinicId,
  dentistUserId,
  todayStart,
  tomorrowStart,
  monthStart,
  showRevenue,
}: {
  clinicId: string;
  dentistUserId: string;
  todayStart: Date;
  tomorrowStart: Date;
  monthStart: Date;
  showRevenue: boolean;
}) {
  const [[{ count: myTodayCount }], [production]] = await Promise.all([
    db
      .select({ count: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.clinicId, clinicId),
          eq(appointments.dentistId, dentistUserId),
          gte(appointments.startTime, todayStart),
          lt(appointments.startTime, tomorrowStart),
        ),
      ),
    db
      .select({ total: sum(clinicalSessions.totalAmount) })
      .from(clinicalSessions)
      .where(
        and(
          eq(clinicalSessions.clinicId, clinicId),
          eq(clinicalSessions.dentistId, dentistUserId),
          gte(clinicalSessions.createdAt, monthStart),
        ),
      ),
  ]);

  return (
    <div className="mt-8">
      <StatCards
        stats={[
          { label: "Mes RDV aujourd'hui", value: String(myTodayCount), color: "bg-cerulean", icon: CalendarCheck },
          ...(showRevenue
            ? [
                {
                  label: "Ma production ce mois",
                  value: formatCurrency(Number(production?.total) || 0),
                  color: "bg-teal",
                  icon: TrendingUp,
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

async function MyAgenda({ clinicId, dentistUserId }: { clinicId: string; dentistUserId: string }) {
  // Scoped to this practitioner only; colors are irrelevant for a single
  // dentist so the legend is hidden.
  const agenda = await getTodayAgenda(clinicId, dentistUserId);
  return (
    <div className="mt-6 rounded-xl bg-card p-6 shadow-sm border border-border-card">
      <h2 className="text-lg font-semibold text-foreground">Mes rendez-vous du jour</h2>
      <TodayAgenda entries={agenda.entries} colorByDentist={agenda.colorByDentist} showDentist={false} />
    </div>
  );
}

async function MyRecap({
  clinicId,
  dentistUserId,
  showRevenue,
}: {
  clinicId: string;
  dentistUserId: string;
  showRevenue: boolean;
}) {
  const trends = await getMonthlyTrends({ dentistId: dentistUserId });

  return (
    <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="rounded-xl bg-card p-6 shadow-sm border border-border-card">
        <h2 className="text-lg font-semibold text-foreground">Mon activité (6 mois)</h2>
        <div className="mt-4">
          <TrendsChart data={trends} />
        </div>
      </div>
      <RecapTable clinicId={clinicId} dentistUserId={dentistUserId} showRevenue={showRevenue} />
    </div>
  );
}

async function RecapTable({
  clinicId,
  dentistUserId,
  showRevenue,
}: {
  clinicId: string;
  dentistUserId: string;
  showRevenue: boolean;
}) {
  const now = new Date();
  const weeks: { label: string; appointments: number; revenue: number }[] = [];

  // Last 4 full weeks, aggregated in two range queries then bucketed.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 27);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  end.setHours(0, 0, 0, 0);

  try {
    const [apptRows, paymentRows] = await Promise.all([
      db
        .select({ startTime: appointments.startTime })
        .from(appointments)
        .where(
          and(
            eq(appointments.clinicId, clinicId),
            eq(appointments.dentistId, dentistUserId),
            gte(appointments.startTime, start),
            lt(appointments.startTime, end),
          ),
        ),
      showRevenue
        ? db
            .select({ date: payments.date, amount: payments.amount })
            .from(payments)
            .where(
              and(
                eq(payments.clinicId, clinicId),
                eq(payments.createdBy, dentistUserId),
                gte(payments.date, start),
                lt(payments.date, end),
              ),
            )
        : Promise.resolve([] as { date: Date; amount: number }[]),
    ]);

    for (let w = 3; w >= 0; w--) {
      const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - w * 7 - 6);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 7);
      const apptCount = apptRows.filter((r) => r.startTime >= weekStart && r.startTime < weekEnd).length;
      const revenue = paymentRows
        .filter((r) => r.date >= weekStart && r.date < weekEnd)
        .reduce((sum2, r) => sum2 + r.amount, 0);
      weeks.push({ label: w === 0 ? "S-0 (en cours)" : `S-${w}`, appointments: apptCount, revenue });
    }
  } catch {
    weeks.push({ label: "S-1", appointments: 0, revenue: 0 });
  }

  return (
    <div className="rounded-xl bg-card p-6 shadow-sm border border-border-card">
      <h2 className="text-lg font-semibold text-foreground">Récapitulatif des 4 dernières semaines</h2>
      <WeekRecapTable weeks={weeks} showRevenue={showRevenue} />
    </div>
  );
}
