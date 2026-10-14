/**
 * Tâche 6.2 — FUSION DES DOUBLONS PATIENTS (décision D-5).
 *
 * ## Scénario
 *
 * Deux postes créent **hors-ligne** le même patient : à la synchronisation,
 * les deux lignes existent côté central (UUID différents). D-5 : fusion
 * **automatique par identifiant natif**, avec garde-fou — sinon on
 * fusionnerait deux personnes distinctes qui partagent un numéro de téléphone.
 *
 * ## Règle D-5 (implémentée par `evaluateDuplicate`, fonction PURE)
 *
 * 1. **Identifiant natif** (`patients` : `id` (UUID partagé), `email` — le
 *    schéma ne porte **pas** de numéro patient ; `phone` est lu mais **n'est
 *    jamais** un identifiant) ;
 *    - aucun identifiant commun → `none` (deux dossiers distincts) ;
 * 2. **Garde-fou obligatoire** — les DEUX conditions :
 *    - `lastName` + `firstName` **égaux** après normalisation
 *      (`NFC` + trim + espaces réduits + casse ignorée) ;
 *    - `dateOfBirth` **égale** (comparaison stricte) **et renseignée des deux
 *      côtés** (absence = échec fermé : on ne fusionne jamais sur l'incertitude) ;
 *    - garde-fou KO → `review` (revue humaine) ;
 * 3. **Horloge** : une ligne datée **dans le futur** (poste désynchronisé)
 *    → `review` plutôt qu'une fusion décidée sur une chronologie fausse.
 *
 * ⚠️ Le numéro de téléphone **ne déclenche jamais** une fusion : deux personnes
 * distinctes peuvent le partager (numéro familial, cabinet, réemployé).
 * `insuranceNumber` (numéro d'assuré) n'est pas retenu non plus : il
 * identifie l'assurance, pas le patient.
 *
 * ## Canonique — choix justifié
 *
 * Le canonique est la ligne **la plus ancienne `created_at`** (égalité
 * rompue par le plus petit `id`, pour rester déterministe). Justification :
 *  - c'est la ligne historique : elle porte le plus d'ancienneté de dossier ;
 *  - choisir « la ligne avec le plus de références » demanderait de
 *    balayer 14 tables d'enfants **pour un comptage qui serait immédiatement
 *    annulé** par la réorientation elle-même (raisonnement circulaire, coût
 *    disproportionné) ;
 *  - la règle est symétrique et reproductible sur les deux postes.
 *
 * ## Périmètre de la trace — LIMITE EXPLICITE
 *
 * La fusion est **journalisée localement uniquement** : `sync_merge` (index
 * unique sur `duplicate_id`) et le tombstone `patient.deleted_at`. **Rien
 * n'est poussé** : ni `sync_outbox` alimenté, ni appel réseau. Le serveur
 * central applique **sa propre** décision D-5 de son côté ; `sync_merge` sert
 * de trace locale consultable (`listPendingMerges` / `resolveMerge`), pas de
 * protocole. Corollaires assumés :
 *  - une opération `sync_outbox` encore `pending` sur le doublon n'est pas
 *    purgée ici (hors périmètre 6.2) : le central la rejettera proprement ;
 *  - la réconciliation des enfants est locale ; le central rafraîchit son état
 *    par ses propres tirages.
 *
 * ## Revue humaine (D-5 → D-4)
 *
 * Un refus de fusion (`action: "review"`) est **persisté** dans
 * `sync_conflict` sous `merge-review:…` : c'est cette file que lit
 * `listPendingMerges`, tranchée par `resolveMerge`. Aucune décision de fusion
 * n'est prise « dans le vide ».
 *
 * Conception (style `outbox.ts`) : logique pure, **repo injecté**
 * (`MergeRepo` + `MergeTx`), **toute la fusion dans UNE transaction**, tests
 * hermétiques sur repo mémoire. `createMergeDbRepo` est l'adaptateur Drizzle
 * (production), non couvert par les tests hermétiques.
 */

