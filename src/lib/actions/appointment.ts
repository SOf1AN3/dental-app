"use server";

import { db } from "@/lib/db/db";
import { appointments, patients, users, clinicMemberships, clinics } from "@/lib/db/schema";
import { eq, and, or, lt, gt, notInArray, ne, gte, lte, asc, inArray } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
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

  const startTimeValue = new Date(data.startTime);
  const endTimeValue = data.endTime && data.endTime !== ""
    ? new Date(data.endTime)
    : new Date(startTimeValue.getTime() + 30 * 60 * 1000);

  if (endTimeValue <= startTimeValue) {
    return { error: { general: ["L'heure de fin doit être après l'heure de début"] } };
  }

  const dentistId = data.dentistId && data.dentistId !== "" ? data.dentistId : null;

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

  const { openingTime, closingTime, minGapMinutes, timezone } = await getClinicHoursAndGap(clinicId, dentistId);
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

  const startTimeValue = new Date(data.startTime);
  const endTimeValue = data.endTime && data.endTime !== ""
    ? new Date(data.endTime)
    : new Date(startTimeValue.getTime() + 30 * 60 * 1000);

  if (endTimeValue <= startTimeValue) {
    return { error: { general: ["L'heure de fin doit être après l'heure de début"] } };
  }

  const dentistId = data.dentistId && data.dentistId !== "" ? data.dentistId : null;

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

  const { openingTime, closingTime, minGapMinutes, timezone } = await getClinicHoursAndGap(clinicId, dentistId);
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

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  try {
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
          lte(appointments.startTime, end),
        )
      )
      .orderBy(asc(appointments.startTime));

    return results;
  } catch {
    return [];
  }
}
