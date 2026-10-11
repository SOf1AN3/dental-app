"use server";

import { db } from "@/lib/db/db";
import { prescriptions, prescriptionItems, patients, users, clinicalSessions } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { requireOwnedPatient } from "@/lib/guards";
import { eq, and, desc, asc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

export async function getPrescriptions(patientId?: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const conditions = [eq(prescriptions.clinicId, clinicId)];
  if (patientId) {
    conditions.push(eq(prescriptions.patientId, patientId));
  }

  try {
    const rows = await db
      .select({
        prescription: prescriptions,
        patient: patients,
        dentistName: users.name,
      })
      .from(prescriptions)
      .innerJoin(patients, eq(prescriptions.patientId, patients.id))
      .leftJoin(users, eq(prescriptions.dentistId, users.id))
      // Filtre multi-tenant sur la table jointe : sans `eq(patients.clinicId, …)`,
      // la jointure exposerait la ligne patient complète d'une autre clinique.
      .where(and(...conditions, eq(patients.clinicId, clinicId)))
      .orderBy(desc(prescriptions.date));

    return rows.map((r) => ({
      ...r.prescription,
      patient: r.patient,
      dentistName: r.dentistName,
    }));
  } catch {
    return [];
  }
}

export async function getPrescription(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [row] = await db
      .select({
        prescription: prescriptions,
        patient: patients,
        dentistName: users.name,
      })
      .from(prescriptions)
      .innerJoin(patients, eq(prescriptions.patientId, patients.id))
      .leftJoin(users, eq(prescriptions.dentistId, users.id))
      // Filtre multi-tenant sur la table jointe : sans `eq(patients.clinicId, …)`,
      // la jointure exposerait la ligne patient complète d'une autre clinique.
      .where(
        and(
          eq(prescriptions.id, id),
          eq(prescriptions.clinicId, clinicId),
          eq(patients.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!row) return null;

    const items = await db
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id))
      .orderBy(asc(prescriptionItems.name));

    return {
      ...row.prescription,
      patient: row.patient,
      dentistName: row.dentistName,
      items,
    };
  } catch {
    return null;
  }
}

const prescriptionItemSchema = z.object({
  type: z.enum(["medication", "care"]),
  name: z.string().min(1),
  dosage: z.string().optional().or(z.literal("")),
  form: z.string().optional().or(z.literal("")),
  frequency: z.string().optional().or(z.literal("")),
  duration: z.string().optional().or(z.literal("")),
  quantity: z.coerce.number().int().positive().optional().nullable(),
  instructions: z.string().optional().or(z.literal("")),
});

const prescriptionSchema = z.object({
  patientId: z.string().min(1, "Patient requis"),
  notes: z.string().optional().or(z.literal("")),
  items: z.array(prescriptionItemSchema).optional().default([]),
});

type PrescriptionItem = z.infer<typeof prescriptionItemSchema>;

/**
 * Extrait le champ `items` (JSON sérialisé par l'éditeur).
 *
 * Lève une exception si le JSON est malformé : `updatePrescription` supprime
 * puis réinsère les items dans une transaction — un parse qui retournerait
 * `[]` effacerait silencieusement tous les médicaments de l'ordonnance.
 */
function parseItems(formData: FormData): unknown {
  const itemsRaw = formData.get("items");
  const items = itemsRaw === null ? "" : String(itemsRaw);
  if (!items) return [];
  return JSON.parse(items);
}

/** Message remonté au formulaire si le champ `items` n'est pas un JSON lisible. */
const INVALID_ITEMS_MESSAGE =
  "Liste des articles illisible — modification non appliquée";

function normalizeItems(items: PrescriptionItem[]) {
  return items
    .filter((item) => item.name.trim().length > 0)
    .map((item) => ({
      type: item.type,
      name: item.name,
      dosage: item.dosage || null,
      form: item.form || null,
      frequency: item.frequency || null,
      duration: item.duration || null,
      quantity: item.quantity ? Number(item.quantity) : null,
      instructions: item.instructions || null,
    }));
}

