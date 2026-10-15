/**
 * Tâche 8.1 — **magasin binaire local adressé par clé de stockage**.
 *
 * Les métadonnées de radiographie (`radiograph.file_key`, etc.) sont déjà
 * répliquées entre postes par le registre `src/lib/sync/protocol.ts` ; LEUR
 * BINAIRE, lui, ne l'est pas : un fichier téléversé sur le poste A est
 * inaccessible hors-ligne sur le poste B. Ce module fournit le stockage local
 * d'octets, adressé par la **même clé de stockage** que celle référencée en
 * base (`<clinicId>/radiograph-<uuid>.png`), de sorte que :
 *
 *  - le dépôt vit sous `uploads/` et **partage exactement les mêmes chemins**
 *    que `LocalStorageAdapter` (la route `/api/files` sert donc un fichier
 *    téléchargé ici sans aucun autre câblage) ;
 *  - `blobs.has(fileKey)` signifie « l'octet de cette radiographie est déjà
 *    disponible sur CE poste » (téléversé ici, ou rapporté par la synchro) ;
 *  - la validation est **déléguée** à `isSafeStorageKey` (`src/lib/storage.ts`)
 *    : le même jeu de règles anti path traversal s'applique aux deux pôles,
 *    aucune règle parallèle à maintenir.
 *
 * ## Invariants (NON NÉGOCIABLES)
 *
 *  1. **Jamais d'écriture hors base** : `isSafeBlobKey` (délégation) **puis**
 *     contrôle de préfixe après `resolve` — un chemin absolu de type `C:\…`
 *     qui passerait la validation de segments est rejeté ici ;
 *  2. **Écriture atomique** : octets écrits dans un fichier temporaire puis
 *     `rename` — une coupure (coupure de courant, arrêt de l'app) laisse soit
 *     l'ancien fichier, soit rien, **jamais un fichier tronqué** ;
 *  3. **Taille bornée** : 10 Mo, strictement aligné sur `MAX_FILE_SIZE` de
 *     `storage.ts` — un octet jamais accepté par le central ne peut pas
 *     s'installer ici ;
 *  4. **TypeScript strict, zéro `any`, zéro `console.*`** (le module est
 *     importé par le main Electron comme par les routes Next) ;
 *  5. **Aucun secret journalisé** : ce module ne journalise rien (aucun I/O
 *     de type log), les appelsants n'ont que des clés et des tailles.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { isSafeStorageKey } from "@/lib/storage";

/**
 * Taille maximale d'un blob — **même valeur** que `MAX_FILE_SIZE` de
 * `src/lib/storage.ts` (10 Mo, constante non exportée : la valeur est donc
 * répétée ici, avec ce commentaire pour rendre le couplage explicite).
 */
export const MAX_BLOB_SIZE = 10 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* 1. Interface publique                                                      */
/* -------------------------------------------------------------------------- */

export interface BlobStore {
  /** Écrit `bytes` à `key` (atomique) ; renvoie le SHA-256 (hex) du contenu. */
  put(key: string, bytes: Uint8Array): Promise<{ sha256: string }>;
  /** Lit `bytes` ; `null` si absent (les erreurs I/O non liées à l'absence lèvent). */
  get(key: string): Promise<Uint8Array | null>;
  /** `true` si un fichier **régulier** existe à `key`. */
  has(key: string): Promise<boolean>;
  /** Supprime `key` ; absente = succès (idempotent). */
  delete(key: string): Promise<void>;
  /** Métadonnées minimales ; `null` si absent. */
  stat(key: string): Promise<{ size: number } | null>;
}

/* -------------------------------------------------------------------------- */
/* 2. Validation (délégation à `storage.ts`)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Format admis d'une clé de blob — **délègue intégralement** à
 * `isSafeStorageKey` (Z-79) : pas de `..`, pas de `\`, pas de chemin absolu,
 * pas de segment vide, longueur bornée à 512.
 *
 * Ne pas réimplémenter de règle ici : toute exception à ce format doit être
 * corrigée `dans storage.ts`, pour que la route `/api/files`, l'adaptateur de
 * stockage et ce magasin restent strictement cohérents.
 */
export function isSafeBlobKey(key: string): boolean {
  return isSafeStorageKey(key);
}

/**
 * SHA-256 (hex) du contenu — **fonction pure**, sans I/O. Utilisé comme
 * empreinte de réconciliation poste ↔ central (réponse `POST /api/sync/media`).
 */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* 3. Fabrique disque                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Construit un `BlobStore` sur disque sous `baseDir`.
 *
 * `baseDir` est résolu contre `process.cwd()` **exactement comme**
 * `LocalStorageAdapter` (`join(process.cwd(), basePath)`) : en production le
 * poste et le serveur Next partagent la racine du projet, donc les mêmes
 * fichiers.
 *
 * @param baseDir dossier de base, par ex. `LOCAL_UPLOADS_BASE_PATH` (`uploads`).
 */
export function createLocalBlobStore(baseDir: string): BlobStore {
  const root = resolve(process.cwd(), baseDir);

  /**
   * Résout `key` dans la base, ou `null` si la clé est refusée **ou** si le
   * chemin résolu sortirait du dossier (défense en profondeur : contrôle de
   * préfixe après `resolve`, même sas que la route `/api/files`).
   */
  function resolvePath(key: string): string | null {
    if (!isSafeBlobKey(key)) return null;
    const filePath = resolve(root, key);
    if (filePath === root || !filePath.startsWith(root + sep)) return null;
    return filePath;
  }

  /** `stat` → `{ size }`, `null` si absent ; les erreurs I/O lèvent. */
  async function statOrNull(filePath: string): Promise<{ size: number } | null> {
    try {
      const info = await stat(filePath);
      return info.isFile() ? { size: info.size } : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }

  return {
    async put(key, bytes) {
      const filePath = resolvePath(key);
      if (filePath === null) {
        // Refus ferme : jamais d'écriture hors base, jamais de journal ici.
        throw new Error("clé de blob invalide");
      }
      if (bytes.byteLength > MAX_BLOB_SIZE) {
        throw new Error("blob trop volumineux (limite : 10 Mo)");
      }

      // Création récursive des sous-dossiers (`<clinicId>/…`).
      await mkdir(dirname(filePath), { recursive: true });

      // Écriture ATOMIQUE : temporaire dans le même dossier puis `rename`.
      const tempPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, bytes);
        await rename(tempPath, filePath);
      } catch (error) {
        // Nettoyage du temporaire (best-effort) avant de propager.
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }

      return { sha256: sha256(bytes) };
    },

    async get(key) {
      const filePath = resolvePath(key);
      if (filePath === null) return null;
      try {
        return await readFile(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
          return null;
        }
        throw error;
      }
    },

    async has(key) {
      const filePath = resolvePath(key);
      if (filePath === null) return false;
      return (await statOrNull(filePath)) !== null;
    },

    async delete(key) {
      const filePath = resolvePath(key);
      if (filePath === null) {
        // Refus ferme : une clé invalide ne doit surtout pas atteindre `rm`.
        throw new Error("clé de blob invalide");
      }
      await rm(filePath, { force: true });
    },

    async stat(key) {
      const filePath = resolvePath(key);
      if (filePath === null) return null;
      return statOrNull(filePath);
    },
  };
}
