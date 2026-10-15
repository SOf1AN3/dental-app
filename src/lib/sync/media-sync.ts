/**
 * Tâche 8.1 — **orchestration de la synchronisation des fichiers** (poste).
 *
 * Les métadonnées de `radiograph` circulent déjà par le protocole
 * (`src/lib/sync/protocol.ts`), mais pas leur **binaire** : ce module rapproche
 * les octets entre le magasin local (`blob-store.ts`, sous `uploads/`) et le
 * central (`POST`/`GET /api/sync/media`).
 *
 * ## Conception (même style que `runner-core.ts`)
 *
 *  - TypeScript strict, **toutes les dépendances injectées** (`MediaSyncDeps`) :
 *    le module ne connaît ni la base, ni `fetch`, ni le jeton, ni le disque —
 *    les tests sont donc entièrement hermétiques ;
 *  - **jamais d'exception non capturée** : toute défaillance imprévue est
 *    convertie en `errors` (compteur) — un cycle de médias ne peut pas faire
 *    échouer un cycle de synchronisation ;
 *  - **chaque item est isolé** : une clé fautive, un réseau en panne ou un
 *    refus du central n'interrompt jamais les items suivants ;
 *  - **timeout borné** par item (`timeoutMs`) : un appel distant suspendu ne
 *    bloque pas la boucle ;
 *  - **aucun secret journalisé** : seules clés de fichiers, identifiants
 *    d'appareil non fournis ici, compteurs et motifs passés par `redactError`
 *    (retrait des `Bearer`/`token=`/`password=` + troncature).
 *
 * ## Algorithme (un appel = `syncMediaOnce`)
 *
 *  1. inventaire des `radiograph.file_key` **locales** (`listLocalRadiographs`) ;
 *     toute clé au format refusé → `skipped` (aucun accès disque, a fortiori
 *     aucun hors base) ;
 *  2. partition locale : `blobs.has(key)` — présent localement ou non ;
 *  3. **pass 1 — téléchargements** : clé absente localement → `downloadRemote`
 *     → `blobs.put` (404 distant → `skipped`, fichier non disponible) ;
 *  4. **pass 2 — téléversements** : clé présente localement → `hasRemote` ;
 *     absente du central → `blobs.get` + `uploadLocal` ; le central refuse
 *     (`413`/`415`/`403` → `false`) → `skipped`, **jamais** une erreur fatale ;
 *  5. **plafond `maxItems`** : budget **partagé** entre les deux passes,
 *     décrémenté à chaque item examiné ; les téléchargements passent en premier
 *     (rendre les fichiers disponibles hors-ligne est la finalité du module),
 *     les téléversements utilisent le reliquat.
 *
 * Choix assumé : un item **déjà cohérent** (présent des deux côtés) consomme du
 * budget et compte `skipped` — c'est ce qui garantit que le nombre d'aller-
 * retours distants par cycle reste borné par `maxItems`.
 */

import { isSafeBlobKey, MAX_BLOB_SIZE, type BlobStore } from "../offline/blob-store";
import { redactError } from "./outbox";
import type { SyncLogger } from "./runner-core";

/* -------------------------------------------------------------------------- */
/* 1. Types                                                                   */
/* -------------------------------------------------------------------------- */

/** Dépendances injectées — aucune n'est créée dans ce module. */
export interface MediaSyncDeps {
  /** Magasin binaire local (`createLocalBlobStore` en prod, mémoire en test). */
  blobs: BlobStore;
  /** Métadonnées locales : `file_key` des radiographies du poste. */
  listLocalRadiographs(): Promise<{ fileKey: string }[]>;
  /** Présence du fichier sur le central (aller-retour HTTP borné). */
  hasRemote(key: string): Promise<boolean>;
  /** Téléchargement : `null` si le central n'a pas ce fichier (404). */
  downloadRemote(key: string): Promise<Uint8Array | null>;
  /**
   * Téléversement : `true` = accepté ; `false` = **refusé** par le central
   * (413 taille, 415 type, 403 portée) → `skipped`, pas une erreur.
   * Une défaillance réseau DOIT **lever** (isolée en `errors` par item).
   */
  uploadLocal(key: string, bytes: Uint8Array): Promise<boolean>;
  /** Journal injecté (aligné sur le cœur : `electron-log` en production). */
  logger: SyncLogger;
}

export interface MediaSyncOptions {
  /**
   * Plafond d'items **examinés** par appel (donc de transferts et d'aller-
   * retours distants), partagé entre les deux passes. Non entier ou négatif →
   * aucun item traité (échec fermé, jamais « libre »).
   */
  maxItems: number;
  /**
   * Timeout par item, en ms (défaut {@link DEFAULT_MEDIA_TIMEOUT_MS}).
   * Valeur non finie ou ≤ 0 → timeout désactivé (réservé aux tests).
   */
  timeoutMs?: number;
}

export interface MediaSyncSummary {
  downloaded: number;
  uploaded: number;
  skipped: number;
  errors: number;
}

/* -------------------------------------------------------------------------- */
/* 2. Constantes                                                              */
/* -------------------------------------------------------------------------- */

/** Même borne que `SYNC_REQUEST_TIMEOUT_MS` du cœur : un cycle reste borné. */
export const DEFAULT_MEDIA_TIMEOUT_MS = 15_000;

/* -------------------------------------------------------------------------- */
/* 3. Helpers                                                                 */
/* -------------------------------------------------------------------------- */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Motif **rédigé** (jamais de secret, borné) — voir `redactError`. */
function safeReason(error: unknown): string {
  return redactError(messageOf(error));
}

