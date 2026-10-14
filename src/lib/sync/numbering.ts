/**
 * Tâche 6.1 — Numérotation **locale** par blocs réservés (décision client D-4).
 *
 * ## Le problème
 *
 * `document_sequence.last_number` est un compteur atomique : il n'est
 * incrémentable que **côté central**. Par construction, il est inallocable
 * hors-ligne — deux postes créant une facture offline inventeraient le même
 * numéro, et l'erreur est irréparable une fois la facture imprimée.
 *
 * ## Le mécanisme (voir aussi le commentaire du schéma `documentSequences`)
 *
 *  1. le poste **réserve** un intervalle `[block_start … block_end]` sur le
 *     serveur central (`POST /api/sync/blocks`) puis le stocke localement via
 *     {@link storeBlock} ;
 *  2. il alloue ensuite ses numéros **sans réseau** avec
 *     {@link allocateLocalNumber} : le curseur local est `last_number`
 *     (`number = lastNumber + 1`, authorisé tant que `≤ block_end`) ;
 *  3. bloc épuisé → **`block-exhausted`** : le caller doit réserver un nouveau
 *     bloc, ou — hors-ligne — **refuser explicitement de créer le document**.
 *
 * ### Renvoi d'un bloc épuisé — argument `cursor` (tâche 6.1b)
 *
 * Lorsque {@link allocateLocalNumber} retourne `block-exhausted`, le bloc local
 * est vide : `row.lastNumber === row.blockEnd` (le curseur a atteint la borne
 * haute). Pour obtenir un **nouveau** bloc sur le central, le caller appelle
 * `POST /api/sync/blocks` en transmettant **`cursor = row.lastNumber`** (le
 * `last_number` local) dans le corps. Le serveur compare
 * `cursor ≥ block_end` : s'ils coincident, il marque l'ancien bloc `consumed`
 * et découpe un bloc **disjoint** suivant. Sans ce `cursor`, le serveur ne peut
 * pas distinguer un bloc épuisé d'un bloc encore plein et renverra le même
 * bloc (idempotence). Ce module n'écrit rien de plus : c'est au caller de
 * transmettre ce curseur.
 *
 * ## Invariants garantis par ce module
 *
 *  - **Jamais de numéro inventé** : aucune écriture n'est produite lorsque le
 *    bloc est épuisé (`lastNumber + 1 > blockEnd` → retour immédiat, zéro
 *    `advanceCursor`) ; aucun incrément au-delà de `block_end` ;
 *  - **Un bloc non épuisé n'est jamais écrasé** ({@link storeBlock} est
 *    idempotent et ne rétrécit jamais un bloc existant) : sinon les numéros
 *    déjà réservés (et peut-être imprimés) seraient perdus ;
 *  - **Deux postes ne peuvent pas produire le même numéro** : leurs blocs sont
 *    disjoints (découpés par le central sur un compteur `FOR UPDATE`), donc
 *    l'union des allocations reste sans doublon (test T-5).
 *
 * ## Choix du curseur local — `lastNumber` (et non une colonne dédiée)
 *
 * Relevé des usages de `documentSequences` (`git grep documentSequences`) :
 *  - `src/lib/actions/financial.ts` (devis + factures) : `last_number + 1`
 *    puis `String(seq.lastNumber).padStart(...)` → **le numéro du document** ;
 *  - `src/lib/actions/session.ts` (facture de séance) : idem ;
 *  - `src/lib/actions/prosthesis.ts` : `GREATEST(last_number + 1, lowestAvailable)`
 *    → `PRO-<année>-<lastNumber>` ;
 *  - `src/app/api/owner/export/route.ts` : simple export de la table.
 *
 * Tous ces usages traitent `lastNumber` comme « dernier numéro **émis** » :
 * c'est donc naturellement le curseur de consommation du bloc. Une colonne
 * dédiée créerait **deux curseurs divergents** (l'action qui écrirait
 * `lastNumber` pendant que le bloc suivrait `block_cursor`) et, à la première
 * divergence, des doublons — exactement le bug que D-4 veut éradiquer.
 * `lastNumber` est donc **le** curseur local du bloc.
 *
 * Module PUR : repo injecté, zéro I/O, zéro `console`, zéro `process.env` —
 * testable hermétiquement (`numbering.test.ts`, repo mémoire).
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* 1. Types de documents numérotables                                          */
/* -------------------------------------------------------------------------- */

