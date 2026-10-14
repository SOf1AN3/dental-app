/**
 * Tâche 6.1c — Allocateur de numéros de documents des postes **blocs**
 * (décision D-4, mode desktop).
 *
 * ## Pourquoi ce module existe
 *
 * Les actions de création de documents (`createQuote`, `createInvoice`,
 * `convertQuoteToInvoice`, `closeSession`, `createOrder`) incrémentaient
 * `document_sequence.last_number` en dur : sur un poste **desktop hors-ligne**,
 * deux postes incrémentant leur copie locale produiraient les **mêmes numéros**
 * — des doublons de factures imprimés, irréparables. La numérotation par blocs
 * (`src/lib/sync/numbering.ts`) existait mais n'était pas câblée : ce module
 * est le **pont** entre les actions et ce mécanisme.
 *
 * ## Deux modes, distingués par `process.env.DEVICE_ID`
 *
 *  - **mode web** (Vercel, dev classique — `DEVICE_ID` absent) : les actions
 *    gardent leur chimie historique `last_number + 1`, **strictement
 *    inchangée** (aucune régression) ;
 *  - **mode desktop / blocs** (`DEVICE_ID` présent) : les actions appellent
 *    {@link allocateDocumentNumber}, qui peut **refuser explicitement**.
 *
 * Le jeton d'appareil vit dans `userData/config.json` (chiffré DPAPI, inconnu
 * du serveur Next) : il est **injecté en env** (`SYNC_TOKEN`) dans l'enfant
 * Next par `electron/env.ts`, puis lu ici via {@link AllocateDeps}.
 *
 * ## Flux ({@link allocateDocumentNumber})
 *
 *  1. **chemin chaud** : {@link allocateLocalNumber} (1 lecture, 0 appel
 *     réseau) → succès = numéro retourné immédiatement ;
 *  2. bloc épuisé **ou** aucun bloc → réservation sur le central
 *     (`POST {baseUrl}/api/sync/blocks`, corps `{ clinicId, type, size: 50,
 *     cursor: <last_number local> }`, `Authorization: Bearer <syncToken>`,
 *     timeout borné à 15 s). Configuration incomplète (`baseUrl` / `deviceId` /
 *     `syncToken` absent) → `{ ok: false, reason: "no-block-available" }` :
 *     **jamais** d'incrément improvisé ;
 *  3. réservation réussie → **`consumeBlockReservation` PUIS `storeBlock`**
 *     (ordre obligatoire : `storeBlock` refuse de remplacer un bloc encore
 *     `reserved` — revue 6.1b mineur 1) puis **nouvelle** tentative locale ;
 *  4. second échec → `no-block-available` : la boucle est bornée à **un**
 *     renouvellement ;
 *  5. l'exception CAS d'{@link allocateLocalNumber} (curseur contesté 3 fois)
 *     → `no-block-available` (refus lisible, jamais une erreur 500 muette) ;
 *  6. **zéro écriture** quand on refuse (aucune écriture de curseur, de bloc
 *     ni de séquence n'est produite sur un refus).
 *
 * ## Note sur `not-a-device`
 *
 * Raison déclarée au contrat (poste appelant sans identifiant d'appareil) mais
 * **non retournée à ce jour** : les actions n'invoquent l'allocateur qu'en
 * mode blocs (`DEVICE_ID` présent), et le flow contractualisé refuse toute
 * configuration de réservation incomplète en `no-block-available`. Le libellé
 * associé existe donc dès qu'un appelant la méritera.
 *
 * Module **pur** : aucune lecture directe de `process.env`, aucune base — tout
 * est injecté ({@link AllocateDeps}), testable hermétiquement
 * (`allocate-number.test.ts` : repo mémoire + `fetchImpl` stubbé).
 */

import { z } from "zod";
import {
  allocateLocalNumber,
  consumeBlockReservation,
  storeBlock,
  type NumberingRepo,
} from "./numbering";
import { redactError } from "./outbox";

/* -------------------------------------------------------------------------- */
/* Types publics                                                               */
/* -------------------------------------------------------------------------- */

