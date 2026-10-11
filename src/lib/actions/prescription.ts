"use server";

import { db } from "@/lib/db/db";
import {
  prescriptions,
  prescriptionItems,
  patients,
  users,
  clinicalSessions,
  medicalHistoryEntries,
} from "@/lib/db/schema";
import { getCurrentClinicId } from "@/lib/multi-tenant";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { requireOwnedPatient } from "@/lib/guards";
import { eq, and, desc, asc, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logAction } from "@/lib/audit";
import { isRedirectOrReject } from "./errors";

/**
 * Z-45 — colonne `prescription_item.order_index`.
 *
 * ⚠️ La colonne est ajoutée au SCHÉMA Drizzle mais **n'existe pas encore en
 * base** : `npm run db:generate` puis `npm run db:migrate` doivent être
 * lancés par le client. Tant que la migration n'est pas appliquée, ce
 * drapeau — résolu **une seule fois par process** — bascule en `false` et le
 * module retombe intégralement sur l'ancien comportement (tri alphabétique,
 * INSERT sans `order_index`), sans erreur visible. Après la migration, un
 * redémarrage du serveur suffit à activer l'ordre de saisie.
 */
let orderIndexColumnSupport: boolean | undefined;

/** PG `42703` = `undefined_column` : seule cette cause est mémorisée. */
function isMissingOrderIndexColumn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42703"
  );
}