export const SEQUENCE_TYPE_INVOICE = "invoice";
export const SEQUENCE_TYPE_QUOTE = "quote";

/** Prothèse : `prosthesis:<année>` (une séquence par année civile). */
const PROSTHESIS_SEQUENCE_TYPE = /^prosthesis:\d{4}$/;

/**
 * Vrai si `type` est un type de document **réellement numéroté** par
 * `document_sequence` (relevé du dépôt : `invoice`, `quote`,
 * `prosthesis:<année>`). Un type inconnu serait une fuite silencieuse de
 * numérotation → refus explicite (`unknown-type`).
 */
export function isKnownSequenceType(type: string): boolean {
  return (
    type === SEQUENCE_TYPE_INVOICE ||
    type === SEQUENCE_TYPE_QUOTE ||
    PROSTHESIS_SEQUENCE_TYPE.test(type)
  );
}

/** Schéma Zod du champ `type` — partagé par la route `/api/sync/blocks`. */
export const documentSequenceTypeSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isKnownSequenceType, {
    message: "type de document non numérotable (invoice | quote | prosthesis:<année>)",
  });

/* -------------------------------------------------------------------------- */
/* 2. Types publics                                                            */
/* -------------------------------------------------------------------------- */

export type BlockStatus = "reserved" | "consumed";

/** Ligne `document_sequence` vue par le poste (colonnes utiles aux blocs). */
export interface LocalSequenceRow {
  clinicId: string;
  type: string;
  /** Curseur local du bloc = dernier numéro émis (`0` = aucun numéro). */
  lastNumber: number;
  blockStart: number | null;
  blockEnd: number | null;
  blockDeviceId: string | null;
  blockStatus: BlockStatus | null;
  blockReservedAt: Date | null;
}

/**
 * Résultat d'allocation d'un numéro **local** (sans réseau).
 *  - `ok: true`  → `number` est libre dans le bloc, `remaining` = numéros restants
 *                 dans le bloc **après** cette allocation ;
 *  - `block-exhausted` → aucun numéro disponible : réserver un bloc, ou
 *                 **refuser la création du document** en offline ;
 *  - `no-clinic` → aucune ligne de séquence locale pour ce cabinet (le poste
 *                 n'a jamais réservé de bloc pour lui) ;
 *  - `unknown-type` → `type` hors des types réellement numérotés.
 */
export type NextNumberResult =
  | { ok: true; number: number; remaining: number }
  | { ok: false; reason: "block-exhausted" | "no-clinic" | "unknown-type" };

/** Paramètres d'installation d'un bloc réservé côté local. */
export interface StoreBlockParams {
  clinicId: string;
  type: string;
  blockStart: number;
  blockEnd: number;
  deviceId: string;
  /** Horodatage de la réservation (défaut : horloge du poste appelant). */
  reservedAt?: Date;
}

/** Écriture effective d'un bloc : bornes + détenteur + curseur aligné. */
export interface WriteBlockParams {
  clinicId: string;
  type: string;
  blockStart: number;
  blockEnd: number;
  deviceId: string;
  /** Horodatage de la réservation (toujours résolu avant l'écriture). */
  reservedAt: Date;
  /** Valeur à poser sur `last_number` (curseur local du bloc). */
  cursor: number;
}

/** Paramètres de marquage « bloc épuisé » (traçabilité). */
export interface ConsumeBlockParams {
  clinicId: string;
  type: string;
  blockStart: number;
  blockEnd: number;
}

/**
 * Frontière I/O injectée (repo **mémoire** dans les tests, repo SQL dans
 * l'application). Chaque écriture est **conditionnelle** : c'est le repo qui
 * garantit l'atomicité (`UPDATE … WHERE last_number = :from`), la couche pure
 * décide *quoi* écrire.
 */
