/**
 * Tâche 8.1 — `POST` / `GET /api/sync/media` : **transfert des fichiers**
 * (radiographies) entre un poste desktop et le serveur central.
 *
 * Les métadonnées `radiograph` sont déjà répliquées par le protocole
 * (`src/lib/sync/protocol.ts`) ; cette route transporte leur **binaire**, qui
 * autrement reste inaccessible hors-ligne sur les autres postes.
 *
 * ## Choix d'encodage : **JSON + base64** (et non multipart)
 *
 * Le corps est `{ key, clinicId, contentBase64 }` plutôt qu'un `multipart/form-data` :
 *  - une seule chaîne de validation (Zod) et un seul chemin de décodage,
 *    au lieu d'un parseur multipart à implémenter et à sécuriser nous-mêmes ;
 *  - taille **bornée et prévisible** : 10 Mo → ~13,4 Mo de base64, contrôlable
 *    par une simple longueur de chaîne AVANT décodage (une limite
 *    `content-length` est vérifiée avant même la lecture du corps) ;
 *  - identique au reste du protocole sync (corps JSON, `Content-Type:
 *    application/json`), donc réutilisable tel quel par `runner-core`.
 * Le surcoût (~33 %) est sans conséquence à la cadence d'un cycle (plafond de
 * 20 items) et sur un réseau de cabinet.
 *
 * ## Contrat
 *
 * `Authorization: Bearer <jeton d'appareil>` exigé pour LES DEUX verbes, lu
 * **avant** toute validation de corps/paramètres (aucun oracle) :
 *
 * | état | POST (téléversement)                          | GET (téléchargement)              |
 * |------|-----------------------------------------------|-----------------------------------|
 * | 401  | jeton absent / malformé / inconnu / révoqué   | idem                              |
 * | 411  | `Content-Length` absent / illisible (corps non borné → jamais lu) | —                 |
 * | 400  | corps illisible, champs invalides, clé non conforme (segments stricts), base64 malformé | `key`/`clinicId` manquants ou clé non conforme |
 * | 403  | `clinicId` ∉ `ctx.clinicIds` **ou** clé non prefixée par ce cabinet (anti-IDOR) | idem + sortie de répertoire |
 * | 413  | > 10 Mo (longueur base64 ou contenu décodé)   | —                                 |
 * | 415  | extension absente / hors allow-list de MIME   | idem                              |
 * | 404  | —                                             | fichier absent du stockage        |
 * | 500  | défaillance imprévue (message **générique**)   | idem                              |
 * | 200  | `{ key, sha256 }`                             | flux d'octets                     |
 *
 * Invariants :
 *  - **anti path traversal en deux barrières** : `isStrictStorageKey(key)`
 *    (segments fermés, miroir de `KEY_SEGMENT_PATTERN` de `/api/files` —
 *    refuse `C:…`, espaces, points finaux, `..`) **puis** un contrôle du
 *    préfixe **après** `resolve`, à la lecture **et à l'écriture** (le chemin
 *    résolu doit rester dans `uploads/`) ;
 *  - **anti-IDOR de la liaison `key ↔ clinicId`** (les deux verbes) : la clé
 *    DOIT être prefixée par le `clinicId` autorisé par le jeton — un jeton du
 *    cabinet A ne lit ni n'écrase jamais `uploads/<autre-cabinet>/…`, même en
 *    passant un `clinicId` valide en champ `clinicId` (le `key.startsWith` est
 *    littéral et le `clinicId` est validé sans séparateur, donc le préfixe ne
 *    peut pas être élargi) ;
 *  - `Cache-Control: private, no-store` **et** `X-Content-Type-Options:
 *    nosniff` sur le GET : données de santé, jamais mises en cache, jamais
 *    re-sniffées par le navigateur ;
 *  - stockage **via l'adaptateur existant** `storage` (S3 si `S3_REGION` +
 *    `S3_BUCKET` sont définis, sinon disque `uploads/`) — aucun accès direct
 *    en écriture ;
 *  - `force-dynamic` : aucune mise en cache de route ;
 *  - zéro `console.log` ; `console.error` uniquement sur les 500 (message
 *    fixe, ni jeton ni détail interne) ; événement de téléversement et de
 *    téléchargement journalisés en `console.info` avec **clé, deviceId et
 *    taille seulement** (jamais le contenu, jamais le jeton) — la clé est
 *    journalisée via `JSON.stringify` (aucune injection de ligne de
 *    journal possible).
 */

