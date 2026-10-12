import { db } from "@/lib/db/db";
import { appointments, patients, clinics } from "@/lib/db/schema";
import { eq, and, gte, lt, asc } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth } from "@/lib/auth-utils";
import { getClinicScheduleMap } from "@/lib/clinic-schedule";
import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { AgendaNav } from "@/components/clinic/agenda-nav";
import { StatusBadge } from "@/components/shared/status-badge";

// ── Helpers ──────────────────────────────────────────

/** Return the Monday (00:00) of the week containing `date`. */
function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun … 6=Sat
  // If Sunday (0), go back 6 days; otherwise go back (day-1) days
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local YYYY-MM-DD (avoids UTC offset issues in toISOString). */
function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Full French date for the heading. */
function formatFrenchDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });
}

/** "HH:MM:SS" (or "HH:MM") → decimal hours, e.g. "08:30:00" → 8.5. */
function hourFromTime(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h + (m || 0) / 60;
}

// ── Constants ────────────────────────────────────────

const DAY_NAMES = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAY_NAMES_FULL = [
  "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche",
];

const HOURLY_HEIGHT = 60; // px per hour

const STATUS_BG: Record<string, string> = {
  scheduled: "bg-cerulean/15 text-cerulean border-cerulean/25",
  confirmed: "bg-mint/15 text-mint border-mint/25",
  in_progress: "bg-amber/15 text-amber-fg border-amber/25",
  // `text-muted-fg` sur fond teinté `cool-200` (badge « terminé » désactivé).
  completed: "bg-cool-200 text-cool-700 dark:text-muted-fg border-cool-300",
  cancelled: "bg-danger/15 text-danger border-danger/25",
  no_show: "bg-danger/15 text-danger border-danger/25",
};

// ── Page ─────────────────────────────────────────────