/** Frontière I/O injectée — repo mémoire dans les tests, Drizzle en prod. */
export interface AllocateDeps {
  /** Repo **local** de `document_sequence` (repo Drizzle : `createNumberingDbRepo`). */
  numbering: NumberingRepo;
  fetchImpl: typeof fetch;
  /** Origine du serveur central (`SYNC_BASE_URL`), `undefined` = absente. */
  baseUrl: string | undefined;
  /** Identifiant d'appareil (`DEVICE_ID`), `undefined` = absent. */
  deviceId: string | undefined;
  /** Jeton d'appareil (`SYNC_TOKEN`, injecté par `electron/env.ts`). */
  syncToken: string | undefined;
  now(): Date;
  /** Journalisation **sans secret** (jeton, URL complète, corps). */
  logger?: { warn(m: string): void };
}

/**
 * Résultat d'allocation d'un numéro de document (mode blocs).
 *  - `no-block-available`    → aucun bloc disponible et pas de réservation
 *                              possible (hors-ligne / config incomplète /
 *                              renouvellement resté sans effet) ;
 *  - `reservation-failed`    → le central a refusé ou été injoignable
 *                              (HTTP 401/403/4xx/5xx, réseau, timeout) ;
 *  - `no-clinic` / `unknown-type` → reportés tels quels de
 *                              {@link allocateLocalNumber} ;
 *  - `not-a-device`          → voir la note d'en-tête (non retourné aujourd'hui).
 */
export type AllocateDocumentResult =
  | { ok: true; number: number }
  | {
      ok: false;
      reason:
        | "not-a-device"
        | "no-block-available"
        | "reservation-failed"
        | "no-clinic"
        | "unknown-type";
    };

/** Raisons de refus (facilite les `Record<…, string>` d'messages). */
export type AllocateFailureReason = Extract<
  AllocateDocumentResult,
  { ok: false }
>["reason"];

/* -------------------------------------------------------------------------- */
/* Messages d'exposition utilisateur (partagés par les 5 sites)                */
/* -------------------------------------------------------------------------- */

const ALLOCATE_FAILURE_MESSAGES: Record<AllocateFailureReason, string> = {
  "not-a-device":
    "Numérotation par blocs réservée aux postes enregistrés : identifiant d'appareil absent.",
  "no-block-available":
    "Numérotation indisponible hors-ligne : connectez-vous pour réserver un bloc de numéros.",
  "reservation-failed":
    "Échec de la réservation du bloc de numéros auprès du serveur central : vérifiez votre connexion puis réessayez.",
  "no-clinic":
    "Aucune séquence de numérotation pour ce cabinet sur ce poste : synchronisez d'abord les données du cabinet.",
  "unknown-type":
    "Type de document non numérotable : opération refusée (erreur interne).",
};

/**
 * Message actionnable par raison de refus — les actions le replacent dans
 * **leur** mécanisme d'erreur existant (`{ error: { general: [message] } }` ou
 * `{ error: message }`), sans changer leur contrat de retour.
 */
export function allocateNumberErrorMessage(reason: AllocateFailureReason): string {
  return ALLOCATE_FAILURE_MESSAGES[reason];
}

/* -------------------------------------------------------------------------- */
/* Pont env → deps (appelé uniquement en mode blocs)                           */
/* -------------------------------------------------------------------------- */

/**
 * Détection du **mode blocs** : `DEVICE_ID` présent = poste desktop (l'appareil
 * a une identité et peut réserver des blocs) ; absent = Vercel / dev classique,
 * où les actions gardent leur chimie historique `last_number + 1`.
 */
export function isBlockNumberingMode(): boolean {
  return Boolean(process.env.DEVICE_ID);
}

/**
 * Construit les deps depuis `process.env` — réservé aux actions qui ont déjà
 * vérifié {@link isBlockNumberingMode}. Les valeurs sont
 * **re-lues à chaque appel** : le jeton peut changer pendant la vie du
 * processus (voir `electron/env.ts` : redémarrage de l'enfant Next géré à
 * l'étape 7). `fetch` est refermé dans une flèche : aucun `this` global
 * implicite.
 */
export function createDeviceAllocateDeps(numbering: NumberingRepo): AllocateDeps {
  return {
    numbering,
    fetchImpl: (input, init) => fetch(input, init),
    baseUrl: process.env.SYNC_BASE_URL,
    deviceId: process.env.DEVICE_ID,
    syncToken: process.env.SYNC_TOKEN,
    now: () => new Date(),
    logger: console,
  };
}

/* -------------------------------------------------------------------------- */
/* Réservation sur le serveur central                                          */
/* -------------------------------------------------------------------------- */

/** Taille d'un bloc réservé (même valeur que `DEFAULT_BLOCK_SIZE` de la route). */
export const BLOCK_RESERVATION_SIZE = 50;

