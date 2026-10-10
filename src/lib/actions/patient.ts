"use server";

import { db } from "@/lib/db/db";
import { patients } from "@/lib/db/schema";
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

const patientSchema = z.object({
  firstName: z.string().min(1, "Prénom requis"),
  lastName: z.string().min(1, "Nom requis"),
  dateOfBirth: z.string().optional().default("").catch(""),
  gender: z.string().optional().default("").catch(""),
  phone: z.string().optional().default("").catch(""),
  email: z.string().email("Email invalide").optional().default("").catch(""),
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

  try {
    const { maxPatients } = await getActivePlanLimits();

    const [countResult] = await db
      .select({ count: count() })
      .from(patients)
      .where(and(eq(patients.clinicId, clinicId), isNull(patients.deletedAt)));

    const patientCount = countResult?.count ?? 0;

    if (maxPatients != null && patientCount >= maxPatients) {
      return {
        error: {
          general: ["Limite de patients atteinte pour votre formule. Passez à un plan supérieur."],
        },
        paywall: true,
      };
    }

    const [created] = await db.insert(patients).values({
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

    await logAction({
      clinicId,
      action: "create",
      entityType: "patient",
      entityId: created.id,
      after: { ...data },
    });

    revalidatePath("/patients");
    redirect("/patients");
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    return { error: { general: ["Erreur lors de la création du patient"] } };
  }
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

    await db
      .update(patients)
      .set({ deletedAt: new Date() })
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)));

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

    const [patient] = await db
      .select({ deletedAt: patients.deletedAt })
      .from(patients)
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)))
      .limit(1);

    await db
      .update(patients)
      .set({ deletedAt: null })
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "update",
      entityType: "patient",
      entityId: patientId,
      before: { deletedAt: patient?.deletedAt ?? null },
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

    await db
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
      .where(and(eq(patients.id, patientId), eq(patients.clinicId, clinicId)));

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
