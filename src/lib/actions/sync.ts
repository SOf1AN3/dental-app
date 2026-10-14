"use server";

/**
 * Tâche 7.2 — Server Actions de l'interface de synchronisation.
 *
 * Sécurité (identique aux actions `settings.ts`) :
 *  - **chaque** action vérifie la session (`requireAuth`) ET l'appartenance au
 *    cabinet actif (`requireCurrentClinic` — le cookie `active_clinic_id` est
 *    revalidé contre `clinicMemberships`, défense en profondeur PAR-1) ;
 *  - les actions de mutation **multi-tenant** re-valident l'appartenance des
 *    lignes manipulées au cabinet courant avant toute écriture (`mergePatientAction`,
 *    revue des fusions filtrée par `clinicId` dans `getSyncOverview`) ;
 *  - aucun secret ni payload de journal n'est renvoyé : la vue de revue se
 *    limite aux colonnes strictement nécessaires (table, ligne, motif, date ;
 *    nom + naissance pour la revue de fusion) ;
 *  - `bootstrapAction` n'appelle **que** `http://127.0.0.1:<port>/api/sync/bootstrap`
 *    (localhost du poste, port tiré de l'env `PORT`) : aucune URL fournie par
 *    l'utilisateur n'est jamais acceptée (anti-SSRF).
 */

