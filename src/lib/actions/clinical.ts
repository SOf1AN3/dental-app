"use server";

import { db } from "@/lib/db/db";
import {
  treatmentPlans,
  treatmentPlanItems,
  consultationNotes,
  radiographs,
  medicalHistoryEntries,
} from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { storage } from "@/lib/storage";
import { extname } from "path";
import { eq, and, asc, desc, sql, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";
import { requireOwnedPatient } from "@/lib/guards";

type DbOrTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Bornes serveur du n° de dent (Z-42), alignées sur l'existant plutôt que sur
 * une norme imposée :
 *  - l'odontogramme (source de vérité clinique de l'app) utilise la
 *    numérotation FDI adulte 11–18 / 21–28 / 31–38 / 41–48 ;
 *  - les formulaires HTML existants bornent à 1–48 (`order-form`,
 *    `session-treatments`) et 1–32 (`radiograph-form`).
 * On retient l'UNION des bornes UI, soit 1–48 : sur-ensemble de la plage FDI
 * adulte, strictement plus permissif que l'UI actuelle → aucun saisi légal du
 * formulaire n'est rejeté, tandis que `-1`, `0` et `999` le sont.
 */
const TOOTH_NUMBER_MIN = 1;
const TOOTH_NUMBER_MAX = 48;

/**
 * Schéma commun d'un n° de dent soumis par un formulaire.
 *
 * `z.coerce.number()` convertit `""` en `0` : sans le prétraitement, un champ
 * dent vide serait rejeté par `min(1)` (radiographies) ou stocké à `0`
 * (plans de traitement). Le prétraitement mappe explicitement la valeur vide
 * sur `undefined` = « pas de dent renseignée ».
 */
const toothNumberFieldSchema = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  z.coerce
    .number()
    .int("Numéro de dent invalide")
    .min(TOOTH_NUMBER_MIN, `Numéro de dent invalide (min ${TOOTH_NUMBER_MIN})`)
    .max(TOOTH_NUMBER_MAX, `Numéro de dent invalide (max ${TOOTH_NUMBER_MAX})`)
    .optional(),
);

export async function getTreatmentPlans(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(treatmentPlans)
      .where(
        and(
          eq(treatmentPlans.patientId, patientId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .orderBy(desc(treatmentPlans.createdAt));
  } catch {
    return [];
  }
}

export async function getTreatmentPlan(planId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [plan] = await db
      .select()
      .from(treatmentPlans)
      .where(
        and(
          eq(treatmentPlans.id, planId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!plan) return null;

    const items = await db
      .select()
      .from(treatmentPlanItems)
      .where(eq(treatmentPlanItems.planId, planId))
      .orderBy(asc(treatmentPlanItems.orderIndex));

    return { ...plan, items };
  } catch {
    return null;
  }
}

/**
 * Recalcule le total d'un plan de traitement à partir de ses actes.
 *
 * NON exporté volontairement : ce module porte `"use server"`, une exportation
 * serait donc invoquable via HTTP sans authentification ni contrôle de clinique
 * (réécriture du montant d'un plan d'un autre cabinet). N'est appelé qu'ici,
 * à l'intérieur d'actions déjà authentifiées et filtrées par `clinicId`.
 */
async function recalculatePlanTotal(
  planId: string,
  tx?: DbOrTx,
): Promise<number> {
  const client = tx ?? db;

  const [row] = await client
    .select({
      total: sql<number>`COALESCE(SUM(${treatmentPlanItems.fee} * ${treatmentPlanItems.quantity} - COALESCE(${treatmentPlanItems.discount}, 0)), 0)::float8`,
    })
    .from(treatmentPlanItems)
    .where(eq(treatmentPlanItems.planId, planId));

  const total = Number(row?.total ?? 0);

  await client
    .update(treatmentPlans)
    .set({ totalAmount: total })
    .where(eq(treatmentPlans.id, planId));

  return total;
}

const treatmentPlanSchema = z.object({
  title: z.string().min(1, "Titre requis"),
  description: z.string().optional().default("").catch(""),
  discount: z.coerce.number().min(0).optional(),
});

export async function createTreatmentPlan(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    // Garde d'appartenance : `patientId` provient du client. Lève
    // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
    // appartient à une autre clinique ou est archivé.
    await requireOwnedPatient(clinicId, patientId);

    const validated = treatmentPlanSchema.safeParse(Object.fromEntries(formData));
    if (!validated.success) {
      return { error: validated.error.flatten().fieldErrors };
    }

    const data = validated.data;

    const [created] = await db.insert(treatmentPlans).values({
      clinicId,
      patientId,
      title: data.title,
      description: data.description || null,
      totalAmount: 0,
      discount: data.discount != null && data.discount >= 0 ? data.discount : null,
      // Z-43 : colonne d'auteur existante mais jamais renseignée. Nullable en
      // base (l'INSERT fonctionnait avec NULL) ; on la renseigne avec
      // l'utilisateur de session.
      createdBy: user.id,
    }).returning({ id: treatmentPlans.id });

    await logAction({
      clinicId,
      action: "create",
      entityType: "treatment_plan",
      entityId: created.id,
      after: {
        patientId,
        title: data.title,
        description: data.description || null,
        totalAmount: 0,
        discount: data.discount != null && data.discount >= 0 ? data.discount : null,
      },
    });

    revalidatePath(`/patients/${patientId}`);
    redirect(`/patients/${patientId}/treatment-plan`);
  } catch (e) {
    if (isRedirectOrReject(e)) throw e;
    // Erreur d'accès (patient d'une autre clinique, inexistant ou archivé) :
    // remontée telle quelle, distincte de l'erreur technique générique.
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { title: [e.message] } };
    }
    return { error: { general: ["Erreur lors de la création du plan de traitement"] } };
  }
}