export interface NumberingRepo {
  /** Ligne `document_sequence` locale, `null` si absente. */
  findSequence(clinicId: string, type: string): Promise<LocalSequenceRow | null>;
  /**
   * Curseur `last_number : from → to` **uniquement si `from` est toujours la
   * valeur courante** (compare-and-swap). Renvoie `false` si la ligne a été
   * modifiée entre-temps (course) : l'appelant re-lit et re-décide, il n'écrit
   * **jamais** de force.
   */
  advanceCursor(clinicId: string, type: string, from: number, to: number): Promise<boolean>;
  /**
   * Écrit/installe le bloc (`block_* = 'reserved'`) et pose le curseur `cursor`
   * sur `last_number`. Crée la ligne si elle n'existe pas.
   */
  writeBlock(params: WriteBlockParams): Promise<void>;
  /**
   * `block_status : 'reserved' → 'consumed'` **pour les bornes exactes du
   * bloc** (idempotent ; n'agit jamais sur un bloc déjà consommé ni sur un
   * bloc appartenant à d'autres bornes). Renvoie `false` si 0 ligne affectée.
   */
  markBlockConsumed(
    clinicId: string,
    type: string,
    blockStart: number,
    blockEnd: number,
  ): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* 3. allocateLocalNumber — allocation d'un numéro sans réseau                 */
/* -------------------------------------------------------------------------- */

/**
 * Nombre maximal de relectures en cas de curseur contesté (deux actions
 * locales simultanées). Chaque tour **relit** la ligne : la seule écriture
 * possible avance le curseur d'exactement 1, la boucle est donc bornée en
 * pratique. Au-delà : violation d'invariant (poste concurrent agressif) →
 * exception explicite plutôt qu'un faux numéro.
 */
const MAX_CAS_ATTEMPTS = 3;

/**
 * Alloue le prochain numéro **localement**, dans le bloc réservé du poste.
 *
 * - lecture du bloc local (`document_sequence` de ce poste) ;
 * - `number = lastNumber + 1` **≤ `blockEnd`** → écriture CAS du curseur,
 *   retour `{ ok: true }` ;
 * - sinon → `{ ok: false, reason: "block-exhausted" }` et **zéro écriture**
 *   (jamais d'incrément au-delà de `block_end`).
 *
 * @param repo repo injecté (aucune I/O dans ce module).
 */
export async function allocateLocalNumber(
  repo: NumberingRepo,
  params: { clinicId: string; type: string },
): Promise<NextNumberResult> {
  const { clinicId, type } = params;
  if (!isKnownSequenceType(type)) {
    return { ok: false, reason: "unknown-type" };
  }

  let row = await repo.findSequence(clinicId, type);
  if (row === null) {
    // Aucune ligne locale pour ce cabinet → aucun bloc ne peut exister.
    return { ok: false, reason: "no-clinic" };
  }

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const refreshed = await repo.findSequence(clinicId, type);
      if (refreshed === null) {
        return { ok: false, reason: "no-clinic" };
      }
      row = refreshed;
    }

    // Pas de bloc, ou bloc déjà consommé → épuisé (le caller réserve un bloc).
    if (row.blockStart === null || row.blockEnd === null) {
      return { ok: false, reason: "block-exhausted" };
    }
    if (row.blockStatus === "consumed") {
      return { ok: false, reason: "block-exhausted" };
    }

    const number = row.lastNumber + 1;
    // ⚠️ Garde absolue : au-delà de `block_end`, AUCUNE écriture.
    if (number > row.blockEnd) {
      return { ok: false, reason: "block-exhausted" };
    }

    const applied = await repo.advanceCursor(clinicId, type, row.lastNumber, number);
    if (applied) {
      return { ok: true, number, remaining: row.blockEnd - number };
    }
    // Curseur contesté → relecture (tour suivant).
  }

  throw new Error(
    "sync/numbering : curseur local contesté de façon persistante — allocation refusée (aucun numéro inventé).",
  );
}

/* -------------------------------------------------------------------------- */
/* 4. storeBlock — installation idempotente d'un bloc réservé                  */
/* -------------------------------------------------------------------------- */