import { z } from "zod";
import { count, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db/db";
import { patients, syncOutbox } from "@/lib/db/schema";
import { requireAuth, requireClinicAccessOrThrow } from "@/lib/auth-utils";
import { requireCurrentClinic } from "@/lib/multi-tenant";
import {
  createConflictsDbRepo,
  listConflicts,
  resolveConflict,
} from "@/lib/sync/conflict";
import {
  MERGE_REVIEW_PREFIX,
  createMergeDbRepo,
  listPendingMerges,
  mergeDuplicatePatients,
  resolveMerge,
} from "@/lib/sync/merge";

/* -------------------------------------------------------------------------- */
/* Types sérialisables (RSC → Client Components)                               */
/* -------------------------------------------------------------------------- */

/** Conflit non résolu, réduit au strict nécessaire de la revue (D-4). */
export interface SyncConflictItem {
  readonly id: string;
  readonly table: string;
  readonly rowId: string;
  readonly reason: string | null;
  /** ISO de l'arbitrage. */
  readonly decidedAt: string;
}

/** Identité minimale affichable pour la revue de fusion (D-5) — nom + naissance. */
export interface SyncMergeParty {
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string | null;
}

/** Doublon patient en attente d'un humain. */
export interface SyncMergeItem {
  readonly id: string;
  readonly candidateId: string;
  readonly canonicalId: string;
  readonly reason: string;
  readonly decidedAt: string;
  readonly candidate: SyncMergeParty | null;
  readonly existing: SyncMergeParty | null;
}

/** Comptages de la file d'attente locale (`sync_outbox`). */
export interface SyncQueueCounts {
  readonly pendingCount: number;
  readonly failedCount: number;
}

/** Vue d'ensemble lue par `/settings/sync` (lecture seule, sans secret). */
export interface SyncOverview extends SyncQueueCounts {
  readonly conflicts: readonly SyncConflictItem[];
  readonly merges: readonly SyncMergeItem[];
}

/** Résultat générique des actions de mutation. */
export type SyncActionResult =
  | { readonly success: true; readonly message: string }
  | { readonly success: false; readonly error: string };

/** Résultat de `bootstrapAction`. */
export type BootstrapActionResult =
  | { readonly success: true; readonly pulled: number; readonly hasMore: boolean }
  | { readonly success: false; readonly error: string };

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const idSchema = z.string().trim().min(1).max(256);

const mergeInputSchema = z.object({
  candidateId: z.string().trim().min(1).max(256),
  existingId: z.string().trim().min(1).max(256),
  /** Entrée de revue d'origine à clore si la fusion aboutit (facultatif). */
  reviewId: z.string().trim().min(1).max(256).optional(),
});

/** Borne alignée sur `MAX_BOOTSTRAP_CLINICS` côté route bootstrap. */
const bootstrapInputSchema = z.array(z.string().trim().min(1).max(256)).min(1).max(25);

/** Corps attendu de `POST /api/sync/bootstrap` (succès 200). */
const bootstrapResponseSchema = z.object({
  pulled: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/* Lecture : vue d'ensemble                                                    */
/* -------------------------------------------------------------------------- */

function toParty(
  row: Pick<typeof patients.$inferSelect, "firstName" | "lastName" | "dateOfBirth"> | undefined,
): SyncMergeParty | null {
  if (row === undefined) return null;
  return {
    firstName: row.firstName,
    lastName: row.lastName,
    dateOfBirth: row.dateOfBirth === null ? null : row.dateOfBirth.toISOString(),
  };
}

/**
 * État de la synchronisation pour `/settings/sync` : comptages de la file
 * (`sync_outbox`), conflits non résolus (hors revues de fusion) et doublons
 * patients en attente, **bornés au cabinet courant** pour les fusions (le
 * journal des conflits est device-wide et n'expose que des métadonnées).
 */
export async function getSyncOverview(): Promise<SyncOverview> {
  await requireAuth();
  const clinicId = await requireCurrentClinic();

  const conflictRepo = createConflictsDbRepo(db);
  const mergeRepo = createMergeDbRepo(db);

  const [queueRows, unresolved, pendingMerges] = await Promise.all([
    db
      .select({ status: syncOutbox.status, total: count() })
      .from(syncOutbox)
      .groupBy(syncOutbox.status),
    listConflicts(conflictRepo, { unresolvedOnly: true }),
    listPendingMerges(mergeRepo),
  ]);

  let pendingCount = 0;
  let failedCount = 0;
  for (const row of queueRows) {
    if (row.status === "pending") pendingCount = row.total;
    if (row.status === "failed") failedCount = row.total;
  }

  // La file de revue D-5 vit dans `sync_conflict` (préfixe `merge-review:`) :
  // elle est servie par `merge-review`, pas par la liste des conflits D-4.
  const conflicts: SyncConflictItem[] = unresolved
    .filter((row) => !(row.reason ?? "").startsWith(MERGE_REVIEW_PREFIX))
    .map((row) => ({
      id: row.id,
      table: row.table,
      rowId: row.rowId,
      reason: row.reason,
      decidedAt: row.decidedAt.toISOString(),
    }));

  // Enrichissement nom/naissance — **filtré sur le cabinet courant** : une
  // revue concernant un autre tenant n'est jamais exposée à cet utilisateur.
  const patientIds = [
    ...new Set(
      pendingMerges.flatMap((m) => [m.candidateId, m.canonicalId]).filter((id) => id.length > 0),
    ),
  ];
  const patientRows =
    patientIds.length > 0
      ? await db
          .select({
            id: patients.id,
            clinicId: patients.clinicId,
            firstName: patients.firstName,
            lastName: patients.lastName,
            dateOfBirth: patients.dateOfBirth,
          })
          .from(patients)
          .where(inArray(patients.id, patientIds))
      : [];
  const patientsById = new Map(patientRows.map((row) => [row.id, row]));

  const merges: SyncMergeItem[] = pendingMerges
    .filter((m) => patientsById.get(m.candidateId)?.clinicId === clinicId)
    .map((m) => ({
      id: m.id,
      candidateId: m.candidateId,
      canonicalId: m.canonicalId,
      reason: m.reason,
      decidedAt: m.decidedAt.toISOString(),
      candidate: toParty(patientsById.get(m.candidateId)),
      existing: toParty(patientsById.get(m.canonicalId)),
    }));

  return { pendingCount, failedCount, conflicts, merges };
}

/* -------------------------------------------------------------------------- */
/* Mutations : conflits (D-4)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Marque une entrée du journal des conflits comme traitée par un humain
 * (`resolveConflict` — idempotent : un id résolu ou inconnu est un no-op).
 */
export async function resolveConflictAction(id: string): Promise<SyncActionResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { success: false, error: "Identifiant de conflit invalide." };
  }
  const user = await requireAuth();
  await requireCurrentClinic();

  try {
    await resolveConflict(createConflictsDbRepo(db), {
      id: parsed.data,
      resolvedBy: user.id,
    });
    revalidatePath("/settings/sync");
    return { success: true, message: "Conflit marqué comme traité." };
  } catch {
    return { success: false, error: "Enregistrement impossible (base de données indisponible)." };
  }
}

/* -------------------------------------------------------------------------- */
/* Mutations : revue des fusions (D-5)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Clore une entrée de revue **sans** fusionner (« Ignorer » — `resolveMerge`,
 * idempotent).
 */
export async function resolveMergeAction(id: string): Promise<SyncActionResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { success: false, error: "Identifiant de revue invalide." };
  }
  const user = await requireAuth();
  await requireCurrentClinic();

  try {
    await resolveMerge(createMergeDbRepo(db), {
      id: parsed.data,
      resolvedBy: user.id,
    });
    revalidatePath("/settings/sync");
    return { success: true, message: "Revue ignorée." };
  } catch {
    return { success: false, error: "Enregistrement impossible (base de données indisponible)." };
  }
}

/**
 * Applique une fusion décidée à la main (« Fusionner » — `mergeDuplicatePatients`).
 *
 * L'opération peut être **refusée** par les garde-fous D-5 (cross-clinic,
 * identité différente, horloge…) : le motif local est alors **propagé tel
 * quel** au client (jamais un message de serveur central). En cas de refus, le
 * moteur ajoute lui-même une nouvelle entrée de revue — d'où le
 * `revalidatePath`.
 *
 * Garde multi-tenant : les DEUX patients doivent appartenir au cabinet actif,
 * sinon refus net avant tout appel au moteur.
 */
