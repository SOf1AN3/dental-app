"use server";

import { db } from "@/lib/db/db";
import { clinics, patients } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { eq, and, asc, ilike, or, count, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getActivePlanLimits } from "./subscription";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";
import { requireOwnedPatient, requirePatientOwnership } from "@/lib/guards";

/** Escape special characters for SQL LIKE patterns to prevent injection. */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Valide une date au format ISO `YYYY-MM-DD` (format émis par les champs
 * `<input type="date">`) : le calendrier doit réellement exister
 * (`2024-02-31` → `Invalid Date` → refusé) et la date ne peut pas être future.
 *
 * `new Date("abc")` ou une date hors calendrier produisent `NaN` : refusés
 * ici, avant toute écriture, pour éviter qu'un `Invalid Date` n'explose le
 * driver au commit avec un message générique ne désignant pas le champ fautif.
 */
function isValidDateOfBirth(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  // `new Date("YYYY-MM-DD")` est interprété en UTC minuit : une date du jour
  // reste donc acceptée, une date de demain est rejetée.
  return parsed.getTime() <= Date.now();
}

const patientSchema = z.object({
  firstName: z.string().min(1, "Prénom requis"),
  lastName: z.string().min(1, "Nom requis"),
  dateOfBirth: z
    .string()
    .optional()
    .default("")
    .refine(
      (value) => value === "" || isValidDateOfBirth(value),
      "Date de naissance invalide ou dans le futur",
    ),
  gender: z.string().optional().default("").catch(""),
  phone: z.string().optional().default("").catch(""),
  // Pas de `.catch("")` : un email invalide doit remonter une erreur au champ
  // `email` — l'effacer silencieusement ferait perdre une coordonnée au
  // patient sans le prévenir.
  email: z
    .string()
    .optional()
    .default("")
    .refine(
      (value) => value === "" || z.string().email().safeParse(value).success,
      "Email invalide",
    ),
  address: z.string().optional().default("").catch(""),
  wilayaCode: z.string().optional().default("").catch(""),
  emergencyContact: z.string().optional().default("").catch(""),
  emergencyPhone: z.string().optional().default("").catch(""),
  insuranceProvider: z.string().optional().default("").catch(""),
  insuranceNumber: z.string().optional().default("").catch(""),
  notes: z.string().optional().default("").catch(""),
});

export async function createPatient(
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = patientSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  let createdId: string;

  try {
    const { maxPatients } = await getActivePlanLimits();

    // Z-73 — quota ATOMIQUE (contre le TOCTOU « count() puis insert() ») :
    // deux créations simultanées lisaient le même compte et passaient toutes
    // deux la barre du plan. Le comptage ET l'insertion sont désormais dans
    // UNE transaction verrouillée par `SELECT … FOR UPDATE` sur la ligne
    // `clinics` : en READ COMMITTED, la seconde transaction attend le commit
    // de la première, puis recompte (N + 1) et se voit refuser si le quota est
    // atteint. Le verrou porte sur la clinique (une seule ligne) : il n'y a
    // donc pas de contention inter-cliniques et AUCUNE modification de schéma
    // (pas de colonne, pas d'index, pas de migration).
    const created = await db.transaction(
      async (tx): Promise<{ id: string } | { quotaReached: true }> => {
        // Verrou-mutex par clinique : lecture exclusive, aucune écriture.
        await tx
          .select({ id: clinics.id })
          .from(clinics)
          .where(eq(clinics.id, clinicId))
          .for("update");

        const [countResult] = await tx
          .select({ count: count() })
          .from(patients)
          .where(and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt)));

        const patientCount = countResult?.count ?? 0;

        if (maxPatients != null && patientCount >= maxPatients) {
          return { quotaReached: true };
        }

        const [inserted] = await tx.insert(patients).values({
          clinicId,
          firstName: data.firstName,
          lastName: data.lastName,
          dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
          gender: data.gender || null,
          phone: data.phone || null,
          email: data.email || null,
          address: data.address || null,
          wilayaCode: data.wilayaCode || null,
          emergencyContact: data.emergencyContact || null,
          emergencyPhone: data.emergencyPhone || null,
          insuranceProvider: data.insuranceProvider || null,
          insuranceNumber: data.insuranceNumber || null,
          notes: data.notes || null,
        }).returning({ id: patients.id });

        return { id: inserted.id };
      },
    );

    if ("quotaReached" in created) {
      return {
        error: {
          general: ["Limite de patients atteinte pour votre formule. Passez à un plan supérieur."],
        },
        paywall: true,
      };
    }

    createdId = created.id;
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création du patient"] } };
  }

  // Audit placé APRÈS le `try` d'écriture : le patient existe désormais. Si
  // l'échec d'audit était dans le même `catch`, l'utilisateur verrait
  // « Erreur lors de la création » et relancerait → patient en double (aucune
  // contrainte d'unicité ne le rattraperait). `logAction` avale déjà ses
  // erreurs ; ce `try/catch` est un filet au cas où il en lèverait une.
  try {
    await logAction({
      clinicId,
      action: "create",
      entityType: "patient",
      entityId: createdId,
      after: { ...data },
    });
  } catch (auditError) {
    console.error("Échec de l'audit de création du patient", auditError);
  }

  revalidatePath("/patients");
  redirect("/patients");
}