async function prescriptionItemsHaveOrderIndex(): Promise<boolean> {
  if (orderIndexColumnSupport !== undefined) return orderIndexColumnSupport;

  try {
    await db
      .select({ orderIndex: prescriptionItems.orderIndex })
      .from(prescriptionItems)
      .limit(0);
    orderIndexColumnSupport = true;
  } catch (error) {
    // Une erreur transitoire (base indisponible) ne doit pas figer le mode
    // dégradé pour tout le process : seul l'absence de colonne est mémorisée.
    if (!isMissingOrderIndexColumn(error)) throw error;
    orderIndexColumnSupport = false;
  }

  return orderIndexColumnSupport;
}

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
      // Z-47 : le filtre d'archivage est ajouté sur la INNER JOIN patients (et
      // NON sur la LEFT JOIN users, qui n'a pas de colonne deletedAt) : un
      // patient archivé disparaît de la liste patients et ne doit donc pas
      // rester visible ici.
      .where(
        and(
          ...conditions,
          eq(patients.clinicId, clinicId),
          isNull(patients.deletedAt),
        ),
      )
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

    // Z-45 : l'ordre de saisie n'existe pas encore en base (colonne à migrer).
    // Tant que `order_index` est absent, on conserve le tri alphabétique
    // historique ; sinon l'ordre de saisie prime, le nom servant de tie-break
    // pour les lignes héritées (sans index).
    const useOrderIndex = await prescriptionItemsHaveOrderIndex();

    const itemsQuery = db
      .select()
      .from(prescriptionItems)
      .where(eq(prescriptionItems.prescriptionId, id));

    const items = useOrderIndex
      ? await itemsQuery.orderBy(
          asc(prescriptionItems.orderIndex),
          asc(prescriptionItems.name),
        )
      : await itemsQuery.orderBy(asc(prescriptionItems.name));

    // Z-51 : alertes d'allergie par correspondance textuelle, recalculées à
    // chaque lecture pour l'affichage persistant (page de détails / édition).
    // `findAllergyAlerts` avale ses propres erreurs de lecture : un antécédent
    // illisible ne doit jamais faire échouer la page.
    const warnings = formatAllergyAlerts(
      await findAllergyAlerts(clinicId, row.patient.id, items),
    );

    return {
      ...row.prescription,
      patient: row.patient,
      dentistName: row.dentistName,
      items,
      warnings,
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

/**
 * Z-51 — alerte allergie (aide à la décision, **jamais** un blocage).
 *
 * ⚠️ La détection est **textuelle et approximative**, et ses limites sont
 * assumées plutôt que masquées :
 *  - une allergie n'est repérée que si son libellé contient « allerg… » :
 *    `condition` est un texte libre, un antécédent rédigé autrement
 *    (« intolérance à la pénicilline », « urticaire après Amoxil ») passe
 *    inaperçu ;
 *  - la correspondance est une simple inclusion de mots (accents et
 *    casse neutralisés) entre l'allergène et le nom du médicament saisi :
 *    « Allergie à la pénicilline » ↔ « Amoxicilline 500 mg » est détecté,
 *    mais un nom de marque (« Amoxil »), une classe thérapeutique, une
 *    abréviation ou une faute de frappe ne le sera PAS ;
 *  - un allergène court ou générique peut produire un faux positif (mots de
 *    4 caractères minimum, hors liste d'arrêt).
 * **Une absence d'alerte ne signifie donc jamais « pas d'allergie ».** C'est
 * un filet grossier, préférable à aucune aide, mais non fiable cliniquement.
 * Le `drug_catalog` n'est pas utilisé : sans normalisation des molécules et
 * de leurs classes, il ne réduirait ni les faux négatifs ni les faux
 * positifs (hors périmètre de cette tâche).
 */
const ALLERGY_KEYWORD_PATTERN = /allerg/i;

const ALLERGY_KEYWORDS = new Set([
  "allergie",
  "allergies",
  "allergique",
  "allergiques",
  "allergy",
  "allergic",
]);

/** Mots-outils (déjà sans accent) écartés des tokens d'allergène. */
const ALLERGY_STOPWORDS = new Set([
  "aux", "au", "de", "des", "du", "la", "le", "les", "un", "une", "et",
  "avec", "sans", "connue", "connu", "connus", "connues", "medicament",
  "medicaments", "traitement", "traitements", "naissance", "antecedent",
  "antecedents", "patient", "patients", "diagnostiquee", "diagnostique",
]);

/** Minuscules + suppression des accents : « Pénicilline » ≈ « penicilline ». */
function normalizeLoose(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Tokens d'allergène candidats extraits d'un libellé d'antécédent. */
function allergenTokens(condition: string): string[] {
  if (!ALLERGY_KEYWORD_PATTERN.test(condition)) return [];
  return normalizeLoose(condition)
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= 4 &&
        !ALLERGY_STOPWORDS.has(token) &&
        !ALLERGY_KEYWORDS.has(token),
    );
}

interface AllergyAlert {
  condition: string;
  medication: string;
}

/**
 * Compare les médicaments de l'ordonnance aux antécédents ACTIFS du patient.
 * Une erreur de lecture est ignorée : l'alerte ne doit jamais empêcher
 * l'enregistrement d'une ordonnance.
 */
async function findAllergyAlerts(
  clinicId: string,
  patientId: string,
  items: Array<{ type: string; name: string }>,
): Promise<AllergyAlert[]> {
  const medications = items.filter(
    (item) => item.type === "medication" && item.name.trim().length > 0,
  );
  if (medications.length === 0) return [];

  let entries: Array<{ condition: string }>;
  try {
    entries = await db
      .select({ condition: medicalHistoryEntries.condition })
      .from(medicalHistoryEntries)
      .where(
        and(
          eq(medicalHistoryEntries.clinicId, clinicId),
          eq(medicalHistoryEntries.patientId, patientId),
          eq(medicalHistoryEntries.isActive, true),
        ),
      );
  } catch {
    return [];
  }

  const alerts: AllergyAlert[] = [];
  for (const entry of entries) {
    const tokens = allergenTokens(entry.condition);
    if (tokens.length === 0) continue;

    for (const item of medications) {
      const name = normalizeLoose(item.name);
      if (tokens.some((token) => name.includes(token))) {
        alerts.push({ condition: entry.condition, medication: item.name });
      }
    }
  }

  return alerts;
}

/**
 * Z-51 — messages d'alerte remontés au client (bandeau ambre) et écrits dans
 * la piste d'audit (`allergyAlerts`).
 *
 * Aucune trace n'est écrite dans les logs serveur : une donnée de santé
 * (antécédent + médicament) n'a pas à y figurer — hors contrôle d'accès et
 * hors conservation. L'audit suffit à la traçabilité.
 */
function formatAllergyAlerts(alerts: AllergyAlert[]): string[] {
  return alerts.map(
    (alert) =>
      `« ${alert.medication} » — correspondance possible avec l'antécédent « ${alert.condition} »`,
  );
}

/**
 * Z-51 — joint les alertes au retour de l'action, uniquement si non vides.
 *
 * Le champ `warnings` est OPTIONNEL : c'est un élargissement rétro-compatible
 * du contrat (les consommateurs ne lisent que `error` / `success`).
 */
function withAllergyWarnings<T extends object>(
  state: T,
  warnings: string[],
): T & { warnings?: string[] } {
  return warnings.length > 0 ? { ...state, warnings } : state;
}

/**
 * Z-51 — état partagé des actions `createPrescription` / `updatePrescription`
 * (contrat `useActionState` de l'éditeur).
 *
 * `warnings` élargit le contrat de retour : champ OPTIONNEL, donc
 * rétro-compatible — l'éditeur ne lit aujourd'hui que `error` / `success`.
 * Il porte les alertes d'allergie détectées par correspondance textuelle
 * (aide à la décision, JAMAIS un blocage).
 */
export interface PrescriptionFormState {
  error?: Record<string, string[] | undefined>;
  warnings?: string[];
  success?: boolean;
}

export async function createPrescription(
  prevState: PrescriptionFormState | undefined,
  formData: FormData,
): Promise<PrescriptionFormState> {
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

  // Z-51 : alertes d'allergie (aide à la décision, JAMAIS un blocage) lues
  // AVANT toute écriture et calculées dès la validation réussie, pour être
  // jointes à tous les retours de l'action susceptibles d'atteindre l'UI
  // (le succès redirige vers la liste : un bandeau après création réussie
  // relève de l'éditeur — cf. rapport au Lead).
  const allergyAlerts = await findAllergyAlerts(
    clinicId,
    data.patientId,
    items,
  );
  const allergyWarnings = formatAllergyAlerts(allergyAlerts);

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
        return withAllergyWarnings(
          { error: { general: ["Séance introuvable"] } },
          allergyWarnings,
        );
      }
    }

    let createdId: string | undefined;

    // Z-45 : ordre de saisie des lignes, si la colonne est migrée.
    const useOrderIndex = await prescriptionItemsHaveOrderIndex();

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
          items.map((item, index) => ({
            prescriptionId: prescription.id,
            ...item,
            ...(useOrderIndex ? { orderIndex: index + 1 } : {}),
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
          ...(allergyAlerts.length > 0 ? { allergyAlerts } : {}),
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
      return withAllergyWarnings(
        { error: { general: ["Patient introuvable ou archivé"] } },
        allergyWarnings,
      );
    }
    return withAllergyWarnings(
      { error: { general: ["Erreur lors de la création de l'ordonnance"] } },
      allergyWarnings,
    );
  }
}