const treatmentPlanItemSchema = z.object({
  toothNumber: toothNumberFieldSchema,
  surface: z.string().optional().default("").catch(""),
  procedureCode: z.string().optional().default("").catch(""),
  description: z.string().min(1, "Description requise"),
  fee: z.coerce.number().min(0),
  quantity: z.coerce.number().int().positive().default(1),
  discount: z.coerce.number().min(0).default(0),
  taxRate: z.coerce.number().int().default(0),
});

export async function addTreatmentPlanItem(
  planId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = treatmentPlanItemSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [plan] = await db
      .select({ id: treatmentPlans.id, patientId: treatmentPlans.patientId })
      .from(treatmentPlans)
      .where(
        and(
          eq(treatmentPlans.id, planId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!plan) {
      return { error: { general: ["Plan de traitement introuvable"] } };
    }

    let createdId: string | undefined;

    await db.transaction(async (tx) => {
      const [created] = await tx.insert(treatmentPlanItems).values({
        planId,
        toothNumber: data.toothNumber ?? null,
        surface: data.surface || null,
        procedureCode: data.procedureCode || null,
        description: data.description,
        fee: data.fee,
        quantity: data.quantity,
        discount: data.discount,
        taxRate: data.taxRate,
      }).returning({ id: treatmentPlanItems.id });

      createdId = created?.id;

      await recalculatePlanTotal(planId, tx);
    });

    if (createdId) {
      await logAction({
        clinicId,
        action: "create",
        entityType: "treatment_plan_item",
        entityId: createdId,
        after: { ...data, planId },
      });
    }

    revalidatePath(`/patients/${plan.patientId}/treatment-plan/${planId}`);
    revalidatePath(`/patients/${plan.patientId}`);
    return { success: true };
  } catch {
    return { error: { general: ["Erreur lors de l'ajout de l'acte"] } };
  }
}

export async function updateTreatmentPlanItem(
  itemId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validated = treatmentPlanItemSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [item] = await db
      .select({
        id: treatmentPlanItems.id,
        planId: treatmentPlanItems.planId,
        patientId: treatmentPlans.patientId,
        toothNumber: treatmentPlanItems.toothNumber,
        surface: treatmentPlanItems.surface,
        procedureCode: treatmentPlanItems.procedureCode,
        description: treatmentPlanItems.description,
        fee: treatmentPlanItems.fee,
        quantity: treatmentPlanItems.quantity,
        discount: treatmentPlanItems.discount,
        taxRate: treatmentPlanItems.taxRate,
      })
      .from(treatmentPlanItems)
      .innerJoin(treatmentPlans, eq(treatmentPlanItems.planId, treatmentPlans.id))
      .where(
        and(
          eq(treatmentPlanItems.id, itemId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!item) {
      return { error: { general: ["Élément introuvable"] } };
    }

    await db.transaction(async (tx) => {
      await tx
        .update(treatmentPlanItems)
        .set({
          toothNumber: data.toothNumber ?? null,
          surface: data.surface || null,
          procedureCode: data.procedureCode || null,
          description: data.description,
          fee: data.fee,
          quantity: data.quantity,
          discount: data.discount,
          taxRate: data.taxRate,
        })
        .where(eq(treatmentPlanItems.id, itemId));

      await recalculatePlanTotal(item.planId, tx);
    });

    await logAction({
      clinicId,
      action: "update",
      entityType: "treatment_plan_item",
      entityId: itemId,
      before: {
        toothNumber: item.toothNumber ?? null,
        surface: item.surface ?? null,
        procedureCode: item.procedureCode ?? null,
        description: item.description,
        fee: item.fee,
        quantity: item.quantity,
        discount: item.discount,
        taxRate: item.taxRate,
      },
      after: { ...data, planId: item.planId },
    });

    revalidatePath(`/patients/${item.patientId}/treatment-plan/${item.planId}`);
    revalidatePath(`/patients/${item.patientId}`);
    return { success: true };
  } catch {
    return { error: { general: ["Erreur lors de la mise à jour de l'acte"] } };
  }
}

export async function updateTreatmentPlanStatus(
  planId: string,
  status: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const validStatuses = ["draft", "active", "completed", "cancelled"] as const;
  if (!validStatuses.includes(status as typeof validStatuses[number])) {
    return { error: "Statut invalide" };
  }

  const allowedTransitions: Record<string, string[]> = {
    draft: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };

  try {
    const [plan] = await db
      .select({
        patientId: treatmentPlans.patientId,
        status: treatmentPlans.status,
      })
      .from(treatmentPlans)
      .where(
        and(
          eq(treatmentPlans.id, planId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!plan) {
      return { error: "Plan de traitement introuvable" };
    }

    const next = status as typeof validStatuses[number];

    if (next === plan.status) {
      revalidatePath(`/patients/${plan.patientId}`);
      return { success: true };
    }

    if (!(allowedTransitions[plan.status] ?? []).includes(next)) {
      return { error: "Transition de statut non autorisée" };
    }

    if (next === "completed") {
      const [countRow] = await db
        .select({
          count: sql<number>`COUNT(*)::int`,
        })
        .from(treatmentPlanItems)
        .where(eq(treatmentPlanItems.planId, planId));

      if ((countRow?.count ?? 0) === 0) {
        return { error: "Impossible de terminer un plan sans acte" };
      }
    }

    await db
      .update(treatmentPlans)
      .set({ status: next })
      .where(
        and(
          eq(treatmentPlans.id, planId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      );

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "treatment_plan",
      entityId: planId,
      before: { status: plan.status },
      after: { status: next },
    });

    revalidatePath(`/patients/${plan.patientId}`);
    return { success: true };
  } catch {
    return { error: "Erreur lors de la mise à jour du statut" };
  }
}

export async function deleteTreatmentPlanItem(
  itemId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [item] = await db
      .select({
        id: treatmentPlanItems.id,
        planId: treatmentPlanItems.planId,
        patientId: treatmentPlans.patientId,
        description: treatmentPlanItems.description,
        fee: treatmentPlanItems.fee,
        quantity: treatmentPlanItems.quantity,
        procedureCode: treatmentPlanItems.procedureCode,
      })
      .from(treatmentPlanItems)
      .innerJoin(treatmentPlans, eq(treatmentPlanItems.planId, treatmentPlans.id))
      .where(
        and(
          eq(treatmentPlanItems.id, itemId),
          eq(treatmentPlans.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!item) {
      return { error: "Élément introuvable" };
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(treatmentPlanItems)
        .where(eq(treatmentPlanItems.id, itemId));

      await recalculatePlanTotal(item.planId, tx);
    });

    await logAction({
      clinicId,
      action: "delete",
      entityType: "treatment_plan_item",
      entityId: itemId,
      before: {
        description: item.description,
        fee: item.fee,
        quantity: item.quantity,
        procedureCode: item.procedureCode ?? null,
      },
    });

    revalidatePath(`/patients/${item.patientId}/treatment-plan/${item.planId}`);
    revalidatePath(`/patients/${item.patientId}`);
    return { success: true };
  } catch {
    return { error: "Erreur lors de la suppression" };
  }
}

export async function getConsultationNotes(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(consultationNotes)
      .where(
        and(
          eq(consultationNotes.patientId, patientId),
          eq(consultationNotes.clinicId, clinicId),
        ),
      )
      .orderBy(desc(consultationNotes.createdAt));
  } catch {
    return [];
  }
}

const consultationNoteSchema = z.object({
  notes: z.string().min(1, "Notes requises"),
  diagnosis: z.string().optional().default("").catch(""),
  appointmentId: z.string().optional().default("").catch(""),
});

export async function createConsultationNote(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Garde d'appartenance : `patientId` provient du client. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé.
  try {
    await requireOwnedPatient(clinicId, patientId);
  } catch (e) {
    // Erreur d'accès : remontée telle quelle, sous une clé déjà affichée par
    // le formulaire (les formulaires de notes n'affichent pas `general`).
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { notes: [e.message] } };
    }
    throw e;
  }

  const validated = consultationNoteSchema.safeParse(
    Object.fromEntries(formData),
  );
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  let createdId: string;

  try {
    const [created] = await db.insert(consultationNotes).values({
      clinicId,
      patientId,
      appointmentId: data.appointmentId || null,
      // Z-43 : colonne d'auteur existante mais jamais renseignée. Nullable en
      // base (l'INSERT fonctionnait avec NULL) ; renseignée avec l'utilisateur
      // de session.
      dentistId: user.id,
      diagnosis: data.diagnosis || null,
      notes: data.notes,
    }).returning({ id: consultationNotes.id });

    createdId = created.id;
  } catch {
    // Erreur d'écriture (FK, indisponibilité…) : remontée contrôlée, sous la
    // clé `notes` que le formulaire affiche déjà (`general` n'est pas rendu).
    return { error: { notes: ["Erreur lors de l'enregistrement de la note"] } };
  }

  // Audit hors du `try` d'écriture : la note existe à ce stade, un échec
  // d'audit ne doit pas être présenté comme un échec d'enregistrement.
  try {
    await logAction({
      clinicId,
      action: "create",
      entityType: "consultation_note",
      entityId: createdId,
      after: {
        patientId,
        appointmentId: data.appointmentId || null,
        diagnosis: data.diagnosis || null,
        notes: data.notes,
      },
    });
  } catch (auditError) {
    console.error("Échec de l'audit de création de la note", auditError);
  }

  // Z-52 : invalidation harmonisée avec la route réellement affichée (racine
  // du dossier + liste des notes), au même titre que `deleteRadiograph`.
  revalidatePath(`/patients/${patientId}`);
  revalidatePath(`/patients/${patientId}/consultation-notes`);
}

export async function getRadiographs(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(radiographs)
      .where(
        and(
          eq(radiographs.patientId, patientId),
          eq(radiographs.clinicId, clinicId),
          isNull(radiographs.deletedAt),
        ),
      )
      .orderBy(desc(radiographs.createdAt));
  } catch {
    return [];
  }
}