/**
 * Timeout borné de la réservation (même valeur que le push/pull) : un poste
 * qui attend ne peut pas créer de document — mieux vaut un refus lisible.
 */
export const RESERVATION_TIMEOUT_MS = 15_000;

/** Corps contractuel de `POST /api/sync/blocks` (200). */
const reservationResponseSchema = z
  .object({
    blockStart: z.number().int().min(1),
    blockEnd: z.number().int().min(1),
    clinicId: z.string().min(1),
    type: z.string().min(1),
  })
  .refine((reservation) => reservation.blockEnd >= reservation.blockStart, {
    message: "bornes de bloc incohérentes (blockEnd < blockStart)",
  });

type ReservationBounds = Pick<
  z.infer<typeof reservationResponseSchema>,
  "blockStart" | "blockEnd"
>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `""` et `undefined` sont des absences (jamais transmis au central). */
function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value !== "" ? value : null;
}

/**
 * Réserve un bloc `[blockStart … blockEnd]` sur le central — **I/O seule** :
 * aucune écriture locale ici (l'appelant consomme puis stocke, dans cet ordre).
 *
 * @returns les bornes réservées, ou `null` (réseau, 401/403/4xx/5xx, corps non
 * conforme ou hors portée) — jamais de secret journalisé.
 */
async function requestBlockReservation(
  deps: AllocateDeps,
  params: {
    clinicId: string;
    type: string;
    /** `last_number` local — preuve d'épuisement transmise au central. */
    cursor: number;
    baseUrl: string;
    syncToken: string;
  },
): Promise<ReservationBounds | null> {
  const { fetchImpl, logger } = deps;

  let response: Response;
  try {
    response = await fetchImpl(`${params.baseUrl}/api/sync/blocks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.syncToken}`,
      },
      body: JSON.stringify({
        clinicId: params.clinicId,
        type: params.type,
        size: BLOCK_RESERVATION_SIZE,
        cursor: params.cursor,
      }),
      signal: AbortSignal.timeout(RESERVATION_TIMEOUT_MS),
    });
  } catch (error) {
    // Réseau absent / timeout borné (15 s) / DNS… `redactError` retire les
    // `Bearer`, `token=`, `password=` éventuellement présents dans le message.
    logger?.warn(
      `sync/allocate-number : réservation de bloc impossible (${redactError(messageOf(error))})`,
    );
    return null;
  }

  if (!response.ok) {
    // 401 (jeton absent/expiré/révoqué), 403 (cabinet hors portée du jeton),
    // 400 (corps refusé), 500… → refus ; le détail interne ne quitte jamais le
    // central et aucun secret n'est journalisé ici.
    logger?.warn(
      `sync/allocate-number : réservation de bloc refusée (HTTP ${response.status})`,
    );
    return null;
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    logger?.warn(
      `sync/allocate-number : réponse de réservation illisible (${redactError(messageOf(error))})`,
    );
    return null;
  }

  const parsed = reservationResponseSchema.safeParse(raw);
  if (!parsed.success) {
    logger?.warn(
      "sync/allocate-number : réponse de réservation non conforme (bornes invalides) — refus",
    );
    return null;
  }
  // Garde de portée : le central ne peut pas renvoyer le bloc d'un autre
  // cabinet ou d'un autre type de document (réponse corrompue, route détournée).
  if (
    parsed.data.clinicId !== params.clinicId ||
    parsed.data.type !== params.type
  ) {
    logger?.warn(
      "sync/allocate-number : réponse de réservation hors portée (cabinet ou type inattendu) — refus",
    );
    return null;
  }
  return { blockStart: parsed.data.blockStart, blockEnd: parsed.data.blockEnd };
}

/* -------------------------------------------------------------------------- */
/* Allocation locale + exception CAS                                           */
/* -------------------------------------------------------------------------- */

type LocalAttempt =
  | { outcome: "ok"; number: number }
  | {
      outcome: "refused";
      reason: "block-exhausted" | "no-clinic" | "unknown-type";
    }
  /** Exception CAS (curseur contesté 3 fois) : violation d'invariant. */
  | { outcome: "cas-failed" };

/**
 * {@link allocateLocalNumber} + capture de son exception CAS : un refus
 * explicite vaut mieux qu'une erreur 500 muette remontée à l'utilisateur.
 */