export async function updatePrescription(
  id: string,
  prevState: PrescriptionFormState | undefined,
  formData: FormData,
): Promise<PrescriptionFormState> {
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

  // Z-51 : alertes d'allergie (aide à la décision, JAMAIS un blocage) jointes
  // à tous les retours de l'action, succès COMPRIS : le bandeau reste donc
  // visible après un enregistrement réussi. Élargissement rétro-compatible du
  // contrat (`warnings` est un champ optionnel du retour).
  let allergyAlerts: AllergyAlert[] = [];

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

    // Z-51 : mêmes antécédents que ceux vérifiés à la création, les lignes
    // étant entièrement réécrites.
    allergyAlerts = await findAllergyAlerts(
      clinicId,
      existing.patientId,
      items,
    );

    // Z-45 : ordre de saisie des lignes, si la colonne est migrée.
    const useOrderIndex = await prescriptionItemsHaveOrderIndex();

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
          items.map((item, index) => ({
            prescriptionId: id,
            ...item,
            ...(useOrderIndex ? { orderIndex: index + 1 } : {}),
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
      after: {
        notes: data.notes || null,
        ...(allergyAlerts.length > 0 ? { allergyAlerts } : {}),
      },
    });

    revalidatePath(`/prescriptions/${id}`);
    revalidatePath("/prescriptions");
    revalidatePath(`/patients/${existing.patientId}/prescriptions`);
    revalidatePath(`/patients/${existing.patientId}`);
    if (existing.sessionId) {
      revalidatePath(`/patients/${existing.patientId}/session/${existing.sessionId}`);
    }
    return withAllergyWarnings(
      { success: true },
      formatAllergyAlerts(allergyAlerts),
    );
  } catch {
    // `allergyAlerts` n'est renseigné qu'après lecture de l'ordonnance : un
    // échec plus tôt ne joint donc aucune alerte (à défaut de patient fiable).
    return withAllergyWarnings(
      { error: { general: ["Erreur lors de la mise à jour de l'ordonnance"] } },
      formatAllergyAlerts(allergyAlerts),
    );
  }
}