/**
 * Exécute `task` sous plafond de temps. Une expiration **rejette** (elle est
 * comptée `errors` par l'item appelant) : elle ne laisse jamais une promise
 * suspendue paralyser le cycle. Le timer est toujours libéré.
 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} : délai dépassé (${timeoutMs} ms)`));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Plafond : entier fini ≥ 0, sinon `0` (aucun item traité). */
function normalizeMaxItems(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Extrait et dédoublonne les clés exploitables. Les clés refusées (format
 * invalide = tentative de path traversal potentielle) sont comptées `skipped`
 * et **jamais journalisées brutes** (message contrôlé : ni contenu
 * arbitraire, ni injection de saut de ligne dans le journal).
 */
function collectKeys(
  entries: readonly { fileKey: string }[],
  summary: MediaSyncSummary,
  logger: SyncLogger,
): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  let refused = 0;
  for (const entry of entries) {
    const key = entry.fileKey;
    if (typeof key !== "string" || key.length === 0 || !isSafeBlobKey(key)) {
      refused += 1;
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  if (refused > 0) {
    summary.skipped += refused;
    logger.warn(
      `média : ${refused} clé(s) locale(s) refusée(s) (format invalide — aucune lecture ni écriture)`,
    );
  }
  return keys;
}

/* -------------------------------------------------------------------------- */
/* 4. Cycle de synchronisation des médias                                      */
/* -------------------------------------------------------------------------- */

/**
 * Exécute **un** cycle de transfert des fichiers. **Ne rejette jamais** : toute
 * défaillance est convertie en `errors` et journalisée (motif rédigé).
 *
 * @param deps dépendances injectées (aucune création de ressource ici).
 * @param options plafond d'items et timeout par item.
 */
export async function syncMediaOnce(
  deps: MediaSyncDeps,
  options: MediaSyncOptions,
): Promise<MediaSyncSummary> {
  const summary: MediaSyncSummary = {
    downloaded: 0,
    uploaded: 0,
    skipped: 0,
    errors: 0,
  };
  const maxItems = normalizeMaxItems(options.maxItems);
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEDIA_TIMEOUT_MS;
  if (maxItems === 0) return summary;

  /* (1) Inventaire local — échec global : cycle abandonné, jamais de levée. */
  let keys: string[];
  try {
    const entries = await withTimeout(
      deps.listLocalRadiographs(),
      timeoutMs,
      "inventaire des radiographies",
    );
    keys = collectKeys(entries, summary, deps.logger);
  } catch (error) {
    summary.errors += 1;
    deps.logger.error(`média : inventaire local impossible (${safeReason(error)})`);
    return summary;
  }
  if (keys.length === 0) return summary;

  /* (2) Partition locale (stat uniquement — aucune requête distante). */
  const presentLocally: string[] = [];
  const absentLocally: string[] = [];
  for (const key of keys) {
    try {
      if (await deps.blobs.has(key)) {
        presentLocally.push(key);
      } else {
        absentLocally.push(key);
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.warn(`média : état local illisible (${safeReason(error)})`);
    }
  }

  let budget = maxItems;

  /* (3) Pass 1 — téléchargements (priorité : disponibilité hors-ligne). */
  for (const key of absentLocally) {
    if (budget <= 0) break;
    budget -= 1;
    try {
      const bytes = await withTimeout(
        deps.downloadRemote(key),
        timeoutMs,
        "téléchargement",
      );
      if (bytes === null) {
        // 404 distant : la métadonnée existe mais aucun octet n'est publié.
        summary.skipped += 1;
        continue;
      }
      if (bytes.byteLength > MAX_BLOB_SIZE) {
        summary.skipped += 1;
        deps.logger.warn(
          `média : fichier distant trop volumineux (limite 10 Mo) — item écarté`,
        );
        continue;
      }
      await withTimeout(deps.blobs.put(key, bytes), timeoutMs, "écriture locale");
      summary.downloaded += 1;
    } catch (error) {
      summary.errors += 1;
      deps.logger.warn(`média : téléchargement impossible (${safeReason(error)})`);
    }
  }

  /* (4) Pass 2 — téléversements (reliquat de budget). */
  for (const key of presentLocally) {
    if (budget <= 0) break;
    budget -= 1;
    try {
      const remote = await withTimeout(
        deps.hasRemote(key),
        timeoutMs,
        "présence distante",
      );
      if (remote) {
        // Déjà cohérent : rien à transférer (item examiné, budget consommé).
        summary.skipped += 1;
        continue;
      }
      const bytes = await deps.blobs.get(key);
      if (bytes === null) {
        summary.skipped += 1;
        continue;
      }
      if (bytes.byteLength > MAX_BLOB_SIZE) {
        summary.skipped += 1;
        deps.logger.warn(
          `média : fichier local trop volumineux (limite 10 Mo) — item écarté`,
        );
        continue;
      }
      const accepted = await withTimeout(
        deps.uploadLocal(key, bytes),
        timeoutMs,
        "téléversement",
      );
      if (accepted) {
        summary.uploaded += 1;
      } else {
        // Refus ferme du central (413/415/403) : écarté, jamais fatal.
        summary.skipped += 1;
        deps.logger.warn(
          `média : téléversement refusé par le central — item écarté`,
        );
      }
    } catch (error) {
      summary.errors += 1;
      deps.logger.warn(`média : téléversement impossible (${safeReason(error)})`);
    }
  }

  /* (5) Synthèse — un cycle uniquement « déjà cohérent » reste silencieux. */
  const summaryText =
    `média : ${summary.downloaded} téléchargé(s), ${summary.uploaded} téléversé(s), ` +
    `${summary.skipped} écarté(s), ${summary.errors} erreur(s)`;
  if (summary.errors > 0) {
    deps.logger.warn(summaryText);
  } else if (summary.downloaded + summary.uploaded > 0) {
    deps.logger.info(summaryText);
  }

  return summary;
}
