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

/**
 * Domaine RUNTIME des statuts de file (`waiting_room_status`) + machine à états
 * de `updateWaitingStatus` (Z-57). Même structure que `allowedTransitions` de
 * `appointment.ts` : les états terminaux (`completed`, `no_show`) sont absorbants
 * — réactiver un champ devenu terminal violerait l'unicité partielle
 * `uq_waiting_room_active_patient_clinic` (deux entrées actives pour le même
 * patient).
 */
const WAITING_ROOM_STATUSES = [
  "waiting",
  "called",
  "in_treatment",
  "completed",
  "no_show",
] as const;
type WaitingRoomStatus = (typeof WAITING_ROOM_STATUSES)[number];

const waitingRoomTransitions: Record<WaitingRoomStatus, WaitingRoomStatus[]> = {
  waiting: ["called", "in_treatment", "completed", "no_show"],
  called: ["waiting", "in_treatment", "completed", "no_show"],
  in_treatment: ["waiting", "called", "completed", "no_show"],
  completed: [],
  no_show: [],
};

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

  // Z-58 — garde d'état : l'arrivée ne doit JAMAIS écraser un statut terminal
  // (`completed`, `cancelled`, `no_show`) ni faire régresser un RDV
  // `in_progress` vers `confirmed`. Le même test est rejoué dans le `WHERE` du
  // UPDATE (sous transaction) avec `clinicId`, pour fermer la fenêtre de course
  // avec `updateAppointmentStatus`.
  if (appointment.status !== "scheduled" && appointment.status !== "confirmed") {
    return { error: "Ce rendez-vous ne peut plus être marqué présent" };
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
    // Z-55 — INSERT + UPDATE du RDV + audit dans UNE transaction : l'INSERT ne
    // survit plus à un échec de l'UPDATE (l'ancien code exécutait l'UPDATE HORS
    // try/catch : il partait en 500 en laissant une entrée active dont le RDV
    // restait `scheduled`). `logAction` est appelée DANS le callback : si elle se
    // rejette, tout est annulé ; en pratique elle avale ses erreurs
    // (`src/lib/audit.ts`), donc le vrai apport atomique est INSERT ↔ UPDATE.
    await db.transaction(async (tx) => {
      const [created] = await tx.insert(waitingRoomEntries).values({
        clinicId,
        appointmentId,
        patientId,
        status: "waiting",
        arrivedAt: new Date(),
      }).returning({ id: waitingRoomEntries.id });

      // Z-58 — garde d'état + appartenance à la clinique rejouées dans le WHERE
      // (`clinicId` manquait, et tout statut courant était écrasé).
      await tx.update(appointments)
        .set({ status: "confirmed" })
        .where(and(
          eq(appointments.id, appointmentId),
          eq(appointments.clinicId, clinicId),
          inArray(appointments.status, ["scheduled", "confirmed"]),
        ));

      if (created) {
        await logAction({
          clinicId,
          action: "create",
          entityType: "waiting_room_entry",
          entityId: created.id,
          after: { patientId, appointmentId, status: "waiting" },
        });
      }
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : "";
    if (code === "23505" || message.includes("uq_waiting_room_active_patient_clinic")) {
      return { error: "Ce patient est déjà en salle d'attente" };
    }
    return { error: "Une erreur est survenue lors de l'ajout à la salle d'attente" };
  }

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
  // Z-57 — aligné sur les autres actions du fichier : contrôle d'accès
  // clinique, absent ici alors que l'action MUTATE des entrées de file.
  await requireClinicAccessOrThrow(clinicId);

  if (!WAITING_ROOM_STATUSES.includes(status as WaitingRoomStatus)) {
    return { error: "Statut invalide" };
  }
  const nextStatus = status as WaitingRoomStatus;

  // Z-57 — try/catch : une erreur DB (dont une violation de contrainte unique)
  // retombait en 500 au lieu d'une erreur structurée.
  try {
    const [entry] = await db
      .select({ id: waitingRoomEntries.id, status: waitingRoomEntries.status })
      .from(waitingRoomEntries)
      .where(and(eq(waitingRoomEntries.id, entryId), eq(waitingRoomEntries.clinicId, clinicId)))
      .limit(1);

    if (!entry) {
      return { error: "Entrée de salle d'attente introuvable" };
    }

    // Z-57 — machine à états : plus de transition absurde (terminals,
    // régression d'état, no-op vers le statut courant).
    if (!waitingRoomTransitions[entry.status].includes(nextStatus)) {
      return { error: "Transition de statut non autorisée" };
    }

    const updateData: { status: WaitingRoomStatus; calledAt?: Date } = { status: nextStatus };
    if (nextStatus === "called") updateData.calledAt = new Date();

    // La transition est REJOUÉE dans le `WHERE` (statut lu ci-dessus) : si
    // l'entrée a changé entre la lecture et l'écriture, 0 ligne affectée →
    // même refus, sans écraser la transition concurrente.
    const [updated] = await db
      .update(waitingRoomEntries)
      .set(updateData)
      .where(and(
        eq(waitingRoomEntries.id, entryId),
        eq(waitingRoomEntries.clinicId, clinicId),
        eq(waitingRoomEntries.status, entry.status),
      ))
      .returning({ id: waitingRoomEntries.id });

    if (!updated) {
      return { error: "Transition de statut non autorisée" };
    }

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "waiting_room_entry",
      entityId: entryId,
      before: { status: entry.status },
      after: { status: updateData.status },
    });

    revalidatePath("/waiting-room");
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : "";
    if (code === "23505" || message.includes("uq_waiting_room_active_patient_clinic")) {
      return { error: "Ce patient est déjà en salle d'attente" };
    }
    return { error: "Une erreur est survenue lors de la mise à jour du statut" };
  }
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
          // Z-56 — les statuts « actifs » sont exactement ceux de l'unicité
          // `uq_waiting_room_active_patient_clinic` : filtrer sur `waiting` seul
          // faisait disparaître les patients appelés / en soin TOUT en continuant
          // de bloquer tout ré-ajout (« déjà en salle d'attente » pour un
          // patient invisible).
          inArray(waitingRoomEntries.status, ["waiting", "called", "in_treatment"]),
        )
      )
      .orderBy(asc(waitingRoomEntries.arrivedAt));

    return entries;
  } catch (err) {
    // Z-71 — « salle d'attente vide » et « lecture impossible » ne sont plus
    // confondus : l'erreur est journalisée puis REMONTÉE. Le contrat de
    // retour (`…[]`) ne peut pas porter de type d'erreur sans changer de
    // signature — c'est donc le canal d'exception qui fait la distinction,
    // `[]` redevenant le seul signe d'une file réellement vide.
    console.error("[getWaitingRoom] lecture de la salle d'attente impossible", { clinicId, err });
    throw err;
  }
}