import { z } from "zod";
import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import {
  appointments,
  clinicalSessions,
  consultationNotes,
  dentalCharts,
  invoices,
  medicalHistoryEntries,
  odontogramStates,
  patients,
  payments,
  prescriptions,
  prosthesisOrders,
  quotes,
  radiographs,
  syncMerges,
  treatmentPlans,
  waitingRoomEntries,
} from "@/lib/db/schema";
import type { DesktopDb } from "@/lib/db/desktop-db";
import {
  createConflictsDbRepo,
  journalConflict,
  type ConflictEntry,
  type ConflictRepo,
} from "./conflict";

/* -------------------------------------------------------------------------- */
/* 1. Constantes                                                              */
/* -------------------------------------------------------------------------- */

/** Nom SQL du dossier patient (registre `TABLE_REGISTRY`). */
export const PATIENT_TABLE = "patient";

/** Préfixe des motifs de revue dans `sync_conflict` (file lue par `listPendingMerges`). */
export const MERGE_REVIEW_PREFIX = "merge-review:";

/** Tolérance d'horloge (postes hors-ligne rarement synchronisés) : 60 s. */
export const MERGE_CLOCK_TOLERANCE_MS = 60_000;

/** Motifs D-5 — stables : ils deviennent `sync_merge.reason` et la file de revue. */
const D5_REASON = {
  noNative: "d5 : aucun identifiant natif commun (le téléphone n'en est jamais un)",
  mergeId: "d5-id : identifiant natif « id » commun + garde-fou nom/prénom/naissance respecté",
  mergeEmail: "d5-email : adresse e-mail commune + garde-fou nom/prénom/naissance respecté",
  guardNameMissing: "d5-garde-fou : nom ou prénom manquant",
  guardNameDiffers: "d5-garde-fou : nom ou prénom différent",
  guardDobMissing: "d5-garde-fou : date de naissance absente",
  guardDobDiffers: "d5-garde-fou : date de naissance différente",
  clockSkew: "d5-horloge : ligne créée après l'horloge du poste — fusion différée à la revue",
  selfMerge: "d5 : même identifiant — aucune réorientation nécessaire",
} as const;

/* -------------------------------------------------------------------------- */
/* 2. Types                                                                    */
/* -------------------------------------------------------------------------- */

/** Ligne patient réduite aux champs de la décision D-5 (lecture seule). */
export interface PatientCandidate {
  id: string;
  clinicId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  email: string | null;
  /** Présent pour prouver qu'il n'entre **jamais** dans la décision. */
  phone?: string | null;
  createdAt: Date;
}

export type MergeDecision =
  | { action: "merge"; canonicalId: string; duplicateId: string; reason: string }
  /** Garde-fou (ou horloge) en échec → revue humaine. */
  | { action: "review"; reason: string }
  /** Aucun identifiant natif commun : deux dossiers distincts, rien à faire. */
  | { action: "none"; reason: string };

/** Comptage de la réorientation, par table SQL enfant. */
export interface RepointReport {
  total: number;
  byTable: Record<string, number>;
}

/** Ligne `sync_merge` (trace locale d'une fusion appliquée). */
export interface MergeRecord {
  id: string;
  canonicalId: string;
  duplicateId: string;
  reason: string | null;
  mergedAt: Date;
}

export type NewMergeRecord = Omit<MergeRecord, "reason"> & { reason: string };

/** Entrée de revue en attente d'un humain (source : `sync_conflict`). */
export interface PendingMerge {
  /** `sync_conflict.id` — identifiant rendu à `resolveMerge`. */
  id: string;
  /** Doublon pressenti (`row_id` de l'entrée). */
  candidateId: string;
  /** Ligne existante / canonique pressenti (`winning.id`, `""` si illisible). */
  canonicalId: string;
  /** Motif du garde-fou, **sans** le préfixe `merge-review:`. */
  reason: string;
  decidedAt: Date;
}