export default async function AgendaPage(props: {
  searchParams: Promise<{ week?: string }>;
}) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  const { week } = await props.searchParams;

  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });

  const schedule = await getClinicScheduleMap(clinicId);

  const dayMeta = Array.from({ length: 7 }, (_, i) => {
    const e = schedule[i];
    return {
      open: e?.openTime ?? clinic?.openingTime ?? "08:00",
      close: e?.closeTime ?? clinic?.closingTime ?? "19:00",
      isClosed: e?.isClosed ?? false,
      isWeekend: e?.isWeekend ?? false,
    };
  });

  const openDays = dayMeta.filter((d) => !d.isClosed);
  const START_HOUR = openDays.length > 0
    ? Math.min(...openDays.map((d) => Math.floor(hourFromTime(d.open))))
    : 8;
  const END_HOUR = openDays.length > 0
    ? Math.max(
        ...openDays.map((d) => Math.ceil(hourFromTime(d.close))),
        START_HOUR + 1,
      )
    : 19;
  const HOURS_COUNT = END_HOUR - START_HOUR + 1;

  // Determine the Monday of the requested week (default = current week)
  const monday = week ? getMonday(new Date(week)) : getMonday(new Date());
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  // Build array of 7 Date objects (Mon → Sun)
  const weekDays: Date[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    return d;
  });

  // ── Fetch appointments for the week ──
  const appointmentList = await db
    .select({
      appointment: appointments,
      patient: patients,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .where(
      and(
        eq(appointments.clinicId, clinicId),
        gte(appointments.startTime, monday),
        lt(appointments.startTime, nextMonday),
      ),
    )
    .orderBy(asc(appointments.startTime));

  // Group by day index (0=Mon … 6=Sun)
  const byDay: Record<number, typeof appointmentList> = {};
  for (const item of appointmentList) {
    const dow = item.appointment.startTime.getDay(); // 0=Sun
    const idx = dow === 0 ? 6 : dow - 1; // convert to Mon=0
    if (!byDay[idx]) byDay[idx] = [];
    byDay[idx].push(item);
  }

  // ── Hour slots ──
  const hours: number[] = Array.from(
    { length: HOURS_COUNT },
    (_, i) => START_HOUR + i,
  );
  const totalHeight = hours.length * HOURLY_HEIGHT;

  // ── Render ──
  return (
    <div>
      {/* ── Header ── */}
      <PageHeader
        title="Agenda"
        description={
          <>
            Semaine du {formatFrenchDate(monday)} au{" "}
            {formatFrenchDate(new Date(nextMonday.getTime() - 86_400_000))}
          </>
        }
        actions={
          <>
            <AgendaNav />
            <Link
              href="/appointments/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Nouveau RDV
            </Link>
          </>
        }
      />

      {/* ── View toggle ── */}
      <div className="mb-4 flex items-center gap-4 border-b border-border-card pb-2">
        <Link
          href="/appointments"
          className="text-sm font-medium text-muted-fg hover:text-foreground transition-colors pb-1"
        >
          Liste
        </Link>
        <Link
          href="/appointments/agenda"
          className="text-sm font-medium text-cerulean border-b-2 border-cerulean pb-1"
        >
          Agenda
        </Link>
      </div>

      {/* ══════════════════════════════════════════════
          DESKTOP – Weekly grid (lg+)
          ══════════════════════════════════════════════ */}
      <div className="hidden lg:block overflow-x-auto rounded-xl border border-border-card bg-card">
        <div className="min-w-[900px]">
          {/* ── Day headers ── */}
          <div className="flex border-b border-border-card bg-cool-50 dark:bg-cool-100">
            <div className="w-20 flex-shrink-0 px-3 py-3 text-xs font-medium uppercase text-muted-fg">
              Horaire
            </div>
            {weekDays.map((day, i) => {
              const meta = dayMeta[i];
              return (
                <div
                  key={i}
                  className="flex-1 px-2 py-3 text-center border-l border-border-card"
                >
                  <div className="text-xs font-medium uppercase text-muted-fg">
                    {DAY_NAMES[i]}
                  </div>
                  <div className="text-lg font-bold text-foreground">
                    {day.getDate()}
                  </div>
                  <div className="mt-1 flex items-center justify-center gap-1">
                    {meta.isClosed && (
                      <span className="rounded-full bg-cool-200 px-2 py-0.5 text-[10px] font-medium text-muted-fg">
                        Fermé
                      </span>
                    )}
                    {meta.isWeekend && (
                      <span className="rounded-full bg-cool-200 px-2 py-0.5 text-[10px] font-medium text-muted-fg">
                        Week-end
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Body: time column + day columns ── */}
          <div className="flex">
            {/* Time gutter */}
            <div className="w-20 flex-shrink-0">
              {hours.map((h) => (
                <div
                  key={h}
                  className="border-r border-b border-border-card px-3 pt-1 text-xs leading-none text-muted-fg"
                  style={{ height: HOURLY_HEIGHT }}
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              ))}
            </div>

            {/* Day columns */}
            {weekDays.map((_, dayIdx) => {
              const dayAppts = byDay[dayIdx] || [];
              const meta = dayMeta[dayIdx];
              const columnBg = !meta.isClosed && meta.isWeekend
                ? "bg-cool-50/40"
                : "";
              return (
                <div
                  key={dayIdx}
                  className={`relative flex-1 border-l border-border-card ${columnBg}`}
                  style={{ height: totalHeight }}
                >
                  {meta.isClosed && (
                    <div className="absolute inset-0 flex items-center justify-center bg-cool-50/80 text-muted-fg">
                      <span className="text-sm font-medium">Fermé</span>
                    </div>
                  )}
                  {/* Hour grid lines */}
                  {hours.map((h) => (
                    <div
                      key={h}
                      className="border-b border-border-card"
                      style={{ height: HOURLY_HEIGHT }}
                    />
                  ))}

                  {/* Appointment blocks */}
                  {dayAppts.map(({ appointment, patient }) => {
                    const s = appointment.startTime;
                    const e = appointment.endTime;
                    const startMin =
                      (s.getHours() - START_HOUR) * 60 + s.getMinutes();
                    const durMin =
                      (e.getHours() - s.getHours()) * 60 +
                      (e.getMinutes() - s.getMinutes());

                    // Clamp to visible range
                    const clampedStart = Math.max(0, startMin);
                    const clampedEnd = Math.min(
                      HOURS_COUNT * 60,
                      startMin + durMin,
                    );
                    const top =
                      (clampedStart / 60) * HOURLY_HEIGHT;
                    const height = Math.max(
                      ((clampedEnd - clampedStart) / 60) * HOURLY_HEIGHT,
                      20,
                    );

                    const bg =
                      STATUS_BG[appointment.status] ||
                      "bg-cool-100 text-muted-fg border-border-card";
                    const timeStr = `${s.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;

                    return (
                      <Link
                        key={appointment.id}
                        href={`/patients/${patient.id}`}
                        className={`absolute left-0.5 right-0.5 z-10 rounded-md border px-1.5 py-1 text-xs overflow-hidden hover:shadow-md transition-shadow ${bg}`}
                        style={{ top: `${top}px`, height: `${height}px` }}
                      >
                        <div className="flex items-center gap-1">
                          <span className="font-semibold truncate min-w-0">
                            {patient.lastName}
                          </span>
                          <span className="opacity-80 whitespace-nowrap">
                            {timeStr}
                          </span>
                        </div>
                        {height >= 36 && (
                          <div className="opacity-70 truncate text-[10px] leading-tight">
                            {patient.firstName}
                          </div>
                        )}
                      </Link>
                    );
                  })}

                  {/* Empty day indicator */}
                  {dayAppts.length === 0 && !meta.isClosed && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-xs text-muted-fg select-none">
                        —
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════
          MOBILE / TABLET – day-list (below lg)
          ══════════════════════════════════════════════ */}
      <div className="lg:hidden space-y-4">
        {weekDays.map((day, dayIdx) => {
          const dayAppts = byDay[dayIdx] || [];
          const meta = dayMeta[dayIdx];
          return (
            <div
              key={dayIdx}
              className="rounded-xl border border-border-card bg-card overflow-hidden"
            >
              <div className="flex items-center justify-between bg-cool-50 dark:bg-cool-100 px-4 py-3 border-b border-border-card">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium uppercase text-muted-fg">
                      {DAY_NAMES_FULL[dayIdx]}
                    </span>
                    {meta.isWeekend && (
                      <span className="rounded-full bg-cool-200 px-2 py-0.5 text-[10px] font-medium text-muted-fg">
                        Week-end
                      </span>
                    )}
                  </div>
                  <div className="text-lg font-bold text-foreground">
                    {day.toLocaleDateString("fr-FR", {
                      day: "numeric",
                      month: "long",
                    })}
                  </div>
                </div>
                <Link
                  href={`/appointments?date=${localDateString(day)}`}
                  className="text-xs font-medium text-cerulean hover:underline"
                >
                  Voir la journée
                </Link>
              </div>

              {dayAppts.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-fg">
                  {meta.isClosed ? "Fermé" : "Aucun rendez-vous"}
                </div>
              ) : (
                <div className="divide-y divide-border-card">
                  {dayAppts.map(({ appointment, patient }) => {
                    const bg =
                      STATUS_BG[appointment.status] ||
                      "bg-cool-100 text-muted-fg";
                    return (
                      <Link
                        key={appointment.id}
                        href={`/patients/${patient.id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-cool-50 transition-colors"
                      >
                        {/* Time */}
                        <div className="flex-shrink-0 w-16 text-right">
                          <span className="text-sm font-semibold text-foreground">
                            {appointment.startTime.toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>

                        {/* Color indicator */}
                        <div
                          className={`h-8 w-1 flex-shrink-0 rounded-full ${bg.split(" ")[0]}`}
                        />

                        {/* Patient info */}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-cerulean truncate">
                            {patient.lastName} {patient.firstName}
                          </div>
                          <div className="text-xs text-muted-fg truncate">
                            {appointment.type || "Consultation"}
                          </div>
                        </div>

                        {/* Status */}
                        <StatusBadge status={appointment.status} />
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
