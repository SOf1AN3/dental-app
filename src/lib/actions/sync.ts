"use server";

/**
 * Tâche 7.2 — Server Actions de l'interface de synchronisation.
 *
 * Sécurité (identique aux actions `settings.ts`) :
 *  - **chaque** action vérifie la session (`requireAuth`) ET l'appartenance au
 *    cabinet actif (`requireCurrentClinic` — le cookie `active_clinic_id` est
 *    revalidé contre `clinicMemberships`, défense en profondeur PAR-1) ;
 *  - les actions de mutation **multi-tenant** re-valident l'appartenance des
 *    lignes manipulées au cabinet courant avant toute écriture (`mergePatientAction`)
 *    et toute clôture de revue (`resolveMergeAction`, `closeReview`) : la revue
 *    est **chargée** et sa paire (candidat + canonique) doit appartenir au
 *    cabinet actif, sinon réponse générique « introuvable » (pas d'oracle) ;
 *  - aucun secret ni payload de journal n'est renvoyé : la vue de revue se
 *    limite aux colonnes strictement nécessaires (table, ligne, motif, date ;
 *    nom + naissance pour la revue de fusion) ;
 *  - **fuite d'identité inter-cabinets (D-5)** : le moteur crée délibérément des
 *    revues `cross-clinic` (paires de deux tenants). `getSyncOverview` n'affiche
 *    `toParty` (prénom, nom, naissance) QUE si LES DEUX parties — candidat ET
 *    canonique — sont dans le cabinet courant ; sinon entrée **résumée sans
 *    identité** (parties `null`, motif générique) ;
 *  - `bootstrapAction` n'appelle **que** `http://127.0.0.1:<port>/api/sync/bootstrap`
 *    (localhost du poste, port tiré de l'env `PORT`) : aucune URL fournie par
 *    l'utilisateur n'est jamais acceptée (anti-SSRF), et l'appel est **refusé
 *    sans aucun trafic réseau** quand les marqueurs desktop (`SYNC_TOKEN` ET
 *    `DEVICE_ID`) sont absents — une session web ne peut pas auto-DoSer le
 *    serveur local ;
 *  - la clinic active est résolue **une seule fois** par requête : la page
 *    `/settings/sync` consomme `overview.clinicId` (résolu + vérifié ici) au
 *    lieu de re-exécuter `requireCurrentClinic` (double requête membership).
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
  type PendingMerge,
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
  /**
   * `true` → la paire n'appartient **pas** entièrement au cabinet courant
   * (revue `cross-clinic` ou revue incomplète) : `candidate`/`existing` sont
   * alors `null` et `reason` porte un résumé générique. **Jamais** l'identité
   * (`toParty`) d'un patient d'un autre cabinet n'est exposée.
   */
  readonly identityMasked: boolean;
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
  /**
   * Cabinet actif, **résolu et vérifié ici** (cookie + membership) : la page
   * le consomme directement au lieu d'exécuter une seconde fois
   * `requireCurrentClinic` (une seule requête membership par requête).
   */
  readonly clinicId: string;
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
 *
 * La clinic active est résolue **ici, une seule fois** (cookie + membership) et
 * renvoyée dans `clinicId` : la page n'a plus besoin d'exécuter un second
 * `requireCurrentClinic` (double requête membership par requête).
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

  // Enrichissement nom/naissance — **filtré sur LES DEUX parties du cabinet
  // courant** : une revue concernant un autre tenant n'est jamais exposée à cet
  // utilisateur (le moteur crée délibérément des revues `cross-clinic`, paires
  // de deux cabinets distincts — BLOQUANT 1 : fuite d'identité inter-cabinets).
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

  const merges: SyncMergeItem[] = pendingMerges.map((m) => {
    const candidateRow = patientsById.get(m.candidateId);
    const canonicalRow = patientsById.get(m.canonicalId);
    // LES DEUX parties (candidat ET canonique) doivent être dans le cabinet
    // courant pour afficher une identité — sinon : entrée résumée, sans `toParty`.
    const bothInCurrentClinic =
      candidateRow !== undefined &&
      canonicalRow !== undefined &&
      candidateRow.clinicId === clinicId &&
      canonicalRow.clinicId === clinicId;

    const base = {
      id: m.id,
      candidateId: m.candidateId,
      canonicalId: m.canonicalId,
      decidedAt: m.decidedAt.toISOString(),
    };

    if (bothInCurrentClinic) {
      return {
        ...base,
        reason: m.reason,
        identityMasked: false,
        candidate: toParty(candidateRow),
        existing: toParty(canonicalRow),
      };
    }

    // Paire hors cabinet (revue `cross-clinic`) ou revue incomplète : entrée
    // **résumée sans identité** — utile à l'opérateur (il sait qu'une revue
    // existe) sans jamais dévoiler prénom / nom / naissance d'un autre cabinet.
    // Les identifiants restent ceux de la file (`sync_conflict`) : métadonnées
    // opaques déjà exposées telles quelles par le journal D-4 device-wide, et
    // les deux actions de revue refusent ces paires (garde d'écriture).
    const rowsExist = candidateRow !== undefined && canonicalRow !== undefined;
    return {
      ...base,
      reason: rowsExist
        ? "Doublon inter-cabinets détecté : identités masquées."
        : "Revue de fusion incomplète : identités masquées.",
      identityMasked: true,
      candidate: null,
      existing: null,
    };
  });

  return { clinicId, pendingCount, failedCount, conflicts, merges };
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
 * Charge la revue `reviewId` **et** vérifie que LA PAIRE (candidat ET
 * canonique) appartient au cabinet `clinicId`.
 *
 * Garde d'écriture multi-tenant (BLOQUANT 2) : `resolveMerge` clôture n'importe
 * quelle ligne de `sync_conflict` par son seul `id` — sans cette vérification,
 * un utilisateur du cabinet A pourrait **disqualifier silencieusement** la revue
 * du cabinet B.
 *
 * `null` = revue inconnue, déjà clôturée, revue illisible (canonique absent) ou
 * paire hors cabinet : **tous ces cas partagent le même message générique** côté
 * action (aucun oracle d'énumération sur l'existence d'une revue d'un autre
 * tenant).
 */
