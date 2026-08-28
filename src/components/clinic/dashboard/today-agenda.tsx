import { db } from "@/lib/db/db";
import { appointments, patients, users } from "@/lib/db/schema";
import { eq, and, gte, lt } from "drizzle-orm";
import { formatDate } from "@/lib/utils";

/**
 * DB-1: today's agenda across ALL practitioners, one color per dentist.
 * Single aggregated query (join users), no N+1. `mine` scopes to one
 * practitioner for the dentist dashboard (DB-3).
 */

const DENTIST_COLORS = [
  "bg-cerulean",
  "bg-mint",
  "bg-amber",
  "bg-teal",
  "bg-purple-500",
  "bg-rose-500",
] as const;

export interface AgendaEntry {
  id: string;
  startTime: Date;
  patientName: string;
  type: string | null;
  status: string;
  dentistId: string | null;
  dentistName: string | null;
}

export const STATUS_LABELS: Record<string, string> = {
  scheduled: "Planifié",
  confirmed: "Confirmé",
  in_progress: "En cours",
  completed: "Terminé",
  cancelled: "Annulé",
  no_show: "Absent",
};

export const STATUS_COLORS: Record<string, string> = {
  scheduled: "text-blue-600 bg-blue-50",
  confirmed: "text-emerald-600 bg-emerald-50",
  in_progress: "text-amber-600 bg-amber-50",
  completed: "text-cool-600 bg-cool-100",
  cancelled: "text-red-600 bg-red-50",
  no_show: "text-cool-400 bg-cool-50",
};

export async function getTodayAgenda(
  clinicId: string,
  dentistId?: string,
): Promise<{ entries: AgendaEntry[]; colorByDentist: Record<string, string>; nameByDentist: Record<string, string> }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  try {
    const rows = await db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        firstName: patients.firstName,
        lastName: patients.lastName,
        type: appointments.type,
        status: appointments.status,
        dentistId: appointments.dentistId,
        dentistFirst: users.name,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(users, eq(appointments.dentistId, users.id))
      .where(
        and(
          eq(appointments.clinicId, clinicId),
          gte(appointments.startTime, todayStart),
          lt(appointments.startTime, tomorrowStart),
          ...(dentistId ? [eq(appointments.dentistId, dentistId)] : []),
        ),
      )
      .orderBy(appointments.startTime);

    const colorByDentist: Record<string, string> = {};
    const nameByDentist: Record<string, string> = {};
    let nextColor = 0;
    for (const row of rows) {
      if (!row.dentistId) continue;
      if (!colorByDentist[row.dentistId]) {
        colorByDentist[row.dentistId] = DENTIST_COLORS[nextColor % DENTIST_COLORS.length];
        nextColor++;
      }
      nameByDentist[row.dentistId] ??= row.dentistFirst ?? "Praticien";
    }

    const entries: AgendaEntry[] = rows.map((row) => ({
      id: row.id,
      startTime: row.startTime,
      patientName: `${row.lastName} ${row.firstName}`,
      type: row.type,
      status: row.status,
      dentistId: row.dentistId,
      dentistName: row.dentistId ? (nameByDentist[row.dentistId] ?? null) : null,
    }));

    return { entries, colorByDentist, nameByDentist };
  } catch {
    return { entries: [], colorByDentist: {}, nameByDentist: {} };
  }
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function TodayAgenda({
  entries,
  colorByDentist,
  showDentist = true,
}: {
  entries: AgendaEntry[];
  colorByDentist: Record<string, string>;
  showDentist?: boolean;
}) {
  if (entries.length === 0) {
    return <p className="mt-4 text-cool-400">Aucun rendez-vous aujourd&apos;hui.</p>;
  }

  return (
    <ul className="mt-4 divide-y divide-cool-100">
      {entries.map((appt) => (
        <li key={appt.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 items-center gap-3">
            {showDentist && appt.dentistId && (
              <span
                className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  colorByDentist[appt.dentistId] ?? "bg-cool-300"
                }`}
                title={appt.dentistName ?? undefined}
              />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-cool-900">{appt.patientName}</p>
              <p className="truncate text-xs text-cool-500">
                {formatTime(appt.startTime)} · {appt.type ?? "Consultation"}
                {showDentist && appt.dentistName ? ` · ${appt.dentistName}` : ""}
              </p>
            </div>
          </div>
          <span
            className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              STATUS_COLORS[appt.status] ?? "text-cool-600 bg-cool-50"
            }`}
          >
            {STATUS_LABELS[appt.status] ?? appt.status}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AgendaLegend({ colorByDentist, nameByDentist }: { colorByDentist: Record<string, string>; nameByDentist: Record<string, string> }) {
  const ids = Object.keys(colorByDentist);
  if (ids.length < 2) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
      {ids.map((id) => (
        <span key={id} className="inline-flex items-center gap-1.5 text-xs text-cool-500">
          <span className={`inline-block h-2 w-2 rounded-full ${colorByDentist[id]}`} />
          {nameByDentist[id]}
        </span>
      ))}
    </div>
  );
}

export function AgendaFooter({ clinicId }: { clinicId: string }) {
  void clinicId;
  return (
    <p className="mt-4 text-xs text-cool-400">
      Vue du jour — {formatDate(new Date())}
    </p>
  );
}