const radiographSchema = z.object({
  fileType: z.string().optional().default("").catch(""),
  toothNumber: toothNumberFieldSchema,
  region: z.string().optional().default("").catch(""),
  notes: z.string().optional().default("").catch(""),
  takenAt: z.string().optional().default("").catch(""),
});

/**
 * Allowlist de fichiers téléversables, strictement alignée sur :
 *  - `CONTENT_TYPE_BY_EXTENSION` de la route de lecture
 *    `src/app/api/files/[...key]/route.ts` (un `.svg`, `.html` ou `.exe` y
 *    serait servi en `application/octet-stream` ou avec un type actif) ;
 *  - `ALLOWED_MIME_TYPES` de `src/lib/storage.ts`.
 */
const RADIOGRAPH_ALLOWED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".pdf",
] as const;

const RADIOGRAPH_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

/** Aligné sur `MAX_FILE_SIZE` de `src/lib/storage.ts` (10 Mo). */
const RADIOGRAPH_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Valide un fichier radiographie AVANT tout téléversement : extension ET type
 * MIME contrôlés contre l'allowlist (un `.exe` renommé ou un SVG actif est
 * rejeté), taille bornée.
 */
function validateRadiographFile(
  file: File,
): { ok: true } | { ok: false; message: string } {
  const extension = extname(file.name).toLowerCase();
  if (
    !(RADIOGRAPH_ALLOWED_EXTENSIONS as readonly string[]).includes(extension)
  ) {
    return {
      ok: false,
      message:
        "Format de fichier non autorisé (accepté : jpg, jpeg, png, webp, pdf)",
    };
  }

  if (
    !(RADIOGRAPH_ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
  ) {
    return {
      ok: false,
      message:
        "Type de fichier non autorisé (accepté : jpg, jpeg, png, webp, pdf)",
    };
  }

  if (file.size > RADIOGRAPH_MAX_FILE_SIZE) {
    return {
      ok: false,
      message: "Le fichier dépasse la taille maximale de 10 Mo",
    };
  }

  return { ok: true };
}

/**
 * Contrat de retour explicite aligné sur `prevState` : sans annotation,
 * l'union inférée des retours d'erreur (`file`, `general`, fieldErrors)
 * casserait la déduction de `useActionState` dans le formulaire client.
 */
export async function createRadiograph(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
): Promise<{ error?: Record<string, string[]> } | undefined> {
  const user = await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Garde d'appartenance : `patientId` provient du client. Placé AVANT l'upload
  // (inchangé ci-dessous) pour ne pas téléverser un fichier rattaché à un
  // patient d'une autre clinique, inexistant ou archivé.
  try {
    await requireOwnedPatient(clinicId, patientId);
  } catch (e) {
    // Erreur d'accès : remontée telle quelle, sous la clé `file` que le
    // formulaire affiche déjà (branche de retour préexistante).
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { file: [e.message] } };
    }
    throw e;
  }

  const validated = radiographSchema.safeParse(Object.fromEntries(formData));
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;
  const file = formData.get("file") as File | null;

  if (!file || file.size === 0) {
    return { error: { file: ["Fichier requis"] } };
  }

  // Validation AVANT upload : type, extension et taille bornés (sinon un
  // contenu actif — HTML, SVG, exécutable — serait stocké et servi).
  const fileCheck = validateRadiographFile(file);
  if (!fileCheck.ok) {
    return { error: { file: [fileCheck.message] } };
  }

  const key = `${clinicId}/radiograph-${crypto.randomUUID()}`;
  let fileKey: string;

  try {
    fileKey = await storage.upload(file, key);
  } catch (err) {
    return { error: { file: [(err as Error).message || "Erreur lors de l'upload"] } };
  }

  let createdId: string;

  try {
    const [created] = await db.insert(radiographs).values({
      clinicId,
      patientId,
      fileKey,
      fileType: data.fileType || null,
      // Z-42 : `data.toothNumber` est déjà un `number | undefined` validé
      // (1–48). L'ancien `data.toothNumber ? Number(...) : null` convertissait
      // silencieusement le 0 (issu de `z.coerce` sur un champ vide) en `null`.
      toothNumber: data.toothNumber ?? null,
      region: data.region || null,
      notes: data.notes || null,
      // Z-43 : colonne d'auteur existante mais jamais renseignée. Nullable en
      // base (l'INSERT fonctionnait avec NULL) ; renseignée avec l'utilisateur
      // de session.
      uploadedBy: user.id,
      takenAt: data.takenAt ? new Date(data.takenAt) : null,
    }).returning({ id: radiographs.id });

    createdId = created.id;
  } catch (insertError) {
    // L'INSERT est postérieur à l'upload : en cas d'échec, le fichier déjà
    // téléversé serait orphelin dans le stockage → nettoyage systématique.
    try {
      await storage.delete(fileKey);
    } catch (cleanupError) {
      console.error("Échec du nettoyage du fichier orphelin", {
        fileKey,
        cleanupError,
      });
    }
    console.error("Échec de l'enregistrement de la radiographie", insertError);
    return {
      error: { general: ["Erreur lors de l'enregistrement de la radiographie"] },
    };
  }

  // Audit hors du `try` d'écriture : la radiographie existe à ce stade, un
  // échec d'audit ne doit pas être présenté comme un échec d'enregistrement.
  try {
    await logAction({
      clinicId,
      action: "create",
      entityType: "radiograph",
      entityId: createdId,
      after: {
        patientId,
        fileKey,
        fileType: data.fileType || null,
        toothNumber: data.toothNumber ?? null,
        region: data.region || null,
      },
    });
  } catch (auditError) {
    console.error("Échec de l'audit de création de la radiographie", auditError);
  }

  // Z-52 : la création n'invalidisait que la racine du dossier alors que
  // `deleteRadiograph` invalide aussi la liste des radios → harmonisé.
  revalidatePath(`/patients/${patientId}`);
  revalidatePath(`/patients/${patientId}/radiographs`);
}

