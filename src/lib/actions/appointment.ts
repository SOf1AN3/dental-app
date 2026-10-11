"use server";

import { db } from "@/lib/db/db";
import { appointments, patients, users, clinicMemberships, clinics } from "@/lib/db/schema";
import { eq, and, or, lt, gt, notInArray, ne, gte, asc, inArray } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { requireOwnedPatient } from "@/lib/guards";
import { PRACTITIONER_ROLES } from "@/lib/constants";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";
import {
  DEFAULT_MIN_GAP_MINUTES,
  generateSlots,
  getClinicDateString,
  isSlotAvailable,
  isWithinClinicHours,
  offsetMinutesForTz,
  resolveClinicHoursForDate,
} from "@/lib/appointment-rules";
import { getClinicScheduleMap } from "@/lib/clinic-schedule";

const appointmentSchema = z.object({
  patientId: z.string().min(1, "Patient requis"),
  startTime: z.string().min(1, "Date et heure requises"),
  endTime: z.string().optional().or(z.literal("")),
  dentistId: z.string().optional().or(z.literal("")),
  type: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
  color: z.string().optional().or(z.literal("")),
});

/**
 * Z-53 — parse une date-heure de formulaire dans le fuseau de la CLINIQUE.
 *
 * Deux formes acceptées :
 *  • ISO 8601 avec offset (`2026-06-15T09:00:00.000Z`, `…+01:00`) : instant
 *    absolu déjà non ambigu, `Date` fait foi telle quelle ;
 *  • forme naive `YYYY-MM-DDTHH:mm[:ss]` — format natif des `<input
 *    type="datetime-local">` — interprétée comme une heure LOCALE de la clinique
 *    (Alger). `new Date("2026-06-15T09:00")` l'interpréterait dans le fuseau du
 *    SERVEUR (une chaîne sans offset est « server-local » en ECMAScript) : serveur
 *    UTC + clinique Alger = RDV enregistrés avec 1 h d'avance, silencieusement.
 *
 * Le décalage provient de `offsetMinutesForTz` (DST-aware, déjà employé partout
 * ailleurs dans ce module) : aucun calcul de fuseau n'est réécrit ici. Deux
 * passes : l'offset est d'abord relevé sur l'instant « probe » (la date visée
 * exprimée en UTC), puis recalculé sur l'instant résultant — si une transition
 * d'heure locale sépare les deux, la seconde valeur l'emporte.
 *
 * Retourne `null` si la chaîne est vide, mal formée ou si le calendrier est
 * invalide (`2026-02-31`) : l'appelant renvoie alors une erreur de champ (400)
 * au lieu d'un `Invalid Date` qui se propageait dans les comparaisons jusqu'à un
 * `RangeError` non intercepté (500).
 */
function parseClinicDateTime(value: string, timeZone: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  // Offset explicite : lecture directe, sans réinterprétation.
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
    const withOffset = new Date(trimmed);
    return Number.isNaN(withOffset.getTime()) ? null : withOffset;
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(asUtc);
  // `Date.UTC` « roule » les composants hors plage (2026-02-31 → 2026-03-03,
  // 25 h → lendemain 01:00) : on rejette tout aller-retour non conservant.
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return null;
  }

  const firstOffset = offsetMinutesForTz(timeZone, probe);
  let instant = asUtc - firstOffset * 60_000;
  const secondOffset = offsetMinutesForTz(timeZone, new Date(instant));
  if (secondOffset !== firstOffset) {
    instant = asUtc - secondOffset * 60_000;
  }
  return new Date(instant);
}

/**
 * Z-53 — bornes `[start, end)` (fin EXCLUSIVE) d'une journée `YYYY-MM-DD` dans
 * le fuseau de la CLINIQUE.
 *
 * Remplace le découpage `setHours(0,0,0,0)` / `setHours(23,59,59,999)` effectué
 * sur le fuseau du SERVEUR : avec un serveur UTC et une clinique Alger
 * (UTC+1), la tranche algéroise 00:00–01:00 (et la dernière minute du jour)
 * sortait de l'intervalle. L'offset de chaque borne est relevé à midi (probe UTC
 * du jour — même convention que `getAvailableSlots`) puis réappliqué : une
 * journée à cheval sur une transition d'heure reste exacte.
 */