/**
 * Stocke côté local le bloc `[blockStart … blockEnd]` réservé par `deviceId`
 * sur le central (réponse de `POST /api/sync/blocks`).
 *
 * Règles :
 *  - **idempotent** : rejouer un même bloc ne change rien (une seule écriture
 *    utile) ;
 *  - **ne rétrécit ni n'écrase jamais un bloc existant** : un bloc encore
 *    `reserved` (non épuisé) est intouchable — l'écraser ferait perdre des
 *    numéros déjà réservés/imprimés, et un bloc `consumed` n'est remplacé que
 *    par un bloc **strictement plus haut** ;
 *  - **aligne le curseur** : le premier numéro alloué dans le nouveau bloc est
 *    `blockStart`, sauf si le curseur local s'y trouve déjà (reprise) ou le
 *    dépasse déjà (jamais de retour en arrière → jamais de numéro recréé).
 *
 * @throws Error si les bornes sont incohérentes (erreur de programmation).
 */
export async function storeBlock(
  repo: NumberingRepo,
  params: StoreBlockParams,
): Promise<void> {
  const { clinicId, type, blockStart, blockEnd, deviceId } = params;
  if (!isKnownSequenceType(type)) {
    throw new Error(`sync/numbering : type de document non numérotable « ${type} ».`);
  }
  if (!Number.isInteger(blockStart) || !Number.isInteger(blockEnd) || blockEnd < blockStart) {
    throw new Error(
      `sync/numbering : bornes de bloc invalides [${blockStart}..${blockEnd}].`,
    );
  }
  if (blockStart < 1) {
    throw new Error(`sync/numbering : bornes de bloc invalides [${blockStart}..${blockEnd}].`);
  }

  const reservedAt = params.reservedAt ?? new Date();
  const existing = await repo.findSequence(clinicId, type);

  if (existing === null) {
    await repo.writeBlock({
      clinicId,
      type,
      blockStart,
      blockEnd,
      deviceId,
      reservedAt,
      cursor: blockStart - 1,
    });
    return;
  }

  // (a) Bloc non épuisé pour ce poste → intouchable (idempotence / non-perte).
  if (
    existing.blockStatus === "reserved" &&
    existing.blockStart !== null &&
    existing.blockEnd !== null
  ) {
    return;
  }

  // (b) Bloc déjà consommé qui se termine au moins aussi loin → ne jamais
  //     rétrécir ni réinstaller un intervalle déjà épuisé.
  if (
    existing.blockStatus === "consumed" &&
    existing.blockEnd !== null &&
    existing.blockEnd >= blockEnd
  ) {
    return;
  }

  // (c) Curseur : max(curseur courant, blockStart - 1).
  //     - curseur < blockStart - 1 → alignement (le 1er numéro émis sera
  //       exactement blockStart) ;
  //     - curseur dans le bloc       → reprise au milieu du bloc ;
  //     - curseur > blockEnd         → conservé tel quel : le poste a émis des
  //       numéros au-delà du bloc, on ne RECRÉE JAMAIS un numéro déjà sorti ;
  //       le bloc paraîtra épuisé et le caller réservera un bloc plus loin.
  const cursor = Math.max(existing.lastNumber, blockStart - 1);

  await repo.writeBlock({
    clinicId,
    type,
    blockStart,
    blockEnd,
    deviceId,
    reservedAt,
    cursor,
  });
}

/* -------------------------------------------------------------------------- */
/* 5. consumeBlockReservation — traçabilité d'un bloc épuisé                   */
/* -------------------------------------------------------------------------- */

/**
 * Passe le bloc en `consumed` **lorsqu'il est vide** (traçabilité : on sait
 * alors que le bloc a été intégralement consommé sur ce poste).
 *
 * Aucune écriture si : la ligne est absente, le bloc ne correspond pas aux
 * bornes attendues, le bloc n'est plus `reserved`, ou le curseur n'a pas
 * atteint `blockEnd` (bloc encore plein → rien à marquer).
 */
export async function consumeBlockReservation(
  repo: NumberingRepo,
  params: ConsumeBlockParams,
): Promise<void> {
  const { clinicId, type, blockStart, blockEnd } = params;
  if (!isKnownSequenceType(type)) {
    return;
  }
  const row = await repo.findSequence(clinicId, type);
  if (row === null) return;
  if (row.blockStatus !== "reserved") return;
  if (row.blockStart !== blockStart || row.blockEnd !== blockEnd) return;
  if (row.lastNumber < blockEnd) return; // bloc pas encore vide

  await repo.markBlockConsumed(clinicId, type, blockStart, blockEnd);
}