export async function deleteRadiograph(
  radiographId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [radiograph] = await db
      .select({
        id: radiographs.id,
        fileKey: radiographs.fileKey,
        patientId: radiographs.patientId,
        fileType: radiographs.fileType,
        region: radiographs.region,
      })
      .from(radiographs)
      .where(
        and(
          eq(radiographs.id, radiographId),
          eq(radiographs.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!radiograph) {
      return { error: "Radiographie introuvable" };
    }

    await storage.delete(radiograph.fileKey);

    await db
      .update(radiographs)
      .set({ deletedAt: new Date() })
      .where(eq(radiographs.id, radiographId));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "radiograph",
      entityId: radiographId,
      before: {
        fileKey: radiograph.fileKey,
        fileType: radiograph.fileType ?? null,
        region: radiograph.region ?? null,
      },
      after: { deletedAt: new Date().toISOString() },
    });

    revalidatePath(`/patients/${radiograph.patientId}`);
    revalidatePath(`/patients/${radiograph.patientId}/radiographs`);
    return { success: true };
  } catch {
    return { error: "Erreur lors de la suppression de la radiographie" };
  }
}

export async function getMedicalHistory(patientId: string) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    return await db
      .select()
      .from(medicalHistoryEntries)
      .where(
        and(
          eq(medicalHistoryEntries.patientId, patientId),
          eq(medicalHistoryEntries.clinicId, clinicId),
        ),
      )
      .orderBy(desc(medicalHistoryEntries.createdAt));
  } catch {
    return [];
  }
}