function clinicDayBounds(timeZone: string, clinicDate: string): { start: Date; end: Date } {
  const [year, month, day] = clinicDate.split("-").map(Number);
  const dayStartUtc = Date.UTC(year, month - 1, day);
  const nextDayStartUtc = Date.UTC(year, month - 1, day + 1);
  const noonProbeMs = 12 * 60 * 60 * 1000;
  const startOffset = offsetMinutesForTz(timeZone, new Date(dayStartUtc + noonProbeMs));
  const endOffset = offsetMinutesForTz(timeZone, new Date(nextDayStartUtc + noonProbeMs));
  return {
    start: new Date(dayStartUtc - startOffset * 60_000),
    end: new Date(nextDayStartUtc - endOffset * 60_000),
  };
}

interface AppointmentConflict {
  id: string;
  startTime: Date;
  endTime: Date;
  patientName: string;
  dentistName?: string;
}

interface CreateAppointmentState {
  error?: Record<string, string[]>;
  conflict?: AppointmentConflict;
}

async function getClinicHoursAndGap(
  clinicId: string,
  dentistId: string | null,
): Promise<{
  openingTime: string;
  closingTime: string;
  minGapMinutes: number;
  timezone: string;
}> {
  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });
  const openingTime = clinic?.openingTime ?? "08:00";
  const closingTime = clinic?.closingTime ?? "19:00";
  const timezone = clinic?.timezone ?? "Africa/Algiers";
  let minGapMinutes = DEFAULT_MIN_GAP_MINUTES;
  if (dentistId) {
    const membership = await db.query.clinicMemberships.findFirst({
      where: and(
        eq(clinicMemberships.clinicId, clinicId),
        eq(clinicMemberships.userId, dentistId),
      ),
    });
    minGapMinutes = membership?.minGapMinutes ?? DEFAULT_MIN_GAP_MINUTES;
  }
  return { openingTime, closingTime, minGapMinutes, timezone };
}

function conflictResult(conflict: AppointmentConflict): CreateAppointmentState {
  return {
    error: { general: ["Conflit d'horaire avec un autre rendez-vous (patient ou praticien déjà occupé)"] },
    conflict: {
      id: conflict.id,
      startTime: conflict.startTime,
      endTime: conflict.endTime,
      patientName: conflict.patientName,
      dentistName: conflict.dentistName || undefined,
    },
  };
}