export interface MergeDuplicateParams {
  candidateId: string;
  existingId: string;
  now: Date;
  /** Motif imposé (revue humaine, cas particulier) ; défaut : motif D-5 déduit. */
  reason?: string;
}

export type MergeResult =
  | {
      status: "merged";
      canonicalId: string;
      duplicateId: string;
      mergeId: string;
      reason: string;
      children: RepointReport;
    }
  /** Déjà fusionné (2ᵉ appel) — l'index unique `uq_sync_merge_duplicate_id` garantit la paire. */
  | { status: "already-merged"; canonicalId: string; duplicateId: string }
  /** Même `id` des deux côtés : la même ligne, rien à réorienter. */
  | { status: "self-merge"; id: string }
  | { status: "review"; candidateId: string; existingId: string; reason: string; reviewId: string }
  | { status: "none"; reason: string }
  | { status: "not-found"; missing: string[] };

/* -------------------------------------------------------------------------- */
/* 3. Repo injecté                                                             */
/* -------------------------------------------------------------------------- */

/** Transaction : **toutes** les écritures d'une fusion y passent (contract). */
export interface MergeTx {
  getPatient(id: string): Promise<PatientCandidate | null>;
  getMerge(duplicateId: string): Promise<MergeRecord | null>;
  /** Idempotent par `uq_sync_merge_duplicate_id` (conflit ignoré). */
  insertMerge(record: NewMergeRecord): Promise<void>;
  /** Reroute les 14 tables enfants ; renvoie le comptage par table. */
  repointChildren(fromId: string, toId: string): Promise<RepointReport>;
  /** Pose le tombstone du doublon (`deleted_at`). */
  tombstonePatient(id: string, at: Date): Promise<void>;
  /** Journal `sync_conflict` — file de revue des fusions refusées (D-4). */
  conflicts: ConflictRepo;
}

export interface MergeRepo {
  /** Une transaction = une fusion entière ou rien (rollback intégral). */
  transaction<T>(fn: (tx: MergeTx) => Promise<T>): Promise<T>;
}

/* -------------------------------------------------------------------------- */
/* 4. Validation Zod                                                           */
/* -------------------------------------------------------------------------- */

export const mergeDuplicateParamsSchema = z.object({
  candidateId: z.string().min(1),
  existingId: z.string().min(1),
  now: z.date(),
  reason: z.string().min(1).max(1_000).optional(),
});

export const mergeResolveParamsSchema = z.object({
  id: z.string().min(1),
  resolvedBy: z.string().min(1).max(256),
  resolvedAt: z.date().optional(),
});

export const mergeListOptionsSchema = z.object({
  limit: z.number().int().positive().max(1_000).optional(),
});

export interface MergeResolveParams {
  id: string;
  resolvedBy: string;
  resolvedAt?: Date;
}

/* -------------------------------------------------------------------------- */
/* 5. Décision pure                                                            */
/* -------------------------------------------------------------------------- */

/** Normalisation identitaire : NFC, trim, espaces réduits, casse ignorée. */
function normalizeIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function emailsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeIdentity(a);
  const right = normalizeIdentity(b);
  return left.length > 0 && left === right;
}

/** Garde-fou : `null` = passe, sinon le motif de `review` (échec fermé). */
function guardReason(candidate: PatientCandidate, existing: PatientCandidate): string | null {
  const candidateFirst = normalizeIdentity(candidate.firstName);
  const candidateLast = normalizeIdentity(candidate.lastName);
  const existingFirst = normalizeIdentity(existing.firstName);
  const existingLast = normalizeIdentity(existing.lastName);
  if (
    candidateFirst.length === 0 ||
    candidateLast.length === 0 ||
    existingFirst.length === 0 ||
    existingLast.length === 0
  ) {
    return D5_REASON.guardNameMissing;
  }
  if (candidateFirst !== existingFirst || candidateLast !== existingLast) {
    return D5_REASON.guardNameDiffers;
  }
  const candidateDob = candidate.dateOfBirth;
  const existingDob = existing.dateOfBirth;
  if (candidateDob === null || existingDob === null) {
    return D5_REASON.guardDobMissing;
  }
  if (candidateDob.getTime() !== existingDob.getTime()) {
    return D5_REASON.guardDobDiffers;
  }
  return null;
}