const medicalHistorySchema = z.object({
  condition: z.string().min(1, "Condition requise"),
  diagnosisDate: z.string().optional().default("").catch(""),
  notes: z.string().optional().default("").catch(""),
  isActive: z.boolean().optional().default(true),
});

export async function createMedicalHistoryEntry(
  patientId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Garde d'appartenance : `patientId` provient du client. Lève
  // `Error("Patient introuvable ou archivé")` si le patient n'existe pas,
  // appartient à une autre clinique ou est archivé.
  try {
    await requireOwnedPatient(clinicId, patientId);
  } catch (e) {
    // Erreur d'accès : remontée telle quelle, sous une clé déjà affichée par
    // le formulaire (les formulaires d'antécédents n'affichent pas `general`).
    if (e instanceof Error && e.message === "Patient introuvable ou archivé") {
      return { error: { condition: [e.message] } };
    }
    throw e;
  }

  const raw: Record<string, unknown> = Object.fromEntries(formData);
  raw.isActive = formData.has("isActive");

  const validated = medicalHistorySchema.safeParse(raw);
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  let createdId: string;

  try {
    const [created] = await db.insert(medicalHistoryEntries).values({
      clinicId,
      patientId,
      condition: data.condition,
      diagnosisDate: data.diagnosisDate ? new Date(data.diagnosisDate) : null,
      notes: data.notes || null,
      isActive: data.isActive,
    }).returning({ id: medicalHistoryEntries.id });

    createdId = created.id;
  } catch {
    // Erreur d'écriture (FK, indisponibilité…) : remontée contrôlée, sous la
    // clé `condition` que le formulaire affiche déjà (`general` n'est pas rendu).
    return {
      error: { condition: ["Erreur lors de l'enregistrement de l'antécédent"] },
    };
  }

  // Audit hors du `try` d'écriture : l'entrée existe à ce stade, un échec
  // d'audit ne doit pas être présenté comme un échec d'enregistrement.
  try {
    await logAction({
      clinicId,
      action: "create",
      entityType: "medical_history_entry",
      entityId: createdId,
      after: {
        patientId,
        condition: data.condition,
        diagnosisDate: data.diagnosisDate ? new Date(data.diagnosisDate).toISOString() : null,
        isActive: data.isActive,
      },
    });
  } catch (auditError) {
    console.error(
      "Échec de l'audit de création de l'antécédent",
      auditError,
    );
  }

  // Z-52 : invalidation harmonisée avec la route réellement affichée (racine
  // du dossier + liste des antécédents).
  revalidatePath(`/patients/${patientId}`);
  revalidatePath(`/patients/${patientId}/medical-history`);
}