export async function createPrescription(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Le champ `items` est un JSON sérialisé côté client : un JSON malformé doit
  // remonter une erreur, jamais être assimilé à une liste vide (cela effacerait
  // les médicaments existants dans `updatePrescription`).
  let itemsJson: unknown;
  try {
    itemsJson = parseItems(formData);
  } catch {
    return { error: { general: [INVALID_ITEMS_MESSAGE] } };
  }

  const validated = prescriptionSchema.safeParse({
    ...Object.fromEntries(formData),
    items: itemsJson,
  });
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const items = normalizeItems(data.items);
  const sessionId = formData.get("sessionId") as string | null;

  try {
    // Garde d'appartenance : `patientId` provient du client. Lève
    // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
    // appartient à une autre clinique ou est archivé. Placé AVANT toute écriture.
    await requireOwnedPatient(clinicId, data.patientId);

    if (sessionId) {
      const session = await db.query.clinicalSessions.findFirst({
        where: and(
          eq(clinicalSessions.id, sessionId),
          eq(clinicalSessions.clinicId, clinicId),
        ),
      });

      if (!session) {
        return { error: { general: ["Séance introuvable"] } };
      }
    }

    let createdId: string | undefined;

    await db.transaction(async (tx) => {
      const [prescription] = await tx
        .insert(prescriptions)
        .values({
          clinicId,
          patientId: data.patientId,
          dentistId: user.id,
          sessionId: sessionId || null,
          notes: data.notes || null,
        })
        .returning({ id: prescriptions.id });

      createdId = prescription?.id;

      if (prescription && items.length > 0) {
        await tx.insert(prescriptionItems).values(
          items.map((item) => ({
            prescriptionId: prescription.id,
            ...item,
          })),
        );
      }
    });

    if (createdId) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "prescription",
        entityId: createdId,
        after: {
          patientId: data.patientId,
          dentistId: user.id,
          notes: data.notes || null,
          itemCount: items.length,
        },
      });
    }

    if (sessionId) {
      revalidatePath(`/patients/${data.patientId}/session/${sessionId}`);
      redirect(`/patients/${data.patientId}/session/${sessionId}`);
    } else {
      revalidatePath("/prescriptions");
      redirect("/prescriptions");
    }
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique, inexistant ou archivé) :
    // remontée telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la création de l'ordonnance"] } };
  }
}

export async function updatePrescription(
  id: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Même garde que `createPrescription` : un JSON malformé empêche la
  // transaction (qui supprime puis réinsère les items) de s'exécuter.
  let itemsJson: unknown;
  try {
    itemsJson = parseItems(formData);
  } catch {
    return { error: { general: [INVALID_ITEMS_MESSAGE] } };
  }

  const validated = prescriptionSchema.safeParse({
    ...Object.fromEntries(formData),
    items: itemsJson,
  });
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const items = normalizeItems(data.items);

  try {
    const [existing] = await db
      .select({
        patientId: prescriptions.patientId,
        notes: prescriptions.notes,
        sessionId: prescriptions.sessionId,
      })
      .from(prescriptions)
      .where(and(eq(prescriptions.id, id), eq(prescriptions.clinicId, clinicId)))
      .limit(1);

    if (!existing) {
      return { error: { general: ["Ordonnance introuvable"] } };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(prescriptions)
        .set({ notes: data.notes || null })
        .where(eq(prescriptions.id, id));

      await tx
        .delete(prescriptionItems)
        .where(eq(prescriptionItems.prescriptionId, id));

      if (items.length > 0) {
        await tx.insert(prescriptionItems).values(
          items.map((item) => ({
            prescriptionId: id,
            ...item,
          })),
        );
      }
    });

    await logAction({
      clinicId,
      action: "update",
      entityType: "prescription",
      entityId: id,
      before: { notes: existing.notes ?? null },
      after: { notes: data.notes || null },
    });

    revalidatePath(`/prescriptions/${id}`);
    revalidatePath("/prescriptions");
    revalidatePath(`/patients/${existing.patientId}/prescriptions`);
    revalidatePath(`/patients/${existing.patientId}`);
    if (existing.sessionId) {
      revalidatePath(`/patients/${existing.patientId}/session/${existing.sessionId}`);
    }
    return { success: true };
  } catch {
    return { error: { general: ["Erreur lors de la mise à jour de l'ordonnance"] } };
  }
}

export async function updatePrescriptionStatus(
  id: string,
  status: "active" | "completed" | "cancelled",
  _formData: FormData,
): Promise<void> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [prescription] = await db
      .select({ patientId: prescriptions.patientId, status: prescriptions.status })
      .from(prescriptions)
      .where(and(eq(prescriptions.id, id), eq(prescriptions.clinicId, clinicId)))
      .limit(1);

    if (!prescription) {
      return;
    }

    await db
      .update(prescriptions)
      .set({ status })
      .where(and(eq(prescriptions.id, id), eq(prescriptions.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "prescription",
      entityId: id,
      before: { status: prescription.status },
      after: { status },
    });

    revalidatePath(`/prescriptions/${id}`);
    revalidatePath("/prescriptions");
    revalidatePath(`/patients/${prescription.patientId}/prescriptions`);
    revalidatePath(`/patients/${prescription.patientId}`);
  } catch {
    return;
  }
}