export async function deletePatient(
  patientId: string,
): Promise<{ success: boolean } | { error: string }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // Garde d'appartenance (sans filtre archivage : archiver un patient déjà
    // archivé reste légitime). Lève `Error("Patient introuvable")` si le patient
    // n'existe pas ou appartient à une autre clinique.
    await requirePatientOwnership(clinicId, patientId);

    const [patient] = await db
      .select({
        firstName: patients.firstName,
        lastName: patients.lastName,
        phone: patients.phone,
        email: patients.email,
        deletedAt: patients.deletedAt,
      })
      .from(patients)
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
      .limit(1);

    const deletedRows = await db
      .update(patients)
      .set({ deletedAt: new Date() })
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
      .returning({ id: patients.id });

    // Z-73 (bonus) — compter les lignes affectées : 0 ligne signifie que le
    // patient a disparu entre le garde d'appartenance et l'écriture (course) :
    // annoncer « succès » et journaliser un archivage qui n'a pas eu lieu
    // laisserait un faux état. Même message que `requirePatientOwnership`
    // (pas d'oracle d'énumération).
    if (deletedRows.length === 0) {
      return { error: "Patient introuvable" };
    }

    await logAction({
      clinicId,
      action: "delete",
      entityType: "patient",
      entityId: patientId,
      before: {
        firstName: patient?.firstName ?? null,
        lastName: patient?.lastName ?? null,
        phone: patient?.phone ?? null,
        email: patient?.email ?? null,
        deletedAt: patient?.deletedAt ?? null,
      },
      after: { deletedAt: new Date().toISOString() },
    });

    revalidatePath("/patients");
    revalidatePath(`/patients/${patientId}`);
    return { success: true };
  } catch (e) {
    // Erreur d'accès (patient d'une autre clinique ou inexistant) : remontée
    // telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable") {
      return { error: e.message };
    }
    return { error: "Erreur lors de l'archivage du patient" };
  }
}