function isFuture(at: Date, now: Date): boolean {
  return at.getTime() > now.getTime() + MERGE_CLOCK_TOLERANCE_MS;
}

/**
 * **Canonique** : la ligne la plus ancienne `created_at`, égalité rompue par
 * le plus petit `id` (déterministe, donc reproductible sur tous les postes).
 */
export function chooseCanonical(
  left: PatientCandidate,
  right: PatientCandidate,
): PatientCandidate {
  if (left.createdAt.getTime() !== right.createdAt.getTime()) {
    return left.createdAt.getTime() < right.createdAt.getTime() ? left : right;
  }
  return left.id <= right.id ? left : right;
}

/**
 * Décision **pure** D-5 (aucune I/O) : identifiant natif → garde-fou → horloge.
 *
 * @param candidate doublon pressenti (lignée entrante)
 * @param existing  ligne déjà présente
 * @param now       horloge du poste (jetée si caduque)
 */
export function evaluateDuplicate(
  candidate: PatientCandidate,
  existing: PatientCandidate,
  now: Date,
): MergeDecision {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("sync/merge : horloge `now` caduque (Date invalide).");
  }

  /* 1 — identifiant natif : `id` (UUID partagé) ou `email`. `phone` IGNORE. */
  const sameId = candidate.id.length > 0 && candidate.id === existing.id;
  const sameEmail = emailsMatch(candidate.email, existing.email);
  if (!sameId && !sameEmail) {
    return { action: "none", reason: D5_REASON.noNative };
  }

  /* 2 — garde-fou obligatoire : nom + prénom + date de naissance. */
  const guard = guardReason(candidate, existing);
  if (guard !== null) {
    return { action: "review", reason: guard };
  }

  /* 3 — horloge de poste : jamais de fusion décidée sur une chronologie fausse. */
  if (isFuture(candidate.createdAt, now) || isFuture(existing.createdAt, now)) {
    return { action: "review", reason: D5_REASON.clockSkew };
  }

  const canonical = chooseCanonical(candidate, existing);
  const duplicate = canonical.id === candidate.id ? existing : candidate;
  return {
    action: "merge",
    canonicalId: canonical.id,
    duplicateId: duplicate.id,
    reason: sameId ? D5_REASON.mergeId : D5_REASON.mergeEmail,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. Fusion transactionnelle                                                  */
/* -------------------------------------------------------------------------- */

/** Publie la décision `review` dans `sync_conflict` (mode `unresolved` : une seule ligne par paire). */
async function recordReview(
  tx: MergeTx,
  candidate: PatientCandidate,
  existing: PatientCandidate,
  reason: string,
  now: Date,
): Promise<string> {
  const entry: ConflictEntry = {
    table: PATIENT_TABLE,
    rowId: candidate.id,
    // L'identité du dossier ne dépend pas du poste : la paire (canonique,
    // doublon) porte la revue, `deviceId` reste absent pour dédupliquer
    // quel que soit le poste qui remonte le refus.
    reason: `${MERGE_REVIEW_PREFIX}${reason}`,
    // Gagnant pressenti = ligne déjà présente ; perdant = doublon pressenti.
    winning: existing,
    losing: candidate,
  };
  const outcome = await journalConflict(tx.conflicts, entry, now, {
    mode: "unresolved",
    id: crypto.randomUUID(),
  });
  return outcome.id;
}

/**
 * Applique une fusion D-5 : décision (garde-fou inclus) → réorientation des
 * enfants → tombstone du doublon → trace `sync_merge`, **dans une seule
 * transaction**.
 *
 * Idempotent : un second appel détecte `uq_sync_merge_duplicate_id` et renvoie
 * `already-merged` sans rien réécrire. Jamais de push (voir en-tête).
 */
export async function mergeDuplicatePatients(
  repo: MergeRepo,
  params: MergeDuplicateParams,
): Promise<MergeResult> {
  const parsed = mergeDuplicateParamsSchema.parse(params);

  return repo.transaction(async (tx) => {
    const candidate = await tx.getPatient(parsed.candidateId);
    const existing = await tx.getPatient(parsed.existingId);
    if (candidate === null || existing === null) {
      const missing: string[] = [];
      if (candidate === null) missing.push(parsed.candidateId);
      if (existing === null) missing.push(parsed.existingId);
      return { status: "not-found" as const, missing };
    }

    const decision = evaluateDuplicate(candidate, existing, parsed.now);
    if (decision.action === "none") {
      return { status: "none" as const, reason: decision.reason };
    }
    if (decision.action === "review") {
      const reviewId = await recordReview(tx, candidate, existing, decision.reason, parsed.now);
      return {
        status: "review" as const,
        candidateId: parsed.candidateId,
        existingId: parsed.existingId,
        reason: decision.reason,
        reviewId,
      };
    }

    let canonicalId = decision.canonicalId;
    const duplicateId = decision.duplicateId;

    if (canonicalId === duplicateId) {
      return { status: "self-merge" as const, id: canonicalId };
    }

    // Déjà tranché (rejeu, double déclenchement) : AUCUNE réécriture.
    const prior = await tx.getMerge(duplicateId);
    if (prior !== null) {
      return {
        status: "already-merged" as const,
        canonicalId: prior.canonicalId,
        duplicateId: prior.duplicateId,
      };
    }

    // Chaînage d'un niveau : le canonique pressenti a lui-même été fusionné —
    // on suit la trace pour ne pas recréer un orphelin pointant un tombstone.
    const root = await tx.getMerge(canonicalId);
    if (root !== null) {
      canonicalId = root.canonicalId;
    }

    const children = await tx.repointChildren(duplicateId, canonicalId);
    await tx.tombstonePatient(duplicateId, parsed.now);

    const mergeId = crypto.randomUUID();
    await tx.insertMerge({
      id: mergeId,
      canonicalId,
      duplicateId,
      reason: parsed.reason ?? decision.reason,
      mergedAt: parsed.now,
    });

    return {
      status: "merged" as const,
      canonicalId,
      duplicateId,
      mergeId,
      reason: parsed.reason ?? decision.reason,
      children,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* 7. Revue humaine                                                            */
/* -------------------------------------------------------------------------- */

function toPendingMerge(row: {
  id: string;
  rowId: string;
  winning: Record<string, unknown> | null;
  reason: string | null;
  decidedAt: Date;
}): PendingMerge {
  const raw = row.reason ?? "";
  const winningId = row.winning?.id;
  return {
    id: row.id,
    candidateId: row.rowId,
    canonicalId: typeof winningId === "string" ? winningId : "",
    reason: raw.startsWith(MERGE_REVIEW_PREFIX) ? raw.slice(MERGE_REVIEW_PREFIX.length) : raw,
    decidedAt: row.decidedAt,
  };
}

/**
 * Fusions en attente d'un humain : entrées `sync_conflict` de type
 * `merge-review:` **non résolues**, les plus récentes d'abord.
 */
export async function listPendingMerges(
  repo: MergeRepo,
  options: { limit?: number } = {},
): Promise<PendingMerge[]> {
  const { limit } = mergeListOptionsSchema.parse(options);
  const rows = await repo.transaction((tx) =>
    tx.conflicts.list({
      table: PATIENT_TABLE,
      unresolvedOnly: true,
      reasonPrefix: MERGE_REVIEW_PREFIX,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
  return rows.map(toPendingMerge);
}

/**
 * Clôture une entrée de revue (`resolved_by` + `resolved_at`, idempotent).
 *
 * Cette fonction **valide** la revue, elle ne fusionne pas : l'application
 * d'une fusion décidée à la main passe par `mergeDuplicatePatients` avec les
 * identifiants lus dans les payloads de l'entrée (voir `PendingMerge`).
 */
export async function resolveMerge(
  repo: MergeRepo,
  params: MergeResolveParams,
): Promise<void> {
  const parsed = mergeResolveParamsSchema.parse(params);
  await repo.transaction((tx) =>
    tx.conflicts.resolve(parsed.id, parsed.resolvedBy, parsed.resolvedAt ?? new Date()),
  );
}

/* -------------------------------------------------------------------------- */
/* 8. Inventaire des enfants réorientés                                        */
/* -------------------------------------------------------------------------- */

/**
 * **Inventaire réel** (lecture de `src/lib/db/schema/*`) : les 14 tables
 * portant une FK `patient_id NOT NULL … ON DELETE CASCADE` vers `patient`.
 *
 * Les petits-enfants (`invoice_item`, `quote_item`, `prescription_item`,
 * `clinical_session_item`, `treatment_plan_item`, `stock_transaction`) sont
 * rattachés par l'**id du parent**, que la réorientation ne change pas :
 * ils suivent sans réécriture.
 *
 * ⚠️ 3 de ces tables portent une contrainte unique **dépendant de
 * `patient_id`** : la réorientation doit d'abord libérer le slot occupé côté
 * doublon (voir `UNIQUE_SLOT_RECONCILIATIONS`), sinon la transaction sauterait
 * sur la contrainte.
 *  - `odontogram_state`   — `uq_odontogram_state_patient_clinic (patient_id, clinic_id)` ;
 *  - `waiting_room_entry` — `uq_waiting_room_active_patient_clinic … WHERE status IN ('waiting','called','in_treatment')` ;
 *  - `clinical_session`   — `uq_clinical_session_active_patient_clinic … WHERE status = 'in_progress'`.
 */
export const PATIENT_CHILD_TABLES: readonly { name: string; table: AnyPgTable }[] = [
  { name: "appointment", table: appointments },
  { name: "waiting_room_entry", table: waitingRoomEntries },
  { name: "clinical_session", table: clinicalSessions },
  { name: "consultation_note", table: consultationNotes },
  { name: "dental_chart", table: dentalCharts },
  { name: "medical_history_entry", table: medicalHistoryEntries },
  { name: "odontogram_state", table: odontogramStates },
  { name: "radiograph", table: radiographs },
  { name: "treatment_plan", table: treatmentPlans },
  { name: "prescription", table: prescriptions },
  { name: "invoice", table: invoices },
  { name: "quote", table: quotes },
  { name: "payment", table: payments },
  { name: "prosthesis_order", table: prosthesisOrders },
];

/**
 * Libération des slots uniques avant réorientation : la ligne du **canonique
 * gagne**, celle du doublon est supprimée (le doublon est un tombstone —
 * conserver son double interdirait la fusion et ferait échouer la
 * transaction entière).
 */
const UNIQUE_SLOT_RECONCILIATIONS: readonly ((fromId: string, toId: string) => SQL)[] = [
  // odontogram_state — unique (patient_id, clinic_id).
  (fromId, toId) => sql`
    delete from ${odontogramStates} d
    where d.patient_id = ${fromId}
      and exists (
        select 1 from ${odontogramStates} c
        where c.patient_id = ${toId} and c.clinic_id = d.clinic_id
      )`,
  // waiting_room_entry — unique (patient_id, clinic_id) sur les statuts actifs.
  (fromId, toId) => sql`
    delete from ${waitingRoomEntries} d
    where d.patient_id = ${fromId}
      and d.status in ('waiting', 'called', 'in_treatment')
      and exists (
        select 1 from ${waitingRoomEntries} c
        where c.patient_id = ${toId}
          and c.clinic_id = d.clinic_id
          and c.status in ('waiting', 'called', 'in_treatment')
      )`,
  // clinical_session — unique (patient_id, clinic_id) sur la session ouverte.
  (fromId, toId) => sql`
    delete from ${clinicalSessions} d
    where d.patient_id = ${fromId}
      and d.status = 'in_progress'
      and exists (
        select 1 from ${clinicalSessions} c
        where c.patient_id = ${toId}
          and c.clinic_id = d.clinic_id
          and c.status = 'in_progress'
      )`,
];

/* -------------------------------------------------------------------------- */
/* 9. Implémentation SQL (Drizzle) — chemin de production                      */
/* -------------------------------------------------------------------------- */

/** Transaction Drizzle réelle, dérivée de l'instance du poste. */
export type MergeTxDb = Parameters<Parameters<DesktopDb["transaction"]>[0]>[0];

function createMergeTx(tx: MergeTxDb): MergeTx {
  return {
    async getPatient(id) {
      const rows = await tx.select().from(patients).where(eq(patients.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        clinicId: row.clinicId,
        firstName: row.firstName,
        lastName: row.lastName,
        dateOfBirth: row.dateOfBirth,
        email: row.email,
        phone: row.phone,
        createdAt: row.createdAt,
      };
    },

    async getMerge(duplicateId) {
      const rows = await tx
        .select()
        .from(syncMerges)
        .where(eq(syncMerges.duplicateId, duplicateId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        canonicalId: row.canonicalId,
        duplicateId: row.duplicateId,
        reason: row.reason,
        mergedAt: row.mergedAt,
      };
    },

    async insertMerge(record) {
      await tx
        .insert(syncMerges)
        .values({
          id: record.id,
          tableName: PATIENT_TABLE,
          canonicalId: record.canonicalId,
          duplicateId: record.duplicateId,
          reason: record.reason,
          mergedAt: record.mergedAt,
        })
        // Index unique sur `duplicate_id` : la trace est idempotente par nature.
        .onConflictDoNothing({ target: syncMerges.duplicateId });
    },

    async repointChildren(fromId, toId) {
      const byTable: Record<string, number> = {};
      let total = 0;

      // 1) libération des slots uniques (la ligne du canonique gagne) ;
      for (const reconciliation of UNIQUE_SLOT_RECONCILIATIONS) {
        await tx.execute(reconciliation(fromId, toId));
      }

      // 2) réorientation de chaque table enfant (valeurs liées, jamais concaténées).
      for (const child of PATIENT_CHILD_TABLES) {
        const rows = await tx
          .select({ total: sql<number>`count(*)::int` })
          .from(child.table)
          .where(sql`patient_id = ${fromId}`);
        const count = rows[0]?.total ?? 0;
        if (count > 0) {
          await tx.execute(
            sql`update ${child.table} set patient_id = ${toId} where patient_id = ${fromId}`,
          );
        }
        byTable[child.name] = count;
        total += count;
      }
      return { total, byTable };
    },

    async tombstonePatient(id, at) {
      await tx
        .update(patients)
        .set({ deletedAt: at, updatedAt: at })
        .where(eq(patients.id, id));
    },

    conflicts: createConflictsDbRepo(tx),
  };
}

/**
 * Repo Drizzle de production : `mergeDuplicatePatients(createMergeDbRepo(db), …)`
 * avec `db` l'instance du poste (`getDesktopDb()`). Toutes les écritures
 * (enfants, tombstone, `sync_merge`, revue) partagent la **même** transaction
 * PostgreSQL — un échec annule la fusion entière.
 *
 * Non couvert par les tests hermétiques (repo mémoire en test) : validé par la
 * suite d'intégration / E2E, comme `local-apply.ts`.
 */
export function createMergeDbRepo(database: DesktopDb): MergeRepo {
  return {
    async transaction(fn) {
      return database.transaction(async (tx) => fn(createMergeTx(tx)));
    },
  };
}