export async function createAppointment(
  prevState: CreateAppointmentState | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = appointmentSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Garde d'appartenance : `patientId` provient du client. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé. Placé APRÈS l'authentification
  // et AVANT la détection de conflit (qui joint `patients` et renvoie un nom de
  // patient dans le payload d'erreur) et avant toute écriture.
  try {
    await requireOwnedPatient(clinicId, data.patientId);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique, inexistant ou archivé) :
    // remontée telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la création du rendez-vous"] } };
  }

  // Z-53 : le fuseau de la clinique est nécessaire AVANT le parsing — les dates
  // du formulaire sont normalisées comme heures LOCALES de la clinique.
  const dentistId = data.dentistId && data.dentistId !== "" ? data.dentistId : null;
  const { openingTime, closingTime, minGapMinutes, timezone } = await getClinicHoursAndGap(clinicId, dentistId);

  const startTimeValue = parseClinicDateTime(data.startTime, timezone);
  if (!startTimeValue) {
    return { error: { startTime: ["Date et heure de début invalide"] } };
  }
  const endTimeValue = data.endTime && data.endTime !== ""
    ? parseClinicDateTime(data.endTime, timezone)
    : new Date(startTimeValue.getTime() + 30 * 60 * 1000);
  if (!endTimeValue) {
    return { error: { endTime: ["Date et heure de fin invalide"] } };
  }

  if (endTimeValue <= startTimeValue) {
    return { error: { general: ["L'heure de fin doit être après l'heure de début"] } };
  }

  if (dentistId) {
    const dentistMember = await db
      .select({ id: users.id })
      .from(clinicMemberships)
      .innerJoin(users, eq(clinicMemberships.userId, users.id))
      .where(and(
        eq(clinicMemberships.clinicId, clinicId),
        eq(clinicMemberships.userId, dentistId),
        inArray(clinicMemberships.role, PRACTITIONER_ROLES),
      ))
      .limit(1);

    if (dentistMember.length === 0) {
      return { error: { dentistId: ["Chirurgien-dentiste invalide pour cette clinique"] } };
    }
  }

  const existing = await db
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      dentistName: users.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .leftJoin(users, eq(appointments.dentistId, users.id))
    .where(and(
      eq(appointments.clinicId, clinicId),
      notInArray(appointments.status, ["cancelled", "no_show"]),
      lt(appointments.startTime, endTimeValue),
      gt(appointments.endTime, startTimeValue),
      or(
        eq(appointments.patientId, data.patientId),
        ...(dentistId ? [eq(appointments.dentistId, dentistId)] : []),
      ),
    ));

  if (existing.length > 0) {
    const conflict = existing[0];
    return conflictResult({
      id: conflict.id,
      startTime: conflict.startTime,
      endTime: conflict.endTime,
      patientName: `${conflict.patientLastName} ${conflict.patientFirstName}`,
      dentistName: conflict.dentistName || undefined,
    });
  }

  const scheduleMap = await getClinicScheduleMap(clinicId);
  const clinicDate = getClinicDateString(timezone, startTimeValue);
  const dayHours = resolveClinicHoursForDate(clinicDate, timezone, scheduleMap, openingTime, closingTime);
  if (dayHours.isClosed) {
    return { error: { startTime: ["La clinique est fermée ce jour-là"] } };
  }
  const utcOffsetMinutes = offsetMinutesForTz(timezone, startTimeValue);

  if (!isWithinClinicHours(startTimeValue, endTimeValue, dayHours.openTime!, dayHours.closeTime!, utcOffsetMinutes)) {
    return { error: { startTime: ["Horaire hors des heures d'ouverture de la clinique"] } };
  }

  if (!isSlotAvailable(startTimeValue, endTimeValue, existing, minGapMinutes)) {
    return { error: { startTime: ["Délai minimal entre rendez-vous non respecté"] } };
  }

  try {
    const [created] = await db.insert(appointments).values({
      clinicId,
      patientId: data.patientId,
      dentistId,
      startTime: startTimeValue,
      endTime: endTimeValue,
      type: data.type || null,
      notes: data.notes || null,
      color: data.color || null,
      status: "scheduled",
    }).returning({ id: appointments.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "appointment",
      entityId: created.id,
      after: {
        patientId: data.patientId,
        dentistId,
        startTime: startTimeValue.toISOString(),
        endTime: endTimeValue.toISOString(),
        type: data.type || null,
        status: "scheduled",
      },
    });

    revalidatePath("/appointments");
    revalidatePath(`/patients/${data.patientId}`);
    redirect("/appointments");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création du rendez-vous"] } };
  }
}

export async function getAvailableSlots(
  date: string,
  dentistId: string | null,
  patientId: string,
  excludeAppointmentId?: string,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });

  const openingTime = clinic?.openingTime ?? "08:00";
  const closingTime = clinic?.closingTime ?? "19:00";
  const timezone = clinic?.timezone ?? "Africa/Algiers";
  const { minGapMinutes } = await getClinicHoursAndGap(clinicId, dentistId);

  const scheduleMap = await getClinicScheduleMap(clinicId);
  const dayHours = resolveClinicHoursForDate(date, timezone, scheduleMap, openingTime, closingTime);

  const todayInClinicTz = getClinicDateString(timezone, new Date());
  let slots: Date[];
  if (date < todayInClinicTz || dayHours.isClosed) {
    slots = [];
  } else {
    const [year, month, day] = date.split("-").map(Number);
    const utcOffsetMinutes = offsetMinutesForTz(
      timezone,
      new Date(Date.UTC(year, month - 1, day, 12)),
    );
    const rangeStart = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const rangeEnd = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));

    const existing = await db
      .select({
        startTime: appointments.startTime,
        endTime: appointments.endTime,
      })
      .from(appointments)
      .where(and(
        eq(appointments.clinicId, clinicId),
        notInArray(appointments.status, ["cancelled", "no_show"]),
        gte(appointments.startTime, rangeStart),
        lt(appointments.startTime, rangeEnd),
        or(
          eq(appointments.patientId, patientId),
          ...(dentistId ? [eq(appointments.dentistId, dentistId)] : []),
        ),
        ...(excludeAppointmentId ? [ne(appointments.id, excludeAppointmentId)] : []),
      ));

    slots = generateSlots(
      date,
      dayHours.openTime!,
      dayHours.closeTime!,
      existing,
      minGapMinutes,
      new Date(),
      undefined,
      undefined,
      utcOffsetMinutes,
    );
  }

  return {
    date,
    slots: slots.map((slot) => slot.toISOString()),
    openingTime: dayHours.openTime ?? openingTime,
    closingTime: dayHours.closeTime ?? closingTime,
    minGapMinutes,
  };
}