import { readFile } from "fs/promises";
import { extname, resolve, sep } from "path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sha256 } from "@/lib/offline/blob-store";
import {
  verifyDeviceToken,
  type DeviceTokenContext,
} from "@/lib/sync/central-auth";
import {
  isSafeStorageKey,
  LocalStorageAdapter,
  LOCAL_UPLOADS_BASE_PATH,
  storage,
} from "@/lib/storage";

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Constantes                                                                  */
/* -------------------------------------------------------------------------- */

/** Même valeur que `MAX_FILE_SIZE` de `src/lib/storage.ts` (non exportée). */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/** Longueur maximale d'un base64 standard **prenant** 10 Mo (arrêt avant décodage). */
const MAX_BASE64_CHARS = Math.ceil(MAX_MEDIA_BYTES / 3) * 4;

/**
 * Garde-fou `Content-Length` **avant** la lecture du corps : 10 Mo encodés
 * (~13,4 Mo) + marge sur les champs, mais refus déjà net de tout corps
 * démesuré (une charge utile géante n'est jamais décodée en mémoire).
 */
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

/** Longueur maximale d'une clé — alignée sur `MAX_KEY_LENGTH` de `storage.ts`. */
const MAX_KEY_LENGTH = 512;

/** Longueur d'un identifiant de cabinet ( UUID/ULID larges ). */
const MAX_CLINIC_ID_LENGTH = 256;

/**
 * Clés émises par le serveur : `<clinicId>/radiograph-<uuid>.<ext>` →
 * identifiants UUID/ULID + noms fixes. Le premier caractère doit être
 * alphanumérique (exclut `.`, `..`, `C:…`) et aucun espace ni deux-points
 * n'est admis (normalisation Win32 des noms).
 *
 * **Dupliqué** de `KEY_SEGMENT_PATTERN` de
 * `src/app/api/files/[...key]/route.ts` (~l.29) : cette constante n'est pas
 * exportée et un import depuis un fichier de route App Router n'est pas
 * souhaitable — la duplication est volontaire et documentée.
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Identifiant de cabinet : non vide (Zod `min(1)`) et **sans séparateur de
 * chemin ni NUL** — le `clinicId` sert de préfixe littéral à la clé (anti-IDOR
 * de la liaison `key ↔ clinicId`) et ne doit donc jamais pouvoir être
 * interprété comme un chemin. Le format exact (UUID/ULID) n'est pas imposé pour
 * rester compatible avec les identifiants historiques.
 */
const clinicIdSchema = z
  .string()
  .min(1)
  .max(MAX_CLINIC_ID_LENGTH)
  .regex(/^[^/\\\0]+$/);

/**
 * MIME **autorisés** — miroir strict de `ALLOWED_MIME_TYPES` de
 * `src/lib/storage.ts` (constante privée : elle n'est pas exportée ; le
 * couple « extension → MIME » ci-dessous ne peut produire que l'un de ces
 * quatre types, et `storage.upload` re-vérifie de toute façon).
 */
const ALLOWED_MIME_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

/** MIME déduit de l'extension (même table que `/api/files/[...key]`). */
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** Base64 standard **paddé** : `Buffer.from(str, "base64")` est tolérant, on ne l'est pas. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/* -------------------------------------------------------------------------- */
/* Schémas (Zod)                                                               */
/* -------------------------------------------------------------------------- */

const uploadBodySchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  clinicId: clinicIdSchema,
  contentBase64: z.string().min(1),
});

const downloadQuerySchema = z.object({
  key: z.string().min(1).max(MAX_KEY_LENGTH),
  clinicId: clinicIdSchema,
});

/* -------------------------------------------------------------------------- */
/* Réponses                                                                    */
/* -------------------------------------------------------------------------- */

