"use server";

import { db } from "@/lib/db/db";
import { waitingRoomEntries, appointments, clinics } from "@/lib/db/schema";
import { patients } from "@/lib/db/schema";
import { eq, and, asc, inArray } from "drizzle-orm";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { requireOwnedPatient } from "@/lib/guards";
import { revalidatePath } from "next/cache";
import { logAction } from "@/lib/audit";
import { isSameClinicDate } from "@/lib/appointment-rules";

export async function addToWaitingRoom(appointmentId: string, patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Verify the appointment belongs to the current clinic
  const appointment = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.id, appointmentId),
      eq(appointments.clinicId, clinicId),
    ),
  });

  if (!appointment) {
    return { error: "Rendez-vous introuvable pour cette clinique" };
  }

  // 1) `patientId` est un argument client : le patient doit exister, appartenir
  //    à la clinique courante et ne pas être archivé.
  try {
    await requireOwnedPatient(clinicId, patientId);
  } catch (e) {
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: "Patient introuvable ou archivé" };
    }
    return { error: "Une erreur est survenue lors de l'ajout à la salle d'attente" };
  }

  // 2) `patientId` doit correspondre au patient du rendez-vous. Sans cette
  //    comparaison, on pourrait rattacher le RDV du patient A au dossier
  //    d'attente du patient B — les deux étant membres de la clinique, la
  //    vérification 1 seule ne suffit pas. Placée AVANT la vérification
  //    d'unicité et l'insert, qui utilisent toutes deux ce `patientId`.
  if (appointment.patientId !== patientId) {
    return { error: "Le patient ne correspond pas à ce rendez-vous" };
  }

  const clinic = await db.query.clinics.findFirst({
    where: eq(clinics.id, clinicId),
  });

  if (!isSameClinicDate(appointment.startTime, new Date(), clinic?.timezone ?? "Africa/Algiers")) {
    return { error: "Le patient ne peut être marqué arrivé que le jour du rendez-vous" };
  }

  const existing = await db.query.waitingRoomEntries.findFirst({
    where: and(
      eq(waitingRoomEntries.patientId, patientId),
      eq(waitingRoomEntries.clinicId, clinicId),
      inArray(waitingRoomEntries.status, ["waiting", "called", "in_treatment"]),
    ),
  });

  if (existing) return { error: "Ce patient est déjà en salle d'attente" };

  try {
    const [created] = await db.insert(waitingRoomEntries).values({
      clinicId,
      appointmentId,
      patientId,
      status: "waiting",
      arrivedAt: new Date(),
    }).returning({ id: waitingRoomEntries.id });

    if (created) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "waiting_room_entry",
        entityId: created.id,
        after: { patientId, appointmentId, status: "waiting" },
      });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : "";
    if (code === "23505" || message.includes("uq_waiting_room_active_patient_clinic")) {
      return { error: "Ce patient est déjà en salle d'attente" };
    }
    return { error: "Une erreur est survenue lors de l'ajout à la salle d'attente" };
  }

  await db.update(appointments)
    .set({ status: "confirmed" })
    .where(eq(appointments.id, appointmentId));

  revalidatePath("/waiting-room");
  revalidatePath("/appointments");
}

/**
 * SA-1: Add a walk-in patient directly to the waiting room without an
 * appointment. `appointmentId` stays null.
 */
export async function addWalkInToWaitingRoom(
  patientId: string,
): Promise<{ error?: string; success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // `patientId` est un argument client : le patient doit exister, appartenir à
  // la clinique courante et ne pas être archivé — AVANT la vérification
  // d'unicité et l'insert.
  try {
    await requireOwnedPatient(clinicId, patientId);
  } catch (e) {
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: "Patient introuvable ou archivé" };
    }
    return { error: "Une erreur est survenue lors de l'ajout à la salle d'attente" };
  }

  const existing = await db.query.waitingRoomEntries.findFirst({
    where: and(
      eq(waitingRoomEntries.patientId, patientId),
      eq(waitingRoomEntries.clinicId, clinicId),
      inArray(waitingRoomEntries.status, ["waiting", "called", "in_treatment"]),
    ),
  });

  if (existing) return { error: "Ce patient est déjà en salle d'attente" };

  try {
    const [created] = await db.insert(waitingRoomEntries).values({
      clinicId,
      appointmentId: null,
      patientId,
      status: "waiting",
      arrivedAt: new Date(),
    }).returning({ id: waitingRoomEntries.id });

    if (created) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "waiting_room_entry",
        entityId: created.id,
        after: { patientId, appointmentId: null, status: "waiting" },
      });
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : "";
    if (code === "23505" || message.includes("uq_waiting_room_active_patient_clinic")) {
      return { error: "Ce patient est déjà en salle d'attente" };
    }
    return { error: "Une erreur est survenue lors de l'ajout à la salle d'attente" };
  }

  revalidatePath("/waiting-room");
  return { success: true };
}

export async function updateWaitingStatus(entryId: string, status: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();

  const validStatuses = ["waiting", "called", "in_treatment", "completed", "no_show"] as const;
  if (!validStatuses.includes(status as typeof validStatuses[number])) {
    return { error: "Statut invalide" };
  }

  const updateData: { status: typeof validStatuses[number]; calledAt?: Date } = { status: status as typeof validStatuses[number] };
  if (status === "called") updateData.calledAt = new Date();

  const [entry] = await db
    .select({ id: waitingRoomEntries.id, status: waitingRoomEntries.status })
    .from(waitingRoomEntries)
    .where(and(eq(waitingRoomEntries.id, entryId), eq(waitingRoomEntries.clinicId, clinicId)))
    .limit(1);

  await db
    .update(waitingRoomEntries)
    .set(updateData)
    .where(and(eq(waitingRoomEntries.id, entryId), eq(waitingRoomEntries.clinicId, clinicId)));

  if (entry) {
    await logAction({
      clinicId,
      action: "status_change",
      entityType: "waiting_room_entry",
      entityId: entryId,
      before: { status: entry.status },
      after: { status: updateData.status },
    });
  }

  revalidatePath("/waiting-room");
}

export async function getWaitingRoom() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const entries = await db
      .select({
        entry: waitingRoomEntries,
        patient: patients,
      })
      .from(waitingRoomEntries)
      .innerJoin(patients, eq(waitingRoomEntries.patientId, patients.id))
      .where(
        and(
          eq(waitingRoomEntries.clinicId, clinicId),
          eq(waitingRoomEntries.status, "waiting"),
        )
      )
      .orderBy(asc(waitingRoomEntries.arrivedAt));

    return entries;
  } catch {
    return [];
  }
}