export async function updateMedicalHistoryEntry(
  entryId: string,
  prevState: { error?: Record<string, string[]> } | undefined,
  formData: FormData,
) {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  const raw: Record<string, unknown> = Object.fromEntries(formData);
  raw.isActive = formData.has("isActive");

  const validated = medicalHistorySchema.safeParse(raw);
  if (!validated.success) {
    return { error: validated.error.flatten().fieldErrors };
  }

  const data = validated.data;

  try {
    const [entry] = await db
      .select({
        patientId: medicalHistoryEntries.patientId,
        condition: medicalHistoryEntries.condition,
        diagnosisDate: medicalHistoryEntries.diagnosisDate,
        notes: medicalHistoryEntries.notes,
        isActive: medicalHistoryEntries.isActive,
      })
      .from(medicalHistoryEntries)
      .where(
        and(
          eq(medicalHistoryEntries.id, entryId),
          eq(medicalHistoryEntries.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!entry) {
      return { error: { general: ["Entrée introuvable"] } };
    }

    await db
      .update(medicalHistoryEntries)
      .set({
        condition: data.condition,
        diagnosisDate: data.diagnosisDate ? new Date(data.diagnosisDate) : null,
        notes: data.notes || null,
        isActive: data.isActive,
      })
      .where(eq(medicalHistoryEntries.id, entryId));

    await logAction({
      clinicId,
      action: "update",
      entityType: "medical_history_entry",
      entityId: entryId,
      before: {
        condition: entry.condition,
        diagnosisDate: entry.diagnosisDate ? entry.diagnosisDate.toISOString() : null,
        notes: entry.notes ?? null,
        isActive: entry.isActive,
      },
      after: {
        condition: data.condition,
        diagnosisDate: data.diagnosisDate ? new Date(data.diagnosisDate).toISOString() : null,
        notes: data.notes || null,
        isActive: data.isActive,
      },
    });

    revalidatePath(`/patients/${entry.patientId}`);
  } catch {
    return { error: { general: ["Erreur lors de la mise à jour"] } };
  }
}

export async function deleteMedicalHistoryEntry(
  entryId: string,
): Promise<{ error?: string } | { success?: boolean }> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  try {
    const [entry] = await db
      .select({
        patientId: medicalHistoryEntries.patientId,
        condition: medicalHistoryEntries.condition,
        isActive: medicalHistoryEntries.isActive,
      })
      .from(medicalHistoryEntries)
      .where(
        and(
          eq(medicalHistoryEntries.id, entryId),
          eq(medicalHistoryEntries.clinicId, clinicId),
        ),
      )
      .limit(1);

    if (!entry) {
      return { error: "Entrée introuvable" };
    }

    await db
      .delete(medicalHistoryEntries)
      .where(eq(medicalHistoryEntries.id, entryId));

    await logAction({
      clinicId,
      action: "delete",
      entityType: "medical_history_entry",
      entityId: entryId,
      before: {
        condition: entry.condition,
        isActive: entry.isActive,
      },
    });

    revalidatePath(`/patients/${entry.patientId}`);
    return { success: true };
  } catch {
    return { error: "Erreur lors de la suppression" };
  }
}