/** Z-44 : validation runtime du statut (le typage TS ne protège rien côté serveur). */
const prescriptionStatusSchema = z.enum(["active", "completed", "cancelled"]);

type PrescriptionStatus = z.infer<typeof prescriptionStatusSchema>;

/**
 * Z-44 : machine à états d'une ordonnance.
 * - `active` → terminée ou annulée ;
 * - `completed` → annulée (sortie de correction conservée, cf. Z-44) ;
 * - `cancelled` est terminal.
 */
const PRESCRIPTION_STATUS_TRANSITIONS: Record<
  PrescriptionStatus,
  readonly PrescriptionStatus[]
> = {
  active: ["completed", "cancelled"],
  completed: ["cancelled"],
  cancelled: [],
};

export async function updatePrescriptionStatus(
  id: string,
  status: "active" | "completed" | "cancelled",
  _formData: FormData,
): Promise<void> {
  await requireAuth();
  const clinicId = await getCurrentClinicId();
  await requireClinicAccessOrThrow(clinicId);

  // Z-44 : validation runtime. Sans elle, une valeur hors enum provoquait une
  // erreur d'énumération PG avalée par le `catch` muet — et rien n'empêchait
  // une transition illégale (réouverture d'une ordonnance annulée…).
  const parsedStatus = prescriptionStatusSchema.safeParse(status);
  if (!parsedStatus.success) {
    // Contrat `Promise<void>` inchangé : pas de payload d'erreur possible.
    // Le point essentiel est qu'AUCUNE écriture ne parte avec un statut
    // invalide.
    return;
  }
  const next = parsedStatus.data;

  try {
    const [prescription] = await db
      .select({ patientId: prescriptions.patientId, status: prescriptions.status })
      .from(prescriptions)
      .where(and(eq(prescriptions.id, id), eq(prescriptions.clinicId, clinicId)))
      .limit(1);

    if (!prescription) {
      return;
    }

    // Z-44 : transition contrôlée (et no-op si statut identique).
    if (prescription.status === next) {
      return;
    }

    if (!PRESCRIPTION_STATUS_TRANSITIONS[prescription.status].includes(next)) {
      return;
    }

    await db
      .update(prescriptions)
      .set({ status: next })
      .where(and(eq(prescriptions.id, id), eq(prescriptions.clinicId, clinicId)));

    await logAction({
      clinicId,
      action: "status_change",
      entityType: "prescription",
      entityId: id,
      before: { status: prescription.status },
      after: { status: next },
    });

    revalidatePath(`/prescriptions/${id}`);
    revalidatePath("/prescriptions");
    revalidatePath(`/patients/${prescription.patientId}/prescriptions`);
    revalidatePath(`/patients/${prescription.patientId}`);
  } catch {
    return;
  }
}
