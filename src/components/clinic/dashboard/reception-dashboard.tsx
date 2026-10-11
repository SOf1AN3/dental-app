import { Suspense } from "react";
import Link from "next/link";
import { db } from "@/lib/db/db";
import { appointments, invoices, prescriptions, patients, waitingRoomEntries } from "@/lib/db/schema";
import { eq, and, gte, lt, count, sum, desc, inArray } from "drizzle-orm";
import { formatCurrency, formatDate } from "@/lib/utils";
import { UserPlus } from "lucide-react";
import { StatCards } from "./stat-cards";
import { TodayAgenda, getTodayAgenda } from "./today-agenda";

/**
 * DB-2 — Receptionist dashboard: all-dentist agenda, quick "new patient",
 * open (unpaid) invoices, latest prescriptions, today's counts.
 */
export async function ReceptionDashboard({ clinicId }: { clinicId: string }) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-cool-900">Accueil réception</h1>
          <p className="mt-1 text-cool-500">Vue du jour — tous praticiens.</p>
        </div>
        <Link
          href="/patients/new"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-primary-light transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          Nouveau patient
        </Link>
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        <ReceptionStats
          clinicId={clinicId}
          todayStart={todayStart}
          tomorrowStart={tomorrowStart}
        />
      </Suspense>

      <Suspense fallback={<CardSkeleton title="Agenda du jour" />}>
        <ReceptionAgenda clinicId={clinicId} />
      </Suspense>

      <Suspense fallback={<CardSkeleton title="Dernières ordonnances" />}>
        <LatestPrescriptions clinicId={clinicId} />
      </Suspense>

      <Suspense fallback={<CardSkeleton title="Factures ouvertes" />}>
        <OpenInvoices clinicId={clinicId} />
      </Suspense>
    </div>
  );
}

async function ReceptionStats({
  clinicId,
  todayStart,
  tomorrowStart,
}: {
  clinicId: string;
  todayStart: Date;
  tomorrowStart: Date;
}) {
  const [[{ count: apptCount }], [{ count: presentCount }], [unpaid]] = await Promise.all([
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
      .select({ count: count(), total: sum(invoices.total) })
      .from(invoices)
      .where(
        and(
          eq(invoices.clinicId, clinicId),
          inArray(invoices.status, ["draft", "sent", "partially_paid", "overdue"]),
        ),
      ),
  ]);

  return (
    <div className="mt-8">
      <StatCards
        stats={[
          { label: "RDV aujourd'hui", value: String(apptCount), color: "bg-mint" },
          { label: "Présents en salle d'attente", value: String(presentCount), color: "bg-amber" },
          { label: "Factures ouvertes", value: String(unpaid?.count ?? 0), color: "bg-cerulean" },
          {
            label: "Montant à recouvrer",
            value: formatCurrency(Number(unpaid?.total) || 0),
            color: "bg-teal",
          },
        ]}
      />
    </div>
  );
}

async function ReceptionAgenda({ clinicId }: { clinicId: string }) {
  const agenda = await getTodayAgenda(clinicId);
  return (
    <div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
      <h2 className="text-lg font-semibold text-cool-900">Agenda du jour — tous dentistes</h2>
      <TodayAgenda entries={agenda.entries} colorByDentist={agenda.colorByDentist} showDentist />
    </div>
  );
}

async function LatestPrescriptions({ clinicId }: { clinicId: string }) {
  const rows = await db
    .select({
      id: prescriptions.id,
      date: prescriptions.date,
      status: prescriptions.status,
      patientFirst: patients.firstName,
      patientLast: patients.lastName,
    })
    .from(prescriptions)
    .innerJoin(patients, eq(prescriptions.patientId, patients.id))
    .where(eq(prescriptions.clinicId, clinicId))
    .orderBy(desc(prescriptions.createdAt))
    .limit(5);

  return (
    <div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-cool-900">Dernières ordonnances</h2>
        <Link href="/prescriptions" className="text-xs text-cerulean hover:text-cerulean/80">
          Tout voir
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-cool-400">Aucune ordonnance.</p>
      ) : (
        <ul className="mt-4 divide-y divide-cool-100">
          {rows.map((p) => (
            <li key={p.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div>
                <p className="text-sm font-medium text-cool-900">
                  {p.patientLast} {p.patientFirst}
                </p>
                <p className="text-xs text-cool-500">{formatDate(p.date)}</p>
              </div>
              <span className="text-xs text-cool-500">{p.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function OpenInvoices({ clinicId }: { clinicId: string }) {
  const rows = await db
    .select({
      id: invoices.id,
      number: invoices.number,
      date: invoices.date,
      total: invoices.total,
      status: invoices.status,
      patientFirst: patients.firstName,
      patientLast: patients.lastName,
    })
    .from(invoices)
    .innerJoin(patients, eq(invoices.patientId, patients.id))
    .where(
      and(
        eq(invoices.clinicId, clinicId),
        inArray(invoices.status, ["draft", "sent", "partially_paid", "overdue"]),
      ),
    )
    .orderBy(desc(invoices.date))
    .limit(5);

  return (
    <div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-cool-900">Factures ouvertes</h2>
        <Link href="/billing/invoices" className="text-xs text-cerulean hover:text-cerulean/80">
          Tout voir
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-cool-400">Aucune facture ouverte.</p>
      ) : (
        <ul className="mt-4 divide-y divide-cool-100">
          {rows.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div>
                <Link
                  href={`/billing/invoices/${inv.id}`}
                  className="text-sm font-medium text-cool-900 hover:text-cerulean"
                >
                  {inv.number}
                </Link>
                <p className="text-xs text-cool-500">
                  {inv.patientLast} {inv.patientFirst} · {formatDate(inv.date)}
                </p>
              </div>
              <span className="text-sm font-medium text-cool-900">{formatCurrency(inv.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-xl bg-cool-100" />
      ))}
    </div>
  );
}

function CardSkeleton({ title }: { title: string }) {
  return (
    <div className="mt-6 rounded-xl bg-white p-6 shadow-sm border border-cool-100">
      <h2 className="text-lg font-semibold text-cool-400">{title}</h2>
      <div className="mt-4 h-24 animate-pulse rounded-lg bg-cool-100" />
    </div>
  );
}