function jsonError(
  error:
    | "unauthorized"
    | "length-required"
    | "invalid-request"
    | "invalid-key"
    | "clinic-out-of-scope"
    | "payload-too-large"
    | "unsupported-media-type"
    | "not-found"
    | "forbidden"
    | "internal-error",
  status: number,
): Response {
  return NextResponse.json({ error }, { status });
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <jeton>`, `null` sinon. */
function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/* -------------------------------------------------------------------------- */
/* Découpage de clé (le stockage ajoute l'extension : `key` = `base` + `ext`)  */
/* -------------------------------------------------------------------------- */

/**
 * Format **strict** de clé — `isSafeStorageKey` (déjà appelé) **plus**
 * `KEY_SEGMENT_PATTERN` par segment : refuse les clés exotiques que
 * `isSafeStorageKey` laisse passer et que Win32 normalise ensuite de façon
 * ambigüe — `C:/radiograph.png` (lettre de lecteur), `.. /x.png` (espace),
 * `x.png.` (point final tronqué par Win32 au moment du `join` disque),
 * `a b/c.png` (espace interne). Appelée **avant tout accès disque**.
 */
function isStrictStorageKey(key: string): boolean {
  if (!isSafeStorageKey(key)) return false;
  return key
    .split("/")
    .every(
      (segment) =>
        KEY_SEGMENT_PATTERN.test(segment) &&
        !segment.endsWith(".") &&
        !segment.endsWith(" "),
    );
}

/**
 * La clé doit être **prefixée** par le cabinet autorisé — miroir de la
 * branche radiographie de `isKeyOwnedByClinic` de
 * `src/app/api/files/[...key]/route.ts` (~l.49-60) : cette fonction n'est pas
 * exportée et un import depuis un fichier de route App Router n'est pas
 * souhaitable — duplication documentée.
 *
 * Seule la branche `<clinicId>/radiograph-<uuid>.<ext>` s'applique ici : le
 * protocole de synchronisation ne transporte que des radiographies (la branche
 * `clinics/<clinicId>/logo.png` de `/api/files` n'a pas de contrepartie sync).
 *
 * Robustesse : le test est un `startsWith` **littéral** et le `clinicId` est
 * validé non vide et sans `/`, `\` ni NUL (`clinicIdSchema`) — un cabinet ne
 * peut pas « élargir » son préfixe pour atteindre les fichiers d'un autre.
 */
function isKeyOwnedByClinic(key: string, clinicId: string): boolean {
  return key.startsWith(clinicId + "/");
}

interface KeyParts {
  /** Clé transmise à `storage.upload` (elle ré-agrége l'extension). */
  base: string;
  /** Nom de fichier (contient l'extension) → détermine le MIME réellement écrit. */
  name: string;
  /** Extension avec le point, minuscule. */
  ext: string;
}

/**
 * `LocalStorageAdapter.upload` / `S3StorageAdapter.upload` écrivent à
 * `key + extname(file.name)` : pour obtenir **exactement** la clé référencée en
 * base (`<clinicId>/radiograph-<uuid>.png`), on transmet la clé **privée de son
 * extension** et un `File` nommé comme le segment final.
 *
 * L'extension est d'abord prouvée dans l'allow-list (sinon **415**) : toute clé
 * acceptée possède donc une extension non vide, et `base + ext === key` est
 * garanti. `base` est re-validée (défense en profondeur sur le découpage).
 */
function splitStorageKey(key: string): KeyParts | null {
  const ext = extname(key);
  if (ext.length <= 1) return null;
  const base = key.slice(0, key.length - ext.length);
  if (base.length === 0 || !isStrictStorageKey(base)) return null;
  const slash = key.lastIndexOf("/");
  const name = slash === -1 ? key : key.slice(slash + 1);
  if (name.length === 0 || extname(name) !== ext) return null;
  return { base, name, ext: ext.toLowerCase() };
}

/** MIME autorisé pour la clé, `null` si l'extension est absente ou refusée. */
function contentTypeForKey(key: string): string | null {
  const ext = extname(key);
  if (ext.length <= 1) return null;
  const mime = CONTENT_TYPE_BY_EXTENSION[ext.toLowerCase()];
  return mime !== undefined && ALLOWED_MIME_TYPES.includes(mime) ? mime : null;
}

/* -------------------------------------------------------------------------- */
/* Chemins de production : stockage + lecture                                  */
/* -------------------------------------------------------------------------- */

interface MediaPutInput {
  /** Clé **sans** extension (l'adaptateur ré-agrége `extname(name)`). */
  key: string;
  name: string;
  type: string;
  bytes: Uint8Array;
}

type MediaReadResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "outside" };

/** Écrit via `storage` (S3 si configuré, sinon disque) ; renvoie la clé réellement écrite. */
async function putViaStorage(input: MediaPutInput): Promise<string> {
  // Copie explicite : `File` possède son propre tampon (jamais un ArrayBuffer
  // mis en pool par `Buffer`), et le typage reste `Uint8Array<ArrayBuffer>`.
  const copy = new Uint8Array(input.bytes.byteLength);
  copy.set(input.bytes);
  const file = new File([copy.buffer], input.name, { type: input.type });
  return storage.upload(file, input.key);
}

/**
 * Lit les octets d'une clé.
 *
 *  - **disque** (`LocalStorageAdapter`) : `resolve` + contrôle de préfixe — le
 *    chemin doit rester dans `uploads/` (anti path traversal **après**
 *    validation du format) ;
 *  - **S3** : URL présignée puis lecture **serveur** (aucun octet ni URL ne
 *    quittent le serveur ; le client ne reçoit que les octets du GET).
 */
async function readStoredFile(key: string): Promise<MediaReadResult> {
  if (storage instanceof LocalStorageAdapter) {
    const uploadsRoot = resolve(process.cwd(), LOCAL_UPLOADS_BASE_PATH);
    const filePath = resolve(uploadsRoot, key);
    if (filePath === uploadsRoot || !filePath.startsWith(uploadsRoot + sep)) {
      // Clé journalisée sérialisée : jamais d'injection de ligne de journal.
      console.error("[api/sync/media] sortie du répertoire d'uploads refusée", {
        key: JSON.stringify(key),
      });
      return { kind: "outside" };
    }
    try {
      const content = await readFile(filePath);
      return { kind: "ok", bytes: new Uint8Array(content) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        return { kind: "missing" };
      }
      console.error("[api/sync/media] lecture du fichier impossible", {
        key: JSON.stringify(key),
        code,
      });
      throw error;
    }
  }

  const url = await storage.getSignedUrl(key);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { kind: "missing" };
  return { kind: "ok", bytes: new Uint8Array(await response.arrayBuffer()) };
}

/* -------------------------------------------------------------------------- */
/* Authentification commune                                                    */
/* -------------------------------------------------------------------------- */

/** Auth → `ctx`, ou la réponse d'erreur déjà prête (401 / 500), **avant** tout corps. */
async function authenticate(
  request: Request,
  verifyToken: (token: string, now: Date) => Promise<DeviceTokenContext | null>,
): Promise<{ ctx: DeviceTokenContext } | { response: Response }> {
  const token = readBearerToken(request.headers.get("authorization"));
  if (token === null) {
    return { response: jsonError("unauthorized", 401) };
  }
  let ctx: DeviceTokenContext | null;
  try {
    ctx = await verifyToken(token, new Date());
  } catch {
    console.error("[api/sync/media] échec imprévu de la vérification du jeton");
    return { response: jsonError("internal-error", 500) };
  }
  if (ctx === null) {
    return { response: jsonError("unauthorized", 401) };
  }
  return { ctx };
}

/* -------------------------------------------------------------------------- */
/* Handlers (fabrique injectable pour les tests hermétiques)                   */
/* -------------------------------------------------------------------------- */

export interface SyncMediaHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /** Écriture — chemin de prod : `storage.upload` (S3 ou disque). */
  put(input: MediaPutInput): Promise<string>;
  /** Lecture — chemin de prod : disque `uploads/` (contrôle de préfixe) ou S3. */
  read(key: string): Promise<MediaReadResult>;
}

export type { MediaPutInput, MediaReadResult };

/**
 * Construit les handlers `POST` et `GET`. Les tests injectent des deps
 * mémoire (aucune base, aucun disque) ; les exports du module ci-dessous sont
 * les chemins de production.
 */
export function createSyncMediaHandlers(
  overrides: Partial<SyncMediaHandlerDeps> = {},
): {
  POST: (request: Request) => Promise<Response>;
  GET: (request: Request) => Promise<Response>;
} {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const put = overrides.put ?? putViaStorage;
  const read = overrides.read ?? readStoredFile;

  async function POST(request: Request): Promise<Response> {
    // (1) Auth — échec fermé, réponse générique, **avant** toute lecture du corps.
    const auth = await authenticate(request, verifyToken);
    if ("response" in auth) return auth.response;
    const ctx = auth.ctx;

    // (2) Garde-fou `Content-Length` sur l'en-tête (le corps n'est pas encore
    // lu) : absent ou illisible → **411** (sinon `Number(null) === 0`
    // « passerait » et `request.json()` lirait un corps de taille illimitée
    // en mémoire).
    const rawContentLength = request.headers.get("content-length");
    const contentLength =
      rawContentLength === null || rawContentLength.trim() === ""
        ? Number.NaN
        : Number(rawContentLength);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return jsonError("length-required", 411);
    }
    if (contentLength > MAX_REQUEST_BODY_BYTES) {
      return jsonError("payload-too-large", 413);
    }

    // (3) Corps JSON + validation Zod.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = uploadBodySchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    const { key, clinicId, contentBase64 } = parsed.data;

    // (4) Anti path traversal — segments **stricts** de la clé AVANT tout
    // décodage (miroir de `KEY_SEGMENT_PATTERN` de `/api/files`).
    if (!isStrictStorageKey(key)) {
      return jsonError("invalid-key", 400);
    }

    // (5) Anti-IDOR : le cabinet doit appartenir à la portée du jeton.
    if (!ctx.clinicIds.includes(clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (5bis) Anti-IDOR de la **liaison clé ↔ cabinet** : la clé doit être
    // prefixée par le cabinet autorisé — un jeton du cabinet A ne peut ni
    // lire ni écraser `uploads/<autre-cabinet>/…` en passant un `clinicId`
    // valide dans le champ `clinicId`.
    if (!isKeyOwnedByClinic(key, clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (6) Encodage + taille bornée (arrêt avant décodage, puis après).
    if (contentBase64.length > MAX_BASE64_CHARS) {
      return jsonError("payload-too-large", 413);
    }
    if (contentBase64.length % 4 !== 0 || !BASE64_PATTERN.test(contentBase64)) {
      return jsonError("invalid-request", 400);
    }
    const decoded = new Uint8Array(Buffer.from(contentBase64, "base64"));
    if (decoded.byteLength === 0 || decoded.byteLength > MAX_MEDIA_BYTES) {
      return jsonError(
        decoded.byteLength === 0 ? "invalid-request" : "payload-too-large",
        decoded.byteLength === 0 ? 400 : 413,
      );
    }

    // (7) MIME déduit de l'extension, dans l'allow-list de `storage.ts`.
    const mime = contentTypeForKey(key);
    if (mime === null) {
      return jsonError("unsupported-media-type", 415);
    }

    // (7bis) Découpage `base` + `ext` — re-validation (défense en profondeur).
    const parts = splitStorageKey(key);
    if (parts === null || !parts.ext || CONTENT_TYPE_BY_EXTENSION[parts.ext] !== mime) {
      return jsonError("invalid-key", 400);
    }

    // (7ter) Contrôle de préfixe **après résolution**, à l'écriture — miroir
    // exact du contrôle de lecture (`readStoredFile`) : `storage.upload` ne
    // vérifie que le format (`isSafeStorageKey`) puis fait
    // `join(cwd, basePath, key)` — le chemin résolu doit rester dans
    // `uploads/` **avant** tout accès disque (S3 : la clé est déjà validée
    // strictement, aucun système de fichiers concerné).
    if (storage instanceof LocalStorageAdapter) {
      const uploadsRoot = resolve(process.cwd(), LOCAL_UPLOADS_BASE_PATH);
      const resolved = resolve(uploadsRoot, key);
      if (resolved === uploadsRoot || !resolved.startsWith(uploadsRoot + sep)) {
        console.error("[api/sync/media] tentative d'écriture hors uploads refusée", {
          key: JSON.stringify(key),
        });
        return jsonError("invalid-key", 400);
      }
    }

    // (8) Stockage via l'adaptateur existant (S3 ou disque).
    let storedKey: string;
    try {
      storedKey = await put({
        key: parts.base,
        name: parts.name,
        type: mime,
        bytes: decoded,
      });
    } catch {
      console.error("[api/sync/media] stockage du fichier impossible");
      return jsonError("internal-error", 500);
    }
    if (storedKey !== key) {
      // Échec fermé : la clé diffère de celle référencée en base — on nettoie
      // et on refuse (jamais de clé inattendue renvoyée comme succès).
      console.error("[api/sync/media] clé stockée inattendue (refus)", {
        expectedLength: key.length,
        actualLength: storedKey.length,
      });
      try {
        await storage.delete(storedKey);
      } catch {
        // Nettoyage best-effort.
      }
      return jsonError("internal-error", 500);
    }

    // (9) Événement d'audit **sans secret** : clé, deviceId, taille. La clé
    // est sérialisée (`JSON.stringify`) — une clé contenant `\n` ne peut pas
    // forger une ligne de journal (injection de logs).
    console.info("[api/sync/media] téléversement accepté", {
      key: JSON.stringify(key),
      deviceId: ctx.deviceId,
      size: decoded.byteLength,
    });

    return NextResponse.json({ key, sha256: sha256(decoded) });
  }

  async function GET(request: Request): Promise<Response> {
    // (1) Auth — idem POST : avant même la lecture des paramètres.
    const auth = await authenticate(request, verifyToken);
    if ("response" in auth) return auth.response;
    const ctx = auth.ctx;

    // (2) Paramètres `?key=&clinicId=` validés par Zod.
    const search = new URL(request.url).searchParams;
    const parsed = downloadQuerySchema.safeParse({
      key: search.get("key") ?? "",
      clinicId: search.get("clinicId") ?? "",
    });
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    const { key, clinicId } = parsed.data;

    // (3) Anti path traversal — segments **stricts** de la clé.
    if (!isStrictStorageKey(key)) {
      return jsonError("invalid-key", 400);
    }

    // (4) Anti-IDOR : le cabinet doit appartenir à la portée du jeton.
    if (!ctx.clinicIds.includes(clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (4bis) Anti-IDOR de la **liaison clé ↔ cabinet** (miroir du POST) :
    // un jeton du cabinet A ne lit jamais `uploads/<autre-cabinet>/…`.
    if (!isKeyOwnedByClinic(key, clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (5) MIME de la clé (même règle que l'upload).
    const mime = contentTypeForKey(key);
    if (mime === null) {
      return jsonError("unsupported-media-type", 415);
    }

    // (6) Lecture — défaillance → 500 générique, absence → 404.
    let result: MediaReadResult;
    try {
      result = await read(key);
    } catch {
      console.error("[api/sync/media] lecture du fichier impossible");
      return jsonError("internal-error", 500);
    }
    if (result.kind === "outside") {
      return jsonError("forbidden", 403);
    }
    if (result.kind === "missing") {
      return jsonError("not-found", 404);
    }

    // (7) Événement d'audit **sans secret** : clé, deviceId, taille (clé
    // sérialisée — aucune injection de ligne de journal).
    console.info("[api/sync/media] téléchargement servi", {
      key: JSON.stringify(key),
      deviceId: ctx.deviceId,
      size: result.bytes.byteLength,
    });

    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(result.bytes.byteLength),
        // Données de santé : jamais mis en cache ni partagé.
        "Cache-Control": "private, no-store",
        // Jamais de re-sniffing MIME côté navigateur (PDF/images servis en
        // type déduit de l'extension).
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return { POST, GET };
}

const handlers = createSyncMediaHandlers();
export const POST = handlers.POST;
export const GET = handlers.GET;