async function attemptLocalAllocation(
  deps: AllocateDeps,
  params: { clinicId: string; type: string },
): Promise<LocalAttempt> {
  try {
    const result = await allocateLocalNumber(deps.numbering, params);
    if (result.ok) {
      return { outcome: "ok", number: result.number };
    }
    return { outcome: "refused", reason: result.reason };
  } catch (error) {
    // `allocateLocalNumber` ne lève QUE sur un curseur contesté de façon
    // persistante (3 relectures) : allocation refusée, aucun numéro inventé.
    deps.logger?.warn(
      `sync/allocate-number : allocation locale impossible (${redactError(messageOf(error))}) — refus`,
    );
    return { outcome: "cas-failed" };
  }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Alloue le prochain numéro de document d'un poste **blocs** (D-4).
 *
 * Voir l'en-tête du module pour le flux complet. Garde-fous absolus :
 *  - jamais d'incrément improvisé : toute configuration de réservation
 *    absente → refus ;
 *  - zéro écriture sur refus ;
 *  - boucle bornée à **un** renouvellement de bloc ;
 *  - le jeton n'apparaît jamais dans les journaux ni dans les erreurs.
 */
export async function allocateDocumentNumber(
  deps: AllocateDeps,
  params: { clinicId: string; type: string },
): Promise<AllocateDocumentResult> {
  const { numbering } = deps;

  // (1) Chemin chaud : allocation 100 % locale — 1 lecture, 0 appel réseau.
  const first = await attemptLocalAllocation(deps, params);
  if (first.outcome === "ok") {
    return { ok: true, number: first.number };
  }
  if (first.outcome === "cas-failed") {
    return { ok: false, reason: "no-block-available" };
  }
  if (first.reason === "unknown-type") {
    return { ok: false, reason: "unknown-type" };
  }
  // → "block-exhausted" ou "no-clinic" : un bloc doit être (ré)servé.

  // (2) Configuration de réservation — TOUTE pièce manquante refuse, sans
  //     écriture ni appel réseau : jamais de numéro inventé hors-ligne.
  const baseUrl = nonEmpty(deps.baseUrl);
  const deviceId = nonEmpty(deps.deviceId);
  const syncToken = nonEmpty(deps.syncToken);
  if (baseUrl === null || deviceId === null || syncToken === null) {
    return { ok: false, reason: "no-block-available" };
  }

  // (3) État local courant : fournit `cursor` (preuve d'épuisement) et les
  //     bornes du bloc à marquer `consumed`.
  const row = await numbering.findSequence(params.clinicId, params.type);
  const bounds = await requestBlockReservation(deps, {
    clinicId: params.clinicId,
    type: params.type,
    cursor: row?.lastNumber ?? 0,
    baseUrl,
    syncToken,
  });
  if (bounds === null) {
    return { ok: false, reason: "reservation-failed" };
  }

  // (4) ⚠️ Ordre OBLIGATOIRE : `consumeBlockReservation` PUIS `storeBlock` —
  //     `storeBlock` refuse de remplacer un bloc encore `reserved` (revue 6.1b,
  //     mineur 1) : le bloc épuisé doit d'abord être tracé `consumed`.
  if (row !== null && row.blockStart !== null && row.blockEnd !== null) {
    await consumeBlockReservation(numbering, {
      clinicId: params.clinicId,
      type: params.type,
      blockStart: row.blockStart,
      blockEnd: row.blockEnd,
    });
  }
  await storeBlock(numbering, {
    clinicId: params.clinicId,
    type: params.type,
    blockStart: bounds.blockStart,
    blockEnd: bounds.blockEnd,
    deviceId,
    reservedAt: deps.now(),
  });

  // (5) NOUVELLE tentative locale dans le bloc fraîchement installé — la
  //     boucle s'arrête ici quoi qu'il arrive (1 renouvellement maximum).
  const second = await attemptLocalAllocation(deps, params);
  if (second.outcome === "ok") {
    return { ok: true, number: second.number };
  }
  if (second.outcome === "refused" && second.reason === "unknown-type") {
    return { ok: false, reason: "unknown-type" };
  }
  if (second.outcome === "refused" && second.reason === "no-clinic") {
    // Inatteignable en normal (le bloc vient d'être stocké, ligne créée).
    return { ok: false, reason: "no-clinic" };
  }
  // "block-exhausted" persistant après renouvellement (le central a renvoyé un
  // bloc déjà épuisé, par ex.), ou CAS contesté : refus lisible, borné.
  return { ok: false, reason: "no-block-available" };
}
