"use server";

import { db } from "@/lib/db/db";
import { drugCatalog } from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow, hasAbility } from "@/lib/auth-utils";
import { eq, and, ilike, desc } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import * as XLSX from "xlsx";

/**
 * Ability guarding every mutation of the drug catalog (create / update /
 * delete / toggle / Excel import). There is no dedicated `catalog:manage`
 * ability yet (permissions.ts is read-only for this task): `prescriptions:manage`
 * is the closest match — the catalog is the prescribing vocabulary (dosage,
 * form, frequency, instructions) and is granted to owner / dentist, never to
 * `viewer` or `receptionist`.
 *
 * ⚠️ Comportement modifié : l'`assistant` ne détiens QUE `prescriptions:view`
 * (permissions.ts), il perd donc l'accès en ÉCRITURE au catalogue qu'il avait
 * jusqu'ici (aucune ability n'était vérifiée). À arbitrer : une ability
 * `catalogs:manage` dédiée permettrait de décider explicitement si l'assistant
 * doit pouvoir maintenir ce référentiel.
 */
const CATALOG_MANAGE_ABILITY = "prescriptions:manage";
const ACCESS_DENIED_MESSAGE = `Accès refusé : capacité « ${CATALOG_MANAGE_ABILITY} » requise`;

/**
 * Échappe les métacaractères d'un pattern LIKE/ILIKE (`%`, `_`, et le
 * caractère d'échappement lui-même) pour que la saisie utilisateur soit
 * recherchée littéralement (`q=%` ne doit pas balayer tout le catalogue).
 *
 * PostgreSQL utilise `\` comme caractère d'échappement par défaut de LIKE,
 * aucune clause `ESCAPE` n'est donc nécessaire (même convention que le helper
 * `escapeLike` de `src/lib/actions/patient.ts`, qui n'est pas exporté —
 * copie locale assumée car ce fichier est un module `use server` dont seules
 * les fonctions async peuvent être exportées).
 */
function escapeLike(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function searchDrugs(query: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  if (!query || query.trim().length === 0) return [];

  try {
    return await db
      .select({
        id: drugCatalog.id,
        name: drugCatalog.name,
        dosage: drugCatalog.dosage,
        form: drugCatalog.form,
        category: drugCatalog.category,
        frequency: drugCatalog.frequency,
        instructions: drugCatalog.instructions,
      })
      .from(drugCatalog)
      .where(
        and(
          eq(drugCatalog.clinicId, clinicId),
          eq(drugCatalog.isActive, true),
          ilike(drugCatalog.name, `%${escapeLike(query.trim())}%`),
        )
      )
      .orderBy(desc(drugCatalog.name))
      .limit(20);
  } catch {
    return [];
  }
}

export async function getDrugCatalog() {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db.query.drugCatalog.findMany({
      where: eq(drugCatalog.clinicId, clinicId),
      orderBy: (dc, { asc }) => [asc(dc.name)],
    });
  } catch {
    return [];
  }
}

const drugItemSchema = z.object({
  name: z.string().min(1, "Nom du médicament requis"),
  dosage: z.string().optional().or(z.literal("")),
  form: z.string().optional().or(z.literal("")),
  category: z.string().optional().or(z.literal("")),
  frequency: z.string().optional().or(z.literal("")),
  instructions: z.string().optional().or(z.literal("")),
  isActive: z.coerce.boolean().optional().default(true),
});

export async function createDrug(
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  if (!(await hasAbility(clinicId, CATALOG_MANAGE_ABILITY))) {
    return { success: false, error: { general: [ACCESS_DENIED_MESSAGE] } };
  }

  const validated = drugItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [created] = await db
      .insert(drugCatalog)
      .values({
        clinicId,
        name: data.name,
        dosage: data.dosage || null,
        form: data.form || null,
        category: data.category || null,
        frequency: data.frequency || null,
        instructions: data.instructions || null,
        isActive: data.isActive,
      })
      .returning({ id: drugCatalog.id });

    if (created) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "drug_catalog_item",
        entityId: created.id,
        after: { name: data.name, dosage: data.dosage || null, form: data.form || null },
      });
    }

    revalidatePath("/settings/catalogues/medication");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la création du médicament"] } };
  }
}