export async function restorePatient(
  patientId: string,
): Promise<{ success: boolean } | { error: string }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // Garde d'appartenance (sans filtre archivage : restaurer un patient archivé
    // est le cas d'usage légitime de cette action). Lève `Error("Patient introuvable")`
    // si le patient n'existe pas ou appartient à une autre clinique.
    await requirePatientOwnership(clinicId, patientId);

    // Z-46 : la restauration réactivait un patient SANS revérifier le quota,
    // alors que `createPatient` le fait : à la limite de son plan, un cabinet
    // pouvait contourner la paywall par un archivage puis une restauration.
    // Même vérification qu'à la création, en comptant le patient restauré. Un
    // patient déjà actif (restauration sans effet) n'est PAS bloqué.
    const { maxPatients } = await getActivePlanLimits();

    // Z-73 (extension de Z-46) : comptage + écriture sont le MÊME TOCTOU que
    // `createPatient` (deux restaurations simultanées passaient toutes deux la
    // barre). Transaction + verrou `FOR UPDATE` sur la ligne `clinics` : la
    // seconde attend le commit de la première puis recompte. La relecture de
    // `deletedAt` DANS la transaction sert aussi de seconde garde d'appartenance
    // (le `UPDATE … RETURNING` compte ses lignes : 0 ligne = course).
    const outcome = await db.transaction(
      async (tx): Promise<
        { error: string } | { restored: true; beforeDeletedAt: Date | null }
      > => {
        await tx
          .select({ id: clinics.id })
          .from(clinics)
          .where(eq(clinics.id, clinicId))
          .for("update");

        const [patient] = await tx
          .select({ deletedAt: patients.deletedAt })
          .from(patients)
          .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
          .limit(1);

        if (!patient) return { error: "Patient introuvable" };

        const [countResult] = await tx
          .select({ count: count() })
          .from(patients)
          .where(and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt)));

        const activeCount = countResult?.count ?? 0;
        const projectedCount = patient.deletedAt ? activeCount + 1 : activeCount;

        if (maxPatients != null && projectedCount > maxPatients) {
          return {
            error:
              "Limite de patients atteinte pour votre formule. Passez à un plan supérieur.",
          };
        }

        const restoredRows = await tx
          .update(patients)
          .set({ deletedAt: null })
          .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
          .returning({ id: patients.id });

        if (restoredRows.length === 0) return { error: "Patient introuvable" };

        return { restored: true, beforeDeletedAt: patient.deletedAt };
      },
    );

    if ("error" in outcome) {
      return { error: outcome.error };
    }

    await logAction({
      clinicId,
      action: "update",
      entityType: "patient",
      entityId: patientId,
      before: { deletedAt: outcome.beforeDeletedAt },
      after: { deletedAt: null },
    });

    revalidatePath("/patients");
    revalidatePath(`/patients/${patientId}`);
    return { success: true };
  } catch (e) {
    // Erreur d'accès (patient d'une autre clinique ou inexistant) : remontée
    // telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable") {
      return { error: e.message };
    }
    return { error: "Erreur lors de la restauration du patient" };
  }
}

export async function updatePatient(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = patientSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const patient = await requireOwnedPatient(clinicId, patientId);

    const updatedRows = await db
      .update(patients)
      .set({
        firstName: data.firstName,
        lastName: data.lastName,
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
        gender: data.gender || null,
        phone: data.phone || null,
        email: data.email || null,
        address: data.address || null,
        wilayaCode: data.wilayaCode || null,
        emergencyContact: data.emergencyContact || null,
        emergencyPhone: data.emergencyPhone || null,
        insuranceProvider: data.insuranceProvider || null,
        insuranceNumber: data.insuranceNumber || null,
        notes: data.notes || null,
      })
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
      .returning({ id: patients.id });

    // Z-73 (bonus) — 0 ligne affectée : le patient a disparu entre le garde
    // `requireOwnedPatient` et l'écriture (course) → ne PAS annoncer un
    // succès. Même message que le garde (cohérence du `catch` ci-dessous).
    if (updatedRows.length === 0) {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }

    await logAction({
      clinicId,
      action: "update",
      entityType: "patient",
      entityId: patientId,
      before: {
        firstName: patient.firstName,
        lastName: patient.lastName,
        phone: patient.phone ?? null,
        email: patient.email ?? null,
      },
      after: { ...data },
    });

    revalidatePath("/patients");
    revalidatePath(`/patients/${patientId}`);
    redirect("/patients");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { general: ["Patient introuvable ou archivé"] } };
    }
    return { error: { general: ["Erreur lors de la mise à jour du patient"] } };
  }
}

export async function searchPatients(query: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const results = await db
      .select()
      .from(patients)
      .where(
        and(
          eq(patients.clinicId, clinicId),
          isNull(patients.deletedAt),
          or(
            ilike(patients.firstName, `%${escapeLike(query)}%`),
            ilike(patients.lastName, `%${escapeLike(query)}%`),
            ilike(patients.phone, `%${escapeLike(query)}%`),
            ilike(patients.email, `%${escapeLike(query)}%`),
          ),
        ),
      )
      .orderBy(asc(patients.lastName));

    return results;
  } catch {
    return [];
  }
}

export async function getPatients(page = 1, pageSize = 20) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  const offset = (page - 1) * pageSize;

  try {
    return await db
      .select()
      .from(patients)
      .where(and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt)))
      .orderBy(asc(patients.lastName), asc(patients.firstName))
      .limit(pageSize)
      .offset(offset);
  } catch {
    return [];
  }
}

export async function getPatientsCount() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [result] = await db
      .select({ count: count() })
      .from(patients)
      .where(and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt)));

    return result?.count ?? 0;
  } catch {
    return 0;
  }
}