async function loadReviewInClinic(
  reviewId: string,
  clinicId: string,
): Promise<PendingMerge | null> {
  const review = (await listPendingMerges(createMergeDbRepo(db))).find(
    (row) => row.id === reviewId,
  );
  if (review === undefined) return null;

  const ids = [...new Set([review.candidateId, review.canonicalId])].filter((id) => id.length > 0);
  if (ids.length === 0) return null;

  const rows = await db
    .select({ id: patients.id, clinicId: patients.clinicId })
    .from(patients)
    .where(inArray(patients.id, ids));
  const clinicById = new Map(rows.map((row) => [row.id, row.clinicId]));

  const bothInClinic = [review.candidateId, review.canonicalId].every(
    (id) => clinicById.get(id) === clinicId,
  );
  return bothInClinic ? review : null;
}

/**
 * Clore une entrée de revue **sans** fusionner (« Ignorer » — `resolveMerge`).
 *
 * Multi-tenant : la revue est **chargée** puis sa paire (candidat/canonique)
 * vérifiée dans le cabinet actif avant toute écriture — sinon réponse
 * `{ success: false }` générique (jamais de révélation sur l'existence d'une
 * revue d'un autre cabinet). Une revue déjà clôturée ou absente de la file
 * renvoie donc le même refus générique.
 */
export async function resolveMergeAction(id: string): Promise<SyncActionResult> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) {
    return { success: false, error: "Identifiant de revue invalide." };
  }
  const user = await requireAuth();
  const clinicId = await requireCurrentClinic();

  let review: PendingMerge | null;
  try {
    review = await loadReviewInClinic(parsed.data, clinicId);
  } catch {
    return { success: false, error: "Enregistrement impossible (base de données indisponible)." };
  }
  if (review === null) {
    return { success: false, error: "Revue introuvable dans ce cabinet." };
  }

  try {
    await resolveMerge(createMergeDbRepo(db), {
      id: review.id,
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
 * sinon refus net avant tout appel au moteur ; pareil pour la revue d'origine
 * (`reviewId`) : sa paire est chargée et **re-vérifiée dans le cabinet actif**
 * avant toute clôture (jamais de clôture d'une revue d'un autre cabinet).
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

  // Clôture d'origine (BLOQUANT 2) : la revue est CHARGÉE et sa paire vérifiée
  // dans le cabinet actif AVANT toute écriture — un `reviewId` appartenant à un
  // autre cabinet ne doit jamais être clos (refus générique, même message que
  // `resolveMergeAction` : aucune révélation sur l'existence de la revue).
  if (reviewId !== undefined) {
    let review: PendingMerge | null;
    try {
      review = await loadReviewInClinic(reviewId, clinicId);
    } catch {
      return { success: false, error: "Enregistrement impossible (base de données indisponible)." };
    }
    if (review === null) {
      return { success: false, error: "Revue introuvable dans ce cabinet." };
    }
  }

  // Clôture de la revue d'origine après succès — **best-effort** : la fusion
  // est déjà appliquée, un échec de clôture ne doit pas la signaler en échec.
  // La revue a été vérifiée ci-dessus (paire du cabinet actif) ; `resolveMerge`
  // est idempotent (`resolved_at IS NULL` en écriture conditionnelle).
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
 * Marqueurs d'une **installation desktop** : le serveur Next enfant de
 * l'application de bureau porte `SYNC_TOKEN` **et** `DEVICE_ID` (injectés par
 * `electron/env.ts`, cf. la route bootstrap qui exige les mêmes). Une session
 * web (`next dev`, hébergement public) n'en a aucun.
 */
function hasDesktopMarkers(): boolean {
  const token = process.env.SYNC_TOKEN?.trim() ?? "";
  const deviceId = process.env.DEVICE_ID?.trim() ?? "";
  return token.length > 0 && deviceId.length > 0;
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

  // Garde « desktop only » : hors application de bureau (marqueurs `SYNC_TOKEN`
  // ET `DEVICE_ID` absents de l'env du serveur), refus explicite et **aucun
  // appel réseau** — une session web authentifiée ne peut pas déclencher un
  // POST vers le serveur local (auto-DoS sans contre-mesure).
  if (!hasDesktopMarkers()) {
    return {
      success: false,
      error:
        "Amorçage réservé à l'application de bureau : jeton d'appareil absent sur ce serveur local.",
    };
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