export async function updateDrug(
  id: string,
  prevState: { success?: boolean; error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  if (!(await hasAbility(clinicId, CATALOG_MANAGE_ABILITY))) {
    return { success: false, error: { general: [ACCESS_DENIED_MESSAGE] } };
  }

  const existing = await db.query.drugCatalog.findFirst({
    where: and(eq(drugCatalog.id, id), eq(drugCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: { general: ["Médicament introuvable"] } };
  }

  const validated = drugItemSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { success: false, error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    await db
      .update(drugCatalog)
      .set({
        name: data.name,
        dosage: data.dosage || null,
        form: data.form || null,
        category: data.category || null,
        frequency: data.frequency || null,
        instructions: data.instructions || null,
        isActive: data.isActive,
      })
      .where(eq(drugCatalog.id, id));

    await logAction({
      clinicId,
      action: "update",
      entityType: "drug_catalog_item",
      entityId: id,
      before: { name: existing.name, dosage: existing.dosage, form: existing.form },
      after: { name: data.name, dosage: data.dosage || null, form: data.form || null },
    });

    revalidatePath("/settings/catalogues/medication");
    return { success: true };
  } catch {
    return { success: false, error: { general: ["Erreur lors de la mise à jour du médicament"] } };
  }
}

export async function deleteDrug(id: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  if (!(await hasAbility(clinicId, CATALOG_MANAGE_ABILITY))) {
    return { success: false, error: ACCESS_DENIED_MESSAGE };
  }

  const existing = await db.query.drugCatalog.findFirst({
    where: and(eq(drugCatalog.id, id), eq(drugCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: "Médicament introuvable" };
  }

  try {
    await db.delete(drugCatalog).where(eq(drugCatalog.id, id));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "drug_catalog_item",
      entityId: id,
      before: { name: existing.name, dosage: existing.dosage, form: existing.form },
    });

    revalidatePath("/settings/catalogues/medication");
    return { success: true };
  } catch {
    return { success: false, error: "Erreur lors de la suppression du médicament" };
  }
}

export async function toggleDrugActive(id: string, isActive: boolean) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  if (!(await hasAbility(clinicId, CATALOG_MANAGE_ABILITY))) {
    return { success: false, error: ACCESS_DENIED_MESSAGE };
  }

  const existing = await db.query.drugCatalog.findFirst({
    where: and(eq(drugCatalog.id, id), eq(drugCatalog.clinicId, clinicId)),
  });

  if (!existing) {
    return { success: false, error: "Médicament introuvable" };
  }

  try {
    await db.update(drugCatalog).set({ isActive }).where(eq(drugCatalog.id, id));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "drug_catalog_item",
      entityId: id,
      before: { isActive: existing.isActive },
      after: { isActive },
    });

    revalidatePath("/settings/catalogues/medication");
    return { success: true };
  } catch {
    return { success: false, error: "Erreur lors de la mise à jour du statut" };
  }
}

export async function uploadDrugCatalogExcel(
  _prevState: { success?: boolean; imported?: number; errors?: string[] } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);
  if (!(await hasAbility(clinicId, CATALOG_MANAGE_ABILITY))) {
    return { success: false, errors: [ACCESS_DENIED_MESSAGE] };
  }

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { success: false, errors: ["Fichier requis"] };
  }

  if (!file.name.endsWith(".xlsx")) {
    return { success: false, errors: ["Seuls les fichiers .xlsx sont acceptés"] };
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return { success: false, errors: ["Le fichier Excel est vide"] };
    }

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]);

    if (rows.length === 0) {
      return { success: false, errors: ["Aucune donnée trouvée dans le fichier"] };
    }

    const errors: string[] = [];
    let imported = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row["Nom"] ?? row["nom"] ?? row["NAME"] ?? "").trim();

      if (!name) {
        errors.push(`Ligne ${i + 2}: nom manquant, ligne ignorée`);
        continue;
      }

      const dosage = String(row["Dosage"] ?? row["dosage"] ?? "").trim() || null;
      const form = String(row["Forme"] ?? row["forme"] ?? "").trim() || null;
      const category = String(row["Catégorie"] ?? row["catégorie"] ?? row["category"] ?? "").trim() || null;
      const frequency = String(row["Fréquence"] ?? row["fréquence"] ?? row["frequency"] ?? "").trim() || null;
      const instructions = String(row["Instructions"] ?? row["instructions"] ?? "").trim() || null;

      try {
        await db
          .insert(drugCatalog)
          .values({
            clinicId,
            name,
            dosage,
            form,
            category,
            frequency,
            instructions,
          })
          .onConflictDoUpdate({
            target: [drugCatalog.clinicId, drugCatalog.name],
            set: { dosage, form, category, frequency, instructions },
          });

        imported++;
      } catch {
        errors.push(`Ligne ${i + 2}: erreur lors de l'import de "${name}"`);
      }
    }

    if (imported > 0) {
      revalidatePath("/settings/catalogues/medication");
    }

    if (errors.length > 0) {
      return { success: imported > 0, imported, errors };
    }

    return { success: true, imported, errors: [] };
  } catch {
    return { success: false, errors: ["Erreur lors de la lecture du fichier Excel"] };
  }
}