export async function updateAppointment(
  appointmentId: string,
  prevState: CreateAppointmentState | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const current = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, appointmentId), eq(appointments.clinicId, clinicId)),
  });

  if (!current) {
    return { error: { general: ["Rendez-vous introuvable"] } };
  }

  if (current.status !== "scheduled" && current.status !== "confirmed") {
    return { error: { general: ["Ce rendez-vous ne peut plus être modifié"] } };
  }

  const validated = appointmentSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  // Z-54 — `patientId` provient du formulaire (le select « Patient » n'est PAS
  // désactivé en édition : l'UI autorise le changement de patient). Il doit donc
  // exister, appartenir à la clinique courante et ne pas être archivé — même
  // garde que `createAppointment`, placée AVANT la détection de conflit (qui
  // joint `patients` et renvoie un nom de patient dans le payload d'erreur) et
  // AVANT l'écriture, qui applique désormais ce `patientId`.
  try {
    await requireOwnedPatient(clinicId, data.patientId);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la mise à jour du rendez-vous"] } };
  }

  // Z-53 : le fuseau de la clinique est nécessaire AVANT le parsing — les dates
  // du formulaire sont normalisées comme heures LOCALES de la clinique.
  const dentistId = data.dentistId && data.dentistId !== "" ? data.dentistId : null;
  const { openingTime, closingTime, minGapMinutes, timezone } = await getClinicHoursAndGap(clinicId, dentistId);

  const startTimeValue = parseClinicDateTime(data.startTime, timezone);
  if (!startTimeValue) {
    return { error: { startTime: ["Date et heure de début invalide"] } };
  }
  const endTimeValue = data.endTime && data.endTime !== ""
    ? parseClinicDateTime(data.endTime, timezone)
    : new Date(startTimeValue.getTime() + 30 * 60 * 1000);
  if (!endTimeValue) {
    return { error: { endTime: ["Date et heure de fin invalide"] } };
  }

  if (endTimeValue <= startTimeValue) {
    return { error: { general: ["L'heure de fin doit être après l'heure de début"] } };
  }

  if (dentistId) {
    const dentistMember = await db
      .select({ id: users.id })
      .from(clinicMemberships)
      .innerJoin(users, eq(clinicMemberships.userId, users.id))
      .where(and(
        eq(clinicMemberships.clinicId, clinicId),
        eq(clinicMemberships.userId, dentistId),
        inArray(clinicMemberships.role, PRACTITIONER_ROLES),
      ))
      .limit(1);

    if (dentistMember.length === 0) {
      return { error: { dentistId: ["Chirurgien-dentiste invalide pour cette clinique"] } };
    }
  }

  const existing = await db
    .select({
      id: appointments.id,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      patientFirstName: patients.firstName,
      patientLastName: patients.lastName,
      dentistName: users.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(appointments.patientId, patients.id))
    .leftJoin(users, eq(appointments.dentistId, users.id))
    .where(and(
      eq(appointments.clinicId, clinicId),
      ne(appointments.id, appointmentId),
      notInArray(appointments.status, ["cancelled", "no_show"]),
      lt(appointments.startTime, endTimeValue),
      gt(appointments.endTime, startTimeValue),
      or(
        eq(appointments.patientId, data.patientId),
        ...(dentistId ? [eq(appointments.dentistId, dentistId)] : []),
      ),
    ));

  if (existing.length > 0) {
    const conflict = existing[0];
    return conflictResult({
      id: conflict.id,
      startTime: conflict.startTime,
      endTime: conflict.endTime,
      patientName: `${conflict.patientLastName} ${conflict.patientFirstName}`,
      dentistName: conflict.dentistName || undefined,
    });
  }

  const scheduleMap = await getClinicScheduleMap(clinicId);
  const clinicDate = getClinicDateString(timezone, startTimeValue);
  const dayHours = resolveClinicHoursForDate(clinicDate, timezone, scheduleMap, openingTime, closingTime);
  if (dayHours.isClosed) {
    return { error: { startTime: ["La clinique est fermée ce jour-là"] } };
  }
  const utcOffsetMinutes = offsetMinutesForTz(timezone, startTimeValue);

  if (!isWithinClinicHours(startTimeValue, endTimeValue, dayHours.openTime!, dayHours.closeTime!, utcOffsetMinutes)) {
    return { error: { startTime: ["Horaire hors des heures d'ouverture de la clinique"] } };
  }

  if (!isSlotAvailable(startTimeValue, endTimeValue, existing, minGapMinutes)) {
    return { error: { startTime: ["Délai minimal entre rendez-vous non respecté"] } };
  }

  try {
    await db
      .update(appointments)
      .set({
        startTime: startTimeValue,
        endTime: endTimeValue,
        // Z-54 — le patient du formulaire est DÉSORMAIS appliqué : sans cette
        // ligne, l'audit enregistrait `after.patientId = data.patientId` alors
        // que la ligne conservait l'ancien patient (audit mensonger), et les
        // conflits étaient calculés sur un patient jamais écrit.
        patientId: data.patientId,
        dentistId,
        type: data.type || null,
        notes: data.notes || null,
        color: data.color && data.color !== "" ? data.color : current.color,
      })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "update",
      entityType: "appointment",
      entityId: appointmentId,
      before: {
        patientId: current.patientId,
        dentistId: current.dentistId,
        startTime: current.startTime.toISOString(),
        endTime: current.endTime.toISOString(),
        type: current.type,
        status: current.status,
      },
      after: {
        patientId: data.patientId,
        dentistId,
        startTime: startTimeValue.toISOString(),
        endTime: endTimeValue.toISOString(),
        type: data.type || null,
        status: current.status,
      },
    });

    revalidatePath("/appointments");
    revalidatePath(`/patients/${data.patientId}`);
    // Z-54 : si le patient a changé, la page de l'ancien patient doit aussi
    // être invalidée (ce RDV n'y figure plus).
    if (current.patientId !== data.patientId) {
      revalidatePath(`/patients/${current.patientId}`);
    }
    redirect("/appointments");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la mise à jour du rendez-vous"] } };
  }
}