export async function mergePatientAction(input: {
  candidateId: string;
  existingId: string;
  reviewId?: string;
}): Promise<SyncActionResult> {
  const parsed = mergeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Paramètres de fusion invalides." };
  }
  const { candidateId, existingId, reviewId } = parsed.data;
  if (candidateId === existingId) {
    return { success: false, error: "Ces deux identifiants désignent le même dossier." };
  }

  const user = await requireAuth();
  const clinicId = await requireCurrentClinic();

  const rows = await db
    .select({ id: patients.id, clinicId: patients.clinicId })
    .from(patients)
    .where(inArray(patients.id, [candidateId, existingId]));
  if (rows.length !== 2 || rows.some((row) => row.clinicId !== clinicId)) {
    return { success: false, error: "Dossier introuvable dans ce cabinet." };
  }

  // Clôture de la revue d'origine après succès — **best-effort** : la fusion
  // est déjà appliquée, un échec de clôture ne doit pas la signaler en échec.
  const closeReview = async (): Promise<void> => {
    if (reviewId === undefined) return;
    try {
      await resolveMerge(createMergeDbRepo(db), { id: reviewId, resolvedBy: user.id });
    } catch {
      // La revue restera dans la file : un second « Ignorer » la clôturera.
    }
  };

  try {
    const result = await mergeDuplicatePatients(createMergeDbRepo(db), {
      candidateId,
      existingId,
      now: new Date(),
    });

    switch (result.status) {
      case "merged": {
        await closeReview();
        revalidatePath("/settings/sync");
        return {
          success: true,
          message: `Dossiers fusionnés : ${result.children.total} enregistrement(s) rattaché(s) au dossier conservé.`,
        };
      }
      case "already-merged":
        await closeReview();
        revalidatePath("/settings/sync");
        return { success: true, message: "Ces dossiers ont déjà été fusionnés." };
      case "self-merge":
        return {
          success: false,
          error: "Ces identifiants désignent le même dossier : rien à fusionner.",
        };
      case "review":
        revalidatePath("/settings/sync");
        return {
          success: false,
          error: `Fusion refusée par les garde-fous : ${result.reason}. Une nouvelle revue a été ajoutée à la file.`,
        };
      case "none":
        return {
          success: false,
          error: `Fusion refusée : ${result.reason}.`,
        };
      case "not-found":
        return { success: false, error: "Dossier introuvable lors de la fusion." };
    }
  } catch {
    return { success: false, error: "Fusion impossible (base de données indisponible)." };
  }
}

/* -------------------------------------------------------------------------- */
/* Amorçage (bootstrap)                                                        */
/* -------------------------------------------------------------------------- */

/** Port du serveur Next **local** : `PORT` de l'enfant, défaut 3000. */
function resolveLocalPort(): number {
  const raw = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65_536 ? raw : 3000;
}

/**
 * Amorçage d'une installation neuve : appelle — **depuis le serveur** —
 * `POST http://127.0.0.1:<port>/api/sync/bootstrap` avec les cabinets
 * validés. L'origine est fixée par le code (localhost, jamais fournie par
 * l'utilisateur) ; seuls les `clinicId` auxquels l'utilisateur a **accès**
 * (`requireClinicAccessOrThrow`) sont transmis.
 */
export async function bootstrapAction(clinicIds: string[]): Promise<BootstrapActionResult> {
  const parsed = bootstrapInputSchema.safeParse(clinicIds);
  if (!parsed.success) {
    return { success: false, error: "Liste de cabinets invalide pour l'amorçage." };
  }

  // Session d'abord : un redirect de `requireAuth` ne doit jamais être avalé
  // par le try/catch ci-dessous.
  await requireAuth();
  try {
    for (const clinicId of parsed.data) {
      await requireClinicAccessOrThrow(clinicId);
    }
  } catch {
    return { success: false, error: "Accès refusé à l'un des cabinets demandés." };
  }

  const url = `http://127.0.0.1:${resolveLocalPort()}/api/sync/bootstrap`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clinicIds: parsed.data }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return {
      success: false,
      error: "Serveur local injoignable : l'amorçage n'a pas pu être lancé.",
    };
  }

  if (response.status === 409) {
    return {
      success: false,
      error:
        "Amorçage indisponible : connectez-vous d'abord (jeton d'appareil absent sur le serveur local).",
    };
  }
  if (response.status === 400) {
    return { success: false, error: "Requête d'amorçage refusée (cabinet manquant ou invalide)." };
  }
  if (!response.ok) {
    return { success: false, error: "Amorçage impossible (erreur interne du serveur local)." };
  }

  const body = bootstrapResponseSchema.safeParse(await response.json().catch(() => null));
  if (!body.success) {
    return { success: false, error: "Réponse d'amorçage illisible." };
  }

  revalidatePath("/settings/sync");
  return { success: true, pulled: body.data.pulled, hasMore: body.data.hasMore };
}