type AppointmentStatus = "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled" | "no_show";

const allowedTransitions: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ["confirmed", "cancelled", "no_show", "in_progress"],
  confirmed: ["in_progress", "cancelled", "no_show", "completed"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export async function updateAppointmentStatus(
  appointmentId: string,
  status: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const current = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, appointmentId), eq(appointments.clinicId, clinicId)),
  });

  if (!current) {
    return { error: "Transition de statut non autorisée" };
  }

  const allowed = allowedTransitions[current.status];
  if (!allowed || !allowed.includes(status as AppointmentStatus)) {
    return { error: "Transition de statut non autorisée" };
  }

  try {
    await db
      .update(appointments)
      .set({ status: status as AppointmentStatus })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "appointment",
      entityId: appointmentId,
      before: { status: current.status },
      after: { status: status as AppointmentStatus },
    });

    revalidatePath("/appointments");
    revalidatePath("/waiting-room");
    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du statut" };
  }
}

export async function getAppointmentsForDate(date: Date) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // Z-53 : la journée est bornée dans le fuseau de la CLINIQUE
    // (`getClinicDateString` + `clinicDayBounds`/`offsetMinutesForTz`) et NON
    // plus dans celui du serveur (`setHours(0,0,0,0)` tronquait la nuit locale).
    const clinic = await db.query.clinics.findFirst({
      where: eq(clinics.id, clinicId),
    });
    const timezone = clinic?.timezone ?? "Africa/Algiers";
    const { start, end } = clinicDayBounds(
      timezone,
      getClinicDateString(timezone, date),
    );

    const results = await db
      .select({
        appointment: appointments,
        patient: patients,
      })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .where(
        and(
          eq(appointments.clinicId, clinicId),
          gte(appointments.startTime, start),
          lt(appointments.startTime, end),
        )
      )
      .orderBy(asc(appointments.startTime));

    return results;
  } catch (err) {
    // Z-71 — « 0 patient aujourd'hui » et « lecture impossible » ne sont plus
    // confondus (l'utilisateur planifie sa journée sur ce chiffre) : erreur
    // journalisée puis remontée, contrat `…[]` inchangé — `[]` ne signifie
    // désormais plus qu'« aucune consultation ce jour-là ».
    console.error("[getAppointmentsForDate] lecture des rendez-vous impossible", { clinicId, err });
    throw err;
  }
}
