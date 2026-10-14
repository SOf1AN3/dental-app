/**
 * Configuration de la base PostgreSQL locale du processus **main** Electron
 * (PLAN-ELECTRON §2.1 — tâche 2.1).
 *
 * Deux modes :
 *  - **dev** (`process.env.ELECTRON_DEV === "1"`) : on reprend **telle quelle** la
 *    `DATABASE_URL` du `.env` à la racine du projet. L'objectif est de
 *    **réutiliser la base de dev déjà en cours** (`npm run db:dev`, port 5432,
 *    data dir `./pgdata`) — même philosophie que `electron/server/next.ts`, qui
 *    réutilise un `next dev` déjà lancé sur le port 3000 ;
 *  - **prod** (aucun `ELECTRON_DEV`) : data dir `<userData>/pgdata`, port lu dans
 *    `<userData>/config.json` (5433 à défaut), mot de passe **généré
 *    aléatoirement au premier démarrage** et chiffré via `safeStorage`
 *    (Credential Manager Windows / DPAPI) en base64. Sans `safeStorage`, le
 *    mot de passe tombe en clair dans `config.json` — **avec un `log.warn`
 *    explicite, jamais silencieux**.
 *
 * ⚠️ **Interdiction formelle d'importer `src/lib/db/db.ts`** : ce fichier exécute
 * `validateEnv()` au *top-level* → crash immédiat du processus main s'il est
 * importé avant la génération de l'env. Aucune dépendance vers `src/` ici.
 *
 * Aucune dépendance npm ajoutée : le parseur `.env` est maison (format
 * `KEY=VALUE`, commentaires `#`, guillemets simples/doubles). L'usage transitoire
 * de `dotenv` (dépendance d'une dépendance) serait fragile — ici, zéro surprise.
 *
 * Non modifié par l'étape 2.1 : seul `resolveDbConfig()` est branché (étape 2.2).
 * Étape 2.2a : `buildNextEnv()` construit l'environnement du processus enfant
 * Next (`DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `HOSTNAME`, `PORT`,
 * `NODE_ENV`, `UPLOAD_DIR`) — voir la section dédiée en fin de fichier.
 */

import { app, safeStorage } from 'electron'
import log from 'electron-log'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
// Type seulement (effacé à la compilation) : aucun cycle d'import au runtime —
// `embedded-pg.ts` n'importe `env.ts` que par `import type` également.
import type { LocalDbHandle } from './db/embedded-pg'
// Source unique du port Next et de la racine dev (mêmes helpers que `next.ts`) :
// `AUTH_URL`/`UPLOAD_DIR` ne doivent jamais diverger du serveur réellement lancé.
import { resolveDevProjectRoot, resolveNextPort } from './server/next'

/* -------------------------------------------------------------------------- */
/* Types publics                                                              */
/* -------------------------------------------------------------------------- */

/** Mode de fonctionnement de la base locale. */
export type DbMode = 'dev' | 'prod'

/** Configuration complète de la base PostgreSQL locale. */
export interface DbConfig {
  /** URL de connexion — **contient le mot de passe** : jamais journalisée telle quelle. */
  readonly url: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
  /** Répertoire du cluster (initdb / `postmaster.pid`). */
  readonly dataDir: string
  readonly mode: DbMode
  /**
   * Signal `fileCorrupt` (étape 2.2b) : `true` = le `<userData>/config.json`
   * était corrompu au moment de la lecture (JSON illisible **ou** au moins un
   * champ invalide). Propagé jusqu'à `buildNextEnv()`, qui **échoue** en cas de
   * corruption au lieu de régénérer `AUTH_SECRET` par-dessus un fichier à
   * restaurer (les sessions ouvertes seraient invalidées alors même que le
   * message promet « restaurez ce fichier »).
   */
  readonly fileCorrupt?: boolean
}

/**
 * Surcharges ponctuelles (test d'intégration, diagnostics). Appliquées **après**
 * la résolution du mode : elles permettent de tester `startLocalDb()` sur un
 * port et un répertoire temporaires **sans jamais toucher** à la base de dev.
 */
export interface DbConfigOverrides {
  readonly mode?: DbMode
  readonly dataDir?: string
  readonly port?: number
  readonly user?: string
  readonly password?: string
  readonly database?: string
}

/* -------------------------------------------------------------------------- */
/* Constantes                                                                 */
/* -------------------------------------------------------------------------- */

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_POSTGRES_PORT = 5432
/** Port prod par défaut (Q-5 : persistance dans `userData/config.json`). */
const PROD_DEFAULT_PORT = 5433
const DEFAULT_DATABASE = 'postgres'
const DEFAULT_USER = 'postgres'
/**
 * Repli dev en l'absence totale de `DATABASE_URL` : identique aux défauts de
 * `scripts/dev-db.ts` (port 5432, user `postgres`, mot de passe `devpassword`).
 */
const DEV_DEFAULT_DATABASE_URL =
  `postgres://${DEFAULT_USER}:devpassword@${LOOPBACK_HOST}:${DEFAULT_POSTGRES_PORT}/${DEFAULT_DATABASE}`

/* -------------------------------------------------------------------------- */
/* Parseur `.env` maison                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Déquille une valeur : `"…"`, `'…'` (sans échappement) ou non quotée
 * (commentaire inline ` # …` retiré, façon dotenv).
 */
function unquoteEnvValue(raw: string): string {
  if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'")) {
    const quote = raw[0]
    if (quote === "'") {
      const end = raw.indexOf("'", 1)
      return end === -1 ? raw.slice(1) : raw.slice(1, end)
    }
    let value = ''
    for (let index = 1; index < raw.length; index += 1) {
      const character = raw[index]
      if (character === '\\' && index + 1 < raw.length) {
        value += raw[index + 1]
        index += 1
        continue
      }
      if (character === '"') {
        return value
      }
      value += character
    }
    return value
  }
  const commentIndex = raw.search(/\s#/)
  return (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trim()
}

/**
 * Parse un contenu au format `.env` : lignes `KEY=VALUE`, commentaires `#`,
 * guillemets simples/doubles, lignes ignorées silencieusement si non
 * conformes (une ligne cassée ne doit pas planter le démarrage).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const separator = line.indexOf('=')
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue
    }
    result[key] = unquoteEnvValue(line.slice(separator + 1).trim())
  }
  return result
}

/**
 * Localise(x) le(s) `.env` : source (`electron/env.ts` → racine) **et** bundle
 * (`dist-electron/main/main.js` → racine), plus le répertoire courant pour les
 * lancements depuis la racine du projet (`npm run dev:desktop`).
 *
 * **Précédence identique à celle de Next.js** : au sein d'un même répertoire,
 * `.env.local` **complète et surcharge** `.env` (les deux sont lus, la valeur
 * locale l'emporte). Next lit `.env.local` en priorité : un
 * `AUTH_SECRET`/`DATABASE_URL` placé là rendrait l'app bureau in démarrable
 * alors que `next dev` seul fonctionne — les deux lancements doivent donc lire,
 * eux aussi, les mêmes fichiers. S'arrêter au **premier** fichier trouvé, lui,
 * casserait une config où `DATABASE_URL` reste dans `.env` : on fusionne donc
 * les fichiers du premier répertoire qui en porte.
 *
 * Le répertoire **parent** de `process.cwd()` est volontairement exclu (rejet
 * de la revue A3) : capter `<parent>/.env` risquerait de récupérer le `.env`
 * d'un **autre projet** (aujourd'hui `DATABASE_URL`, demain `AUTH_SECRET`), bien
 * pire qu'un démarrage en configuration par défaut. Les candidats `../..` des
 * deux premières lignes restent nécessaires au bundle : `<__dirname>` y vaut
 * `<racine>/dist-electron/main`, donc `../..` **est** la racine du projet.
 */
function findDotEnvFiles(): string[] {
  const directories = [
    __dirname, // source : <racine>/electron · bundle : <racine>/dist-electron/main
    path.resolve(__dirname, '..'), // source : <racine>          · bundle : <racine>/dist-electron
    path.resolve(__dirname, '..', '..'), // source : <parent>     · bundle : <racine>
    process.cwd(), // lancement depuis la racine (`npm run dev:desktop`)
  ]
  for (const directory of directories) {
    // `.env` d'abord, `.env.local` ensuite : l'ordre de fusion fait de la
    // valeur locale la gagnante (priorité identique à Next.js).
    const found = ['.env', '.env.local'].map((name) => path.join(directory, name)).filter((file) => existsSync(file))
    if (found.length > 0) {
      return found
    }
  }
  return []
}

/**
 * Lit le (ou les) `.env` **sans muter `process.env`** (comme `dotenv`, une
 * variable déjà définie dans l'environnement reste prioritaire — c'est le seul
 * arbitrage fait dans `resolveDbConfig()`). Fusion dans l'ordre de
 * `findDotEnvFiles()` : `.env.local` écrase `.env` clé par clé, comme Next.js.
 */
export function readDotEnvFile(): Record<string, string> {
  const files = findDotEnvFiles()
  if (files.length === 0) {
    log.warn('[env] fichier .env introuvable : configuration dev par défaut utilisée')
    return {}
  }
  const merged: Record<string, string> = {}
  for (const file of files) {
    try {
      const parsed = parseEnvFile(readFileSync(file, 'utf8'))
      Object.assign(merged, parsed)
      log.debug(`[env] ${path.basename(file)} lu : ${file} (${Object.keys(parsed).length} clés, valeurs jamais journalisées)`)
    } catch (error) {
      log.warn(`[env] .env illisible (${file}) : ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return merged
}

/* -------------------------------------------------------------------------- */
/* URL de connexion                                                           */
/* -------------------------------------------------------------------------- */

/** Composants d'une URL `postgres://` (hôte compris : dev peut diverger du bouclage). */
interface DbUrlParts {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
}

type DbConfigParts = DbUrlParts & { readonly dataDir: string }

/**
 * Composants résolus par le mode courant + **signal `fileCorrupt`** (étape
 * 2.2b) : toujours `false` en dev (aucun `config.json`), porté depuis la
 * lecture tolérante du fichier en prod, jusqu'à `buildNextEnv()`.
 */
type DbBaseConfig = DbConfigParts & { readonly fileCorrupt: boolean }

/** `decodeURIComponent` tolérant : une valeur non encodée ne doit pas faire planter. */
function safeDecode(value: string): string {
  if (value === '') {
    return value
  }
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Analyse stricte d'une URL `postgres://` (échec = erreur explicite, jamais de repli muet). */
function parseDbUrl(rawUrl: string, origin: string): DbUrlParts {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new Error(`${origin} illisible : ce n'est pas une URL valide (attendu postgres://user:pass@host:port/base).`, {
      cause: error,
    })
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${origin} invalide : schéma « ${parsed.protocol} » refusé (attendu postgres://).`)
  }
  const port = parsed.port === '' ? DEFAULT_POSTGRES_PORT : Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${origin} invalide : port « ${parsed.port} » hors domaine 1-65535.`)
  }
  const user = safeDecode(parsed.username)
  const password = safeDecode(parsed.password)
  const database = safeDecode(parsed.pathname.replace(/^\//, ''))
  if (user === '' || password === '' || database === '') {
    // On ne recrache **jamais** l'URL : elle contiendrait le mot de passe.
    throw new Error(`${origin} invalide : utilisateur, mot de passe ou base manquant.`)
  }
  return {
    host: parsed.hostname === '' ? LOOPBACK_HOST : parsed.hostname,
    port,
    user,
    password,
    database,
  }
}

/** Recompose une URL (composants déjà validés par `parseDbUrl` ou générés). */
function formatDbUrl(parts: DbUrlParts): string {
  return `postgres://${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}/${encodeURIComponent(parts.database)}`
}

/* -------------------------------------------------------------------------- */
/* Mode dev                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Data dir dev : doit pointer sur **le même** `./pgdata` que `scripts/dev-db.ts`
 * (sinon on initialiserait un second catalogue). Candidats dans l'ordre :
 * `DEV_DB_DATA_DIR` explicite, puis source (`<__dirname>/../pgdata` = racine),
 * puis bundle (`<__dirname>/../../pgdata` = racine, `<__dirname>` y valant
 * `<racine>/dist-electron/main`), puis `<cwd>/pgdata`. Le premier existant
 * l'emporte ; à défaut, `cwd/pgdata` (défaut exact de `dev-db.ts`).
 *
 * **Aucun candidat hors projet** (rejet de la revue A4) : l'ancien candidat à
 * trois `..` (`<__dirname>/../../../pgdata`) tombait, depuis un bundle, sur
 * `<grand-parent>/pgdata` — ex. un `~/pgdata` posé sur le Bureau — et on aurait
 * initialisé/interrogé un catalogue qui n'est pas celui du projet.
 */
function resolveDevDataDir(): string {
  const override = process.env.DEV_DB_DATA_DIR
  if (override !== undefined && override !== '') {
    return path.resolve(override)
  }
  const candidates = [
    path.resolve(__dirname, '..', 'pgdata'), // source : <racine>/pgdata
    path.resolve(__dirname, '..', '..', 'pgdata'), // bundle : <racine>/pgdata
    path.resolve(process.cwd(), 'pgdata'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  log.info(`[env] répertoire pgdata dev introuvable : repli sur ${candidates[2]}`)
  return candidates[2]
}

function resolveDevDbConfig(): DbBaseConfig {
  const dotEnv = readDotEnvFile()
  const fromProcess = process.env.DATABASE_URL
  const fromDotEnv = dotEnv['DATABASE_URL']
  const rawUrl =
    fromProcess !== undefined && fromProcess !== ''
      ? fromProcess
      : fromDotEnv ?? DEV_DEFAULT_DATABASE_URL
  if (rawUrl === DEV_DEFAULT_DATABASE_URL) {
    // La comparaison est celle des **valeurs** : `.env` contient exactement
    // l'URL par défaut (127.0.0.1:5432) — dire « absente du .env » renverrait
    // le diagnostic vers un `.env` pourtant lu correctement.
    const fromParent = fromProcess !== undefined && fromProcess !== ''
    if (!fromParent && fromDotEnv === undefined) {
      log.warn('[env] DATABASE_URL absente de l’environnement et du .env : repli sur la base de dev par défaut (5432)')
    } else {
      log.info(
        `[env] DATABASE_URL ${fromParent ? 'de l’environnement parent' : 'du .env'} identique aux défauts dev ` +
          '(127.0.0.1:5432) : valeur utilisée telle quelle',
      )
    }
  }
  return { ...parseDbUrl(rawUrl, 'DATABASE_URL'), dataDir: resolveDevDataDir(), fileCorrupt: false }
}

/* -------------------------------------------------------------------------- */
/* Mode prod                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Schéma du `<userData>/config.json` persisté. `password` est du **base64** du
 * ciphertext `safeStorage` quand `encoding === 'safeStorage'`, sinon la valeur
 * en clair (fallback documenté ci-dessous).
 *
 * `authSecret` (étape 2.2a) : `AUTH_SECRET` de production, **généré une fois**
 * puis persisté via le même couple `safeStorage`/`config.json`. Il porte son
 * **propre** marqueur `authSecretEncoding` : `encoding` décrit le mot de passe
 * de la base, et les deux valeurs peuvent être réchiffrées indépendamment
 * (réchiffrement opportuniste de l'une sans l'autre) — les coupler reviendrait
 * à déchiffrer l'une avec le schéma de l'autre (erreur, ou secret corrompu).
 */
const storedEncodingSchema = z.enum(['safeStorage', 'plain'])

/**
 * Schémas **par champ** : la lecture du fichier est tolérante champ par champ
 * (étape 2.2b) — un champ invalide n'a le droit d'écarter **que lui-même**.
 * Un parseur binaire (tout-ou-rien) écartait `password`/`authSecret` dès qu'un
 * `port` mal recopié sautait, et la réécriture qui suivait détruisait alors le
 * seul exemplaire chiffré du mot de passe : verrouillage définitif du cluster.
 */
const persistedFieldSchemas = {
  port: z.number().int().min(1).max(65535),
  database: z.string().min(1).max(63),
  password: z.string().min(1),
  encoding: storedEncodingSchema,
  authSecret: z.string().min(1).max(512),
  authSecretEncoding: storedEncodingSchema,
  // Identifiant d'appareil (étape 3.2) : UUID persisté, stable sur la durée de
  // vie du poste — clé de la fenêtre de confiance hors-ligne (D-B).
  deviceId: z.string().min(1).max(128),
  // Jeton d'appareil du serveur central (étape 5.3) : **ciphertext** base64
  // `safeStorage` (ou valeur en clair dans le fallback documenté), même
  // discipline que `authSecret`. L'expiration voyage à côté (`syncTokenExpiresAt`),
  // chiffrée avec le **même** marqueur `syncTokenEncoding` : les deux sont
  // écrits/effacés/relus **en bloc**, un décodage mixte n'a aucun sens.
  syncToken: z.string().min(1).max(4096),
  syncTokenExpiresAt: z.string().min(1).max(128),
  syncTokenEncoding: storedEncodingSchema,
}

/** Schéma d'ensemble, dérivé des champs ci-dessus (source du type persisté). */
const persistedDbConfigSchema = z.object({
  port: persistedFieldSchemas.port.optional(),
  database: persistedFieldSchemas.database.optional(),
  password: persistedFieldSchemas.password.optional(),
  encoding: persistedFieldSchemas.encoding.optional(),
  authSecret: persistedFieldSchemas.authSecret.optional(),
  authSecretEncoding: persistedFieldSchemas.authSecretEncoding.optional(),
  deviceId: persistedFieldSchemas.deviceId.optional(),
  syncToken: persistedFieldSchemas.syncToken.optional(),
  syncTokenExpiresAt: persistedFieldSchemas.syncTokenExpiresAt.optional(),
  syncTokenEncoding: persistedFieldSchemas.syncTokenEncoding.optional(),
})

type PersistedDbConfig = z.infer<typeof persistedDbConfigSchema>
type StoredEncoding = z.infer<typeof storedEncodingSchema>

/** Répertoire utilisateur de l'app — **uniquement** accessible sous Electron. */
function resolveUserDataDir(): string {
  try {
    const directory = app.getPath('userData')
    mkdirSync(directory, { recursive: true })
    return directory
  } catch (error) {
    throw new Error(
      "Impossible de résoudre app.getPath('userData') : la configuration prod n'est disponible que dans le processus main d'Electron.",
      { cause: error },
    )
  }
}

/** Mot de passe aléatoire, **URL-safe** (aucun encodage requis dans l'URL). */
function generatePassword(): string {
  return randomBytes(24).toString('base64url')
}

/** Aides-contexte par secret : messages d'erreur paramétrés (une information, deux secrets). */
interface StoredSecretHints {
  /** Contexte de l'avertissement « en clair ». */
  readonly plain: string
  /** Phrase après « … le chiffrement est indisponible : ». */
  readonly unavailable: string
  /** Phrase de récupération après un déchiffrement échoué. */
  readonly corrupt: string
}

/**
 * Chiffre pour le stockage. `safeStorage` (DPAPI Windows) indisponible →
 * fichier en clair **avec avertissement explicite** : jamais de chute silencieuse.
 */
function encodeSecretForStorage(secret: string, label: string): { encoded: string; encoding: StoredEncoding } {
  if (safeStorage.isEncryptionAvailable()) {
    return { encoded: safeStorage.encryptString(secret).toString('base64'), encoding: 'safeStorage' }
  }
  log.warn(
    `[env] ⚠ safeStorage indisponible (DPAPI/keyring) : ${label} est écrit EN CLAIR dans ` +
      'config.json — fallback assumé mais dégradé. Restaurez DPAPI ou protégez ce fichier.',
  )
  return { encoded: secret, encoding: 'plain' }
}

function encodePasswordForStorage(password: string): { password: string; encoding: StoredEncoding } {
  const { encoded, encoding } = encodeSecretForStorage(password, 'le mot de passe de la base')
  return { password: encoded, encoding }
}

/**
 * Déchiffre une valeur persistée :
 * - clé absente → `null` (premier démarrage) ;
 * - en clair → valeur lue + avertissement explicite ;
 * - chiffré + `safeStorage` KO → **erreur explicite** (échec fermé) ;
 * - déchiffrement raté (fichier corrompu, autre compte Windows) → **erreur**.
 */
function decodeStoredSecret(
  stored: string | undefined,
  encoding: StoredEncoding | undefined,
  label: string,
  hints: StoredSecretHints,
): string | null {
  if (stored === undefined || stored === '') {
    return null
  }
  const effectiveEncoding = encoding ?? 'plain'
  if (effectiveEncoding === 'plain') {
    log.warn(
      `[env] ⚠ config.json contient ${label} EN CLAIR (${hints.plain}) — le chiffrement sera rétabli ` +
        'automatiquement dès que DPAPI redeviendra disponible.',
    )
    return stored
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `config.json stocke ${label} chiffré (safeStorage) mais le chiffrement est indisponible : ${hints.unavailable}`,
    )
  }
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (error) {
    throw new Error(
      `Échec du déchiffrement (${label}) dans config.json (fichier corrompu ou écrit par un autre ` +
        `compte Windows). ${hints.corrupt}`,
      { cause: error },
    )
  }
}

/** Récupération du mot de passe de la base (information identique à l'étape 2.1). */
const PASSWORD_HINTS: StoredSecretHints = {
  plain: 'safeStorage indisponible au premier démarrage',
  unavailable:
    'impossible de déchiffrer sans risquer de régénérer un mot de passe invalide. ' +
    'Restaurez l’accès Credential Manager (DPAPI), ou supprimez config.json pour régénérer la base locale.',
  corrupt: 'Restaurez le fichier ou supprimez-le pour régénérer la base locale.',
}

/**
 * Relit le mot de passe persisté — échec fermé : on ne régénère **jamais** un
 * mot de passe qui ouvrirait un cluster existant.
 */
function decodeStoredPassword(persisted: PersistedDbConfig): string | null {
  return decodeStoredSecret(persisted.password, persisted.encoding, 'le mot de passe de la base', PASSWORD_HINTS)
}

function writePersistedConfig(configPath: string, data: PersistedDbConfig): void {
  try {
    mkdirSync(path.dirname(configPath), { recursive: true })
    // `mode: 0o600` (étape 2.2b, revue B3) : propriétaire seul sous POSIX. Sous
    // Windows, le mode est ignoré par Node — l'ACL héritée du dossier
    // `userData` s'applique — sans effet de bord : le même appel reste valable.
    writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    log.info(`[env] configuration de la base persistée : ${configPath}`)
  } catch (error) {
    throw new Error(`Impossible d'écrire ${configPath} (configuration de la base non persistée).`, { cause: error })
  }
}

/**
 * Met de côté un `config.json` corrompu **avant toute réécriture**
 * (étape 2.2b, revue A1) : `config.json.corrupt-<timestamp>`. Ce fichier est le
 * seul endroit où a pu exister le chiffrement du mot de passe et du secret de
 * session — l'écraser silencieusement effacerait toute trace récupérable.
 * Renommage impossible (`EPERM`…) → **aucune réécriture** : on ne détruit jamais
 * un exemplaire qu'on n'a pas réussi à préserver.
 */
function quarantineCorruptConfig(configPath: string): string {
  const backupPath = `${configPath}.corrupt-${Date.now()}`
  try {
    renameSync(configPath, backupPath)
  } catch (error) {
    throw new Error(
      `Impossible de mettre de côté ${configPath} (attendu ${path.basename(backupPath)}) : réécriture refusée — ` +
        'un config.json corrompu n’est jamais écrasé sans sauvegarde.',
      { cause: error },
    )
  }
  log.warn(`[env] config.json corrompu conservé pour traçabilité : ${backupPath}`)
  return backupPath
}

/** Lecture **tolérante champ par champ** du `config.json` (étape 2.2b). */
interface PersistedConfigRead {
  readonly persisted: PersistedDbConfig
  /** `true` = fichier illisible **ou** portant au moins un champ invalide. */
  readonly fileCorrupt: boolean
  /** Noms (jamais de valeurs) des champs refusés par leur schéma. */
  readonly corruptFields: readonly string[]
}

function readPersistedConfig(configPath: string): PersistedConfigRead {
  if (!existsSync(configPath)) {
    return { persisted: {}, fileCorrupt: false, corruptFields: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    log.warn(
      `[env] config.json illisible (${error instanceof Error ? error.message : String(error)}) : aucun champ n'en ` +
        'est extrait et le fichier reste **en place** (jamais de réécriture sans sauvegarde préalable). ' +
        'Restaurez-le depuis une sauvegarde ou supprimez-le manuellement.',
    )
    return { persisted: {}, fileCorrupt: true, corruptFields: ['(illisible)'] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    log.warn('[env] config.json : contenu racine inattendu (un objet JSON est attendu) : aucun champ exploitable.')
    return { persisted: {}, fileCorrupt: true, corruptFields: ['(racine)'] }
  }
  const record = raw as Record<string, unknown>
  const persisted: PersistedDbConfig = {}
  const corruptFields: string[] = []
  for (const [key, schema] of Object.entries(persistedFieldSchemas)) {
    if (!(key in record)) {
      continue
    }
    const parsed = schema.safeParse(record[key])
    if (parsed.success) {
      // Un champ invalide n'écartera **que lui** : `password` et `authSecret`
      // survivent, par exemple, à un `port` illisible (et inversement).
      Object.assign(persisted, { [key]: parsed.data })
      continue
    }
    corruptFields.push(key)
  }
  if (corruptFields.length === 0) {
    return { persisted, fileCorrupt: false, corruptFields: [] }
  }
  log.warn(
    `[env] config.json : champ(s) invalide(s) ignoré(s), les autres restent exploitables : ` +
      `${corruptFields.join(', ')} (lecture tolérante champ par champ, jamais de régénération muette).`,
  )
  return { persisted, fileCorrupt: true, corruptFields }
}

/**
 * Conserve les clés `authSecret`/`authSecretEncoding` lors d'une **réécriture**
 * du fichier ( premier démarrage ou réchiffrement du mot de passe ) : leur
 * encodage est autonome, le transport brut est donc toujours sûr. Sans cela,
 * régénérer le mot de passe effacerait aussi `AUTH_SECRET` (sessions prod
 * déconnectées à chaque démarrage).
 */
function carryAuthSecret(persisted: PersistedDbConfig): Pick<PersistedDbConfig, 'authSecret' | 'authSecretEncoding'> {
  return {
    ...(persisted.authSecret !== undefined ? { authSecret: persisted.authSecret } : {}),
    ...(persisted.authSecretEncoding !== undefined ? { authSecretEncoding: persisted.authSecretEncoding } : {}),
  }
}

/**
 * Conserve le `deviceId` lors d'une **réécriture** du `config.json`
 * (étape 3.2) : régénérer cet identifiant à chaque réécriture effacerait la
 * clé de la fenêtre de confiance hors-ligne — la confiance déjà ouverte
 * deviendrait inexploitable et le serveur central verrait un « nouvel
 * appareil » à chaque démarrage. Même mécanique que `carryAuthSecret`.
 */
function carryDeviceId(persisted: PersistedDbConfig): Pick<PersistedDbConfig, 'deviceId'> {
  return persisted.deviceId !== undefined ? { deviceId: persisted.deviceId } : {}
}

/**
 * Conserve le jeton de synchronisation (`syncToken` / `syncTokenExpiresAt` +
 * marqueur `syncTokenEncoding`) lors d'une **réécriture** du `config.json`
 * motivée par un **autre** champ (étape 5.3) : le jeton émis par
 * `POST /api/sync/token` est chiffré `safeStorage` ici même, et une
 * réécriture de premier démarrage/réchiffrement ne doit jamais l'effacer (le
 * poste devrait sinon retaper ses identifiants au prochain démarrage). Même
 * mécanique que `carryAuthSecret`/`carryDeviceId`. Le jeton est un secret :
 * seules sa présence et sa validité sont journalisables, jamais sa valeur.
 */
function carrySyncToken(
  persisted: PersistedDbConfig,
): Pick<PersistedDbConfig, 'syncToken' | 'syncTokenExpiresAt' | 'syncTokenEncoding'> {
  return {
    ...(persisted.syncToken !== undefined ? { syncToken: persisted.syncToken } : {}),
    ...(persisted.syncTokenExpiresAt !== undefined ? { syncTokenExpiresAt: persisted.syncTokenExpiresAt } : {}),
    ...(persisted.syncTokenEncoding !== undefined ? { syncTokenEncoding: persisted.syncTokenEncoding } : {}),
  }
}

/**
 * Message d'action explicite (récupération, jamais de régénération muette) quand
 * un cluster existe et que son mot de passe n'est pas récupérable : réécrire
 * `config.json` ferait disparaître le seul exemplaire chiffré → accès aux
 * données du cabinet verrouillé **définitivement**.
 */
function unrecoverablePasswordMessage(
  configPath: string,
  dataDir: string,
  fileCorrupt: boolean,
  corruptFields: readonly string[],
): string {
  const reason = fileCorrupt
    ? `config.json corrompu (champ(s) invalide(s) : ${corruptFields.length > 0 ? corruptFields.join(', ') : 'illisible'})`
    : 'config.json ne contient plus de mot de passe exploitable'
  return (
    `Le cluster PostgreSQL de ${dataDir} existe déjà mais le mot de passe de ${configPath} n'est pas récupérable ` +
    `(${reason}) : réécrire ce fichier verrouillerait définitivement les données du cabinet. ` +
    'Restaurez config.json depuis une sauvegarde (le déchiffrement exige que Credential Manager/DPAPI soit ' +
    'accessible au compte Windows courant), ou supprimez à la fois config.json ET ce répertoire de données ' +
    'pour repartir de zéro (perte des données du cabinet).'
  )
}

/**
 * Config prod (étape 2.2b — reprise complète de la lecture/écriture) :
 *
 * 1. **lecture tolérante champ par champ** : un champ invalide n'écartera que
 *    lui-même (`password`/`authSecret` survivent à un `port` illisible) ;
 * 2. **échec fermé sur cluster vivant** : si `<dataDir>/PG_VERSION` existe et
 *    que le mot de passe n'est pas récupérable (champ corrompu, déchiffrement
 *    impossible, clé absente), on **refuse d'écrire** et on rejette avec un
 *    message de récupération — jamais de régénération par-dessus ;
 * 3. **traçabilité** : un fichier corrompu est renommé
 *    `config.json.corrupt-<timestamp>` **avant toute réécriture** ;
 * 4. `fileCorrupt` est **porté** jusqu'à `buildNextEnv()` : le `AUTH_SECRET` n'y
 *    sera jamais régénéré par-dessus un fichier à restaurer.
 */
function resolveProdDbConfig(dataDirOverride: string | undefined): DbBaseConfig {
  const userDataDir = resolveUserDataDir()
  const configPath = path.join(userDataDir, 'config.json')
  const dataDir = dataDirOverride ?? path.join(userDataDir, 'pgdata')
  // Un cluster existant = des données vivantes : le moindre risque de verrouillage
  // est refusé avant toute écriture.
  const clusterExists = existsSync(path.join(dataDir, 'PG_VERSION'))

  const { persisted, fileCorrupt, corruptFields } = readPersistedConfig(configPath)

  // Un `password` ou `encoding` invalide rend le mot de passe **non
  // récupérable** : le déchiffrer « à l'aveugle » produirait un mot de passe
  // faux, que la réécriture écraserait par-dessus le seul exemplaire valable.
  const passwordFieldUsable = !corruptFields.includes('password') && !corruptFields.includes('encoding')
  let storedPassword: string | null = null
  if (passwordFieldUsable) {
    try {
      storedPassword = decodeStoredPassword(persisted)
    } catch (error) {
      if (!clusterExists) {
        // Comportement inchangé (échec fermé) : aucun cluster à verrouiller.
        throw error
      }
      throw new Error(unrecoverablePasswordMessage(configPath, dataDir, fileCorrupt, corruptFields), {
        cause: error,
      })
    }
  }

  // Règle absolue : cluster vivant + mot de passe non récupérable → **aucune
  // écriture** (le fichier corrompu reste en place, intact, pour restauration).
  if (storedPassword === null && clusterExists) {
    throw new Error(unrecoverablePasswordMessage(configPath, dataDir, fileCorrupt, corruptFields))
  }

  const port = persisted.port ?? PROD_DEFAULT_PORT
  const database = persisted.database ?? DEFAULT_DATABASE
  const password = storedPassword ?? generatePassword()
  const isIncomplete =
    persisted.port === undefined ||
    persisted.database === undefined ||
    persisted.encoding === undefined ||
    storedPassword === null
  // Rétablissement opportuniste du chiffrement (fallback « clair » réversible).
  const mayReencrypt = persisted.encoding === 'plain' && safeStorage.isEncryptionAvailable()

  if (isIncomplete || fileCorrupt || mayReencrypt) {
    if (storedPassword === null) {
      log.info('[env] premier démarrage : mot de passe de la base locale généré')
    } else if (mayReencrypt) {
      log.info('[env] safeStorage de retour : réchiffrement du mot de passe dans config.json')
    }
    if (fileCorrupt) {
      // Traçabilité : jamais de réécriture par-dessus un fichier corrompu sans
      // l'avoir mis de côté (le renommage échoué bloque toute écriture).
      quarantineCorruptConfig(configPath)
    }
    // Ne recopie `authSecret` que s'il n'est pas lui-même en cause : porter une
    // valeur dont l'encodage est illisible produirait un secret faux au
    // démarrage suivant (l'exemplaire d'origine reste dans le fichier mis de côté).
    const carried =
      corruptFields.includes('authSecret') || corruptFields.includes('authSecretEncoding')
        ? {}
        : carryAuthSecret(persisted)
    // Même garde pour `deviceId` (étape 3.2) : une réécriture ne doit jamais
    // régénérer l'identifiant d'appareil porteur de la confiance hors-ligne.
    const carriedDevice = corruptFields.includes('deviceId') ? {} : carryDeviceId(persisted)
    // Même garde pour le jeton de sync (étape 5.3) : une réécriture motivée par
    // un autre champ ne doit jamais effacer un jeton encore valide — un champ
    // de jeton corrompu n'est pas recopié (sa valeur ne serait plus déchiffrable
    // de toute façon, l'exemplaire d'origine reste dans la mise de côté).
    const carriedSyncToken =
      corruptFields.includes('syncToken') ||
      corruptFields.includes('syncTokenExpiresAt') ||
      corruptFields.includes('syncTokenEncoding')
        ? {}
        : carrySyncToken(persisted)
    writePersistedConfig(configPath, {
      ...carried,
      ...carriedDevice,
      ...carriedSyncToken,
      port,
      database,
      ...encodePasswordForStorage(password),
    })
  }

  return {
    host: LOOPBACK_HOST,
    port,
    user: DEFAULT_USER,
    password,
    database,
    dataDir,
    fileCorrupt,
  }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Détermine la configuration de la base locale.
 *
 * 1. **Mode** : `overrides.mode`, sinon `ELECTRON_DEV === "1"` → `dev`, sinon `prod` ;
 * 2. **Base** : dev → `.env`/`DATABASE_URL` (défaut 5432 + `./pgdata`) ;
 *    prod → `<userData>/config.json` (port 5433, mot de passe chiffré) ;
 * 3. **Surcharge** : les `overrides` s'appliquent en dernier (tests) ;
 * 4. **Journalisation** : composants seuls — **jamais** l'URL ni le mot de passe.
 */
export function resolveDbConfig(overrides: DbConfigOverrides = {}): DbConfig {
  const mode: DbMode = overrides.mode ?? (process.env.ELECTRON_DEV === '1' ? 'dev' : 'prod')
  // En prod, l'éventuelle surcharge de répertoire (tests d'intégration) doit
  // être prise en compte **dès** la détection de cluster (`PG_VERSION`) :
  // c'est le répertoire réellement utilisé qui décide du risque de verrouillage.
  const prodDataDir = overrides.dataDir === undefined ? undefined : path.resolve(overrides.dataDir)
  const base = mode === 'dev' ? resolveDevDbConfig() : resolveProdDbConfig(prodDataDir)
  const parts: DbUrlParts = {
    host: base.host,
    port: overrides.port ?? base.port,
    user: overrides.user ?? base.user,
    password: overrides.password ?? base.password,
    database: overrides.database ?? base.database,
  }
  const dataDir = overrides.dataDir === undefined ? base.dataDir : path.resolve(overrides.dataDir)
  const config: DbConfig = {
    url: formatDbUrl(parts),
    port: parts.port,
    user: parts.user,
    password: parts.password,
    database: parts.database,
    dataDir,
    mode,
    // Signal `fileCorrupt` (prod) : porté jusqu'à `buildNextEnv()`, qui échoue
    // en cas de corruption au lieu de régénérer `AUTH_SECRET`.
    fileCorrupt: base.fileCorrupt,
  }
  log.info(
    // L'hôte n'est **pas** toujours le bouclage : en dev il vient du
    // `DATABASE_URL` du `.env` (voir C2) — on journalise l'hôte réel, jamais
    // l'URL ni le mot de passe.
    `[env] base locale ${mode} : ${parts.host}:${config.port}/${config.database} ` +
      `(user=${config.user}, dataDir=${config.dataDir})`,
  )
  return config
}

/* -------------------------------------------------------------------------- */
/* Environnement du serveur Next.js (étape 2.2a)                               */
/* -------------------------------------------------------------------------- */

/** Libellé d'erreur/journal d'`AUTH_SECRET` — la **valeur** n'est jamais loguée. */
const AUTH_SECRET_LABEL = 'AUTH_SECRET'
/** Longueur minimale exigée en dev (recommandation NextAuth : ≥ 32 caractères). */
const AUTH_SECRET_MIN_LENGTH = 32

/** Récupération d'`AUTH_SECRET` prod (échec fermé : jamais de régénération silencieuse). */
const AUTH_SECRET_HINTS: StoredSecretHints = {
  plain: 'safeStorage indisponible à sa création',
  unavailable:
    'impossible de déchiffrer sans risquer de régénérer un secret différent — toutes les sessions ' +
    'ouvertes seraient invalidées. Restaurez l’accès Credential Manager (DPAPI), ou retirez la clé ' +
    '« authSecret » de config.json pour accepter une régénération.',
  corrupt:
    'Retirez la clé « authSecret » de config.json pour la régénérer (les sessions ouvertes seront ' +
    'invalidées).',
}

/** Détecte les noms de clés signalant un secret dans l'environnement hérité. */
const INHERITED_SECRET_KEY_PATTERN =
  /(DATABASE_URL|AUTH_SECRET|AUTH_SECRET_KEY|POSTGRES_PASSWORD|PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)/i

/**
 * Signale les secrets déjà présents dans `process.env` — donc **transmis tels
 * quels** au serveur Next (le reste de l'environnement parent est conservé par
 * conception). Noms de clés **seulement**, jamais de valeurs.
 */
function warnInheritedSecrets(): void {
  const names = Object.keys(process.env).filter((key) => INHERITED_SECRET_KEY_PATTERN.test(key))
  if (names.length === 0) {
    return
  }
  log.warn(
    `[env] ${names.length} clé(s) sensible(s) héritée(s) de process.env transmise(s) telles quelles au ` +
      `serveur Next (noms seuls) : ${names.join(', ')}`,
  )
}

/**
 * `AUTH_SECRET` en **dev** : repris de l'environnement parent puis du `.env`
 * (même précédence que Next/dotenv), **jamais régénéré** — une régénération à
 * chaque démarrage invaliderait les sessions de dev et divergerait du `next dev`
 * éventuellement réutilisé (qui lit le `.env` lui-même).
 */
function resolveDevAuthSecret(): string {
  const fromProcess = process.env.AUTH_SECRET
  const raw = fromProcess !== undefined && fromProcess !== '' ? fromProcess : readDotEnvFile()['AUTH_SECRET']
  if (raw === undefined || raw === '') {
    throw new Error(
      `${AUTH_SECRET_LABEL} introuvable dans l'environnement ni dans le .env : renseignez-le (≥ ` +
        `${AUTH_SECRET_MIN_LENGTH} caractères) — en dev il n'est jamais régénéré automatiquement. ` +
        `Génération : node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`,
    )
  }
  if (raw.length < AUTH_SECRET_MIN_LENGTH) {
    throw new Error(
      `${AUTH_SECRET_LABEL} trop court (${raw.length} caractères, minimum ${AUTH_SECRET_MIN_LENGTH}) : ` +
        'rallongez la valeur dans le .env (jamais régénérée automatiquement en dev).',
    )
  }
  return raw
}

/**
 * `AUTH_SECRET` en **prod** : lecture de `config.json` (clé `authSecret`,
 * chiffrée via `safeStorage`), sinon `randomBytes(32)` base64url **généré une
 * seule fois** puis persisté. Réchiffrement opportuniste si la valeur reposait
 * en clair et que DPAPI est de retour. La valeur n'est **jamais** journalisée.
 */
function resolveOrCreateAuthSecret(): string {
  const configPath = path.join(resolveUserDataDir(), 'config.json')
  const { persisted, fileCorrupt } = readPersistedConfig(configPath)
  if (fileCorrupt) {
    // Garde de **second niveau** : `buildNextEnv()` a déjà rejeté sur le signal
    // `fileCorrupt` porté par `resolveDbConfig()` (le fichier a pu être mis de
    // côté/réécrit entre-temps, d'où cette relecture défensive).
    throw new Error(
      `config.json illisible : ${AUTH_SECRET_LABEL} de production impossible à résoudre sans risquer une ` +
        'régénération à chaque démarrage (sessions perpétuellement invalidées). Restaurez ce fichier, ' +
        'ou supprimez-le pour régénérer la configuration complète.',
    )
  }
  // Repli **délibéré** et documenté (revue C4) : `authSecretEncoding` n'existe
  // que depuis la persistance dédiée d'`AUTH_SECRET`. Un fichier plus ancien
  // porte ce secret sous l'unique marqueur `encoding` du fichier : ce marqueur
  // est alors **historiquement le bon** (le secret y a été chiffré avec le même
  // schéma que le mot de passe). Ce n'est **pas** un couplage des deux
  // marqueurs : dès que `authSecretEncoding` est présent, il fait seul foi, et
  // `decodeStoredSecret` échoue fermé si le déchiffrement échoue — jamais de
  // régénération silencieuse en cas de divergence réelle.
  const storedEncoding = persisted.authSecretEncoding ?? persisted.encoding
  const decoded = decodeStoredSecret(persisted.authSecret, storedEncoding, AUTH_SECRET_LABEL, AUTH_SECRET_HINTS)
  if (decoded !== null) {
    const reencoded = encodeSecretForStorage(decoded, AUTH_SECRET_LABEL)
    if (reencoded.encoding !== (storedEncoding ?? 'plain')) {
      log.info('[env] safeStorage de retour : réchiffrement de AUTH_SECRET dans config.json')
      writePersistedConfig(configPath, {
        ...persisted,
        authSecret: reencoded.encoded,
        authSecretEncoding: reencoded.encoding,
      })
    }
    return decoded
  }
  const secret = randomBytes(32).toString('base64url')
  const { encoded, encoding } = encodeSecretForStorage(secret, AUTH_SECRET_LABEL)
  writePersistedConfig(configPath, { ...persisted, authSecret: encoded, authSecretEncoding: encoding })
  log.info('[env] AUTH_SECRET de production généré et persisté (valeur jamais journalisée)')
  return secret
}

/**
 * `UPLOAD_DIR` :
 * - **dev** : `<racine>/uploads` (dossier du dépôt, déjà existant) ;
 * - **prod** : `<userData>/uploads` (créé si absent).
 */
function resolveUploadDir(config: DbConfig): string {
  const directory =
    config.mode === 'prod' ? path.join(resolveUserDataDir(), 'uploads') : path.join(resolveDevProjectRoot(), 'uploads')
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw new Error(`Impossible de créer le répertoire de pièces jointes (UPLOAD_DIR) : ${directory}`, { cause: error })
  }
  return directory
}

/* -------------------------------------------------------------------------- */
/* Confiance d'appareil (étape 3.2 — D-B / D-A)                                */
/* -------------------------------------------------------------------------- */

/** `TRUST_DAYS` par défaut : 30 j (même valeur que `DEFAULT_TRUST_TTL_MS`). */
const DEFAULT_TRUST_DAYS = 30
/**
 * Plafond de sanityité pour `TRUST_DAYS` : une valeur absurde (milliers de
 * jours) désactiverait de facto la limite de confiance hors-ligne. 10 ans
 * reste très largement au-dessus de tout usage raisonnable.
 */
const MAX_TRUST_DAYS = 3650

/**
 * Identifiant d'appareil (D-B) : UUID stable **persisté** dans
 * `<userData>/config.json`, généré au premier démarrage. Fonctionne aussi en
 * dev (le processus main Electron a toujours un `userData`). L'identifiant
 * d'appareil n'est pas un secret : il est journalisé (traçabilité du couple
 * app/registre `device`).
 *
 * Discipline identique au reste du fichier : un `config.json` corrompu est
 * mis de côté (`quarantineCorruptConfig`) avant toute réécriture, jamais
 * écrasé silencieusement.
 */
export function resolveDeviceId(): string {
  const configPath = path.join(resolveUserDataDir(), 'config.json')
  const { persisted, fileCorrupt } = readPersistedConfig(configPath)
  if (!fileCorrupt && persisted.deviceId !== undefined) {
    return persisted.deviceId
  }
  const deviceId = randomUUID()
  if (fileCorrupt) {
    // Traçabilité (même règle que `resolveProdDbConfig`) : jamais de
    // réécriture par-dessus un fichier corrompu sans l'avoir conservé.
    quarantineCorruptConfig(configPath)
  }
  writePersistedConfig(configPath, { ...persisted, deviceId })
  log.info(`[env] DEVICE_ID généré et persisté : ${deviceId}`)
  return deviceId
}

/**
 * `SYNC_BASE_URL` (optionnelle) : origine du serveur central. Présente → le
 * contrôle de confiance est actif (`src/lib/auth.ts`, décision D-A) ; absente
 * → mode désactivé, comportement web historique. Reprise de l'environnement
 * parent, puis du `.env`/`.env.local` **en dev uniquement** (même précédence
 * que `resolveDevAuthSecret`). Une valeur **malformée est refusée** : la
 * laisser passer désactiverait silencieusement le contrôle (fail-open).
 */
function resolveSyncBaseUrl(mode: DbMode): string | undefined {
  const fromProcess = process.env.SYNC_BASE_URL
  const raw =
    fromProcess !== undefined && fromProcess !== ''
      ? fromProcess
      : mode === 'dev'
        ? readDotEnvFile()['SYNC_BASE_URL']
        : undefined
  if (raw === undefined || raw === '') {
    return undefined
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new Error(`SYNC_BASE_URL illisible : « ${raw} » n'est pas une URL valide (attendu https://…).`, {
      cause: error,
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`SYNC_BASE_URL invalide : schéma « ${parsed.protocol} » refusé (attendu http(s)).`)
  }
  return raw
}

/**
 * `TRUST_DAYS` : entier **positif**, défaut 30. Une valeur invalide est
 * **rejetée au démarrage** (jamais remplacée silencieusement par le défaut) :
 * une fenêtre de confiance mal calibrée est un risque de sécurité, pas un
 * détail de confort. `.env` consulté en dev uniquement (cf. `SYNC_BASE_URL`).
 */
function resolveTrustDays(mode: DbMode): number {
  const fromProcess = process.env.TRUST_DAYS
  const raw =
    fromProcess !== undefined && fromProcess !== ''
      ? fromProcess
      : mode === 'dev'
        ? readDotEnvFile()['TRUST_DAYS']
        : undefined
  if (raw === undefined || raw === '') {
    return DEFAULT_TRUST_DAYS
  }
  const days = Number(raw)
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRUST_DAYS) {
    throw new Error(
      `TRUST_DAYS invalide : « ${raw} » n'est pas un entier positif ≤ ${MAX_TRUST_DAYS} ` +
        `(défaut ${DEFAULT_TRUST_DAYS}). Corrigez le .env ou l'environnement.`,
    )
  }
  return days
}

/* -------------------------------------------------------------------------- */
/* Jeton de synchronisation du serveur central (étape 5.3)                     */
/* -------------------------------------------------------------------------- */

/**
 * Jeton d'appareil émis par `POST /api/sync/token`, persisté dans
 * `<userData>/config.json` **chiffré via `safeStorage`** (Credential Manager
 * Windows / DPAPI), exactement comme le mot de passe de la base et
 * `AUTH_SECRET` : mêmes helpers `encodeSecretForStorage`/`decodeStoredSecret`,
 * même fallback documenté (en clair + `log.warn` explicite si `safeStorage`
 * est indisponible, jamais de chute silencieuse).
 *
 * Le couple `syncToken`/`syncTokenExpiresAt` est **chiffré en bloc** sous
 * l'unique marqueur `syncTokenEncoding` : les deux clés sont toujours lues,
 * écrites et effacées ensemble (un décodage mixte — un clair, un chiffré —
 * n'a aucun sens et serait rejeté à la relecture).
 *
 * discipline journal : la **valeur** du jeton n'est **jamais** journalisée
 * (ni clair, ni hash) — seules la présence, l'expiration ou les causes de
 * rejet le sont.
 */

/** Libellé d'erreur/journal du jeton — la **valeur** n'est jamais loguée. */
const SYNC_TOKEN_LABEL = 'le jeton de synchronisation'

/**
 * Schéma du **clair décodé** : couple (jeton, expiration ISO). Valide les deux
 * directions — entrée de `writeSyncToken` (erreur de programme si invalide) et
 * sortie de `readSyncToken` (rejet tolérant si le décodage produit n'importe
 * quoi).
 */
const decodedSyncTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  expiresAt: z.iso.datetime(),
})

/**
 * Récupération du jeton. Contrairement au mot de passe de la base et à
 * `AUTH_SECRET` (échec **fermé** : jamais de régénération par-dessus un secret
 * verrouillant un cluster ou des sessions), un jeton illisible n'est qu'une
 * habilitation perdue : un nouvel échange `POST /api/sync/token` le régénère.
 * Ces fonctions renvoient donc `null` au lieu de lever.
 */
const SYNC_TOKEN_HINTS: StoredSecretHints = {
  plain: 'safeStorage indisponible à la dernière écriture du jeton',
  unavailable:
    'un nouvel échange via POST /api/sync/token le régénérera (aucune donnée perdue : le jeton n’est qu’une habilitation).',
  corrupt:
    'un nouvel échange via POST /api/sync/token le régénérera (aucune donnée perdue).',
}

/**
 * Lit le jeton persisté. Renvoie `null` si le jeton est absent, corrompu,
 * non déchiffrable ou malformé (échec fermé **d'usage**, jamais de levée).
 * Un jeton **expiré** est renvoyé tel quel (loggé « présent mais EXPIRÉ » sans
 * valeur) : la politique de ré-authentification revient à l'orchestrateur
 * (étape 5.4), qui compare `expiresAt` à son horloge injectée.
 */
export function readSyncToken(): { token: string; expiresAt: string } | null {
  const configPath = path.join(resolveUserDataDir(), 'config.json')
  const { persisted, corruptFields } = readPersistedConfig(configPath)
  const tokenFieldCorrupt = corruptFields.some((field) => field.startsWith('syncToken'))
  if (persisted.syncToken === undefined || persisted.syncTokenExpiresAt === undefined) {
    if (tokenFieldCorrupt) {
      log.warn(
        '[env] jeton de sync illisible (champ corrompu) : ignoré — un nouvel échange POST /api/sync/token le ' +
          'régénérera (valeur jamais journalisée).',
      )
    }
    return null
  }
  let decodedToken: string | null
  let decodedExpiresAt: string | null
  try {
    decodedToken = decodeStoredSecret(
      persisted.syncToken,
      persisted.syncTokenEncoding,
      SYNC_TOKEN_LABEL,
      SYNC_TOKEN_HINTS,
    )
    decodedExpiresAt = decodeStoredSecret(
      persisted.syncTokenExpiresAt,
      persisted.syncTokenEncoding,
      SYNC_TOKEN_LABEL,
      SYNC_TOKEN_HINTS,
    )
  } catch (error) {
    // Échec fermé d'usage : on n'utilise jamais un jeton qu'on n'a pas pu
    // déchiffrer, mais on ne lève pas — la récupération est un ré-échange.
    log.warn(
      `[env] jeton de sync non déchiffrable : ignoré (${error instanceof Error ? error.message : String(error)}) — ` +
        'un nouvel échange POST /api/sync/token le régénérera.',
    )
    return null
  }
  const parsed = decodedSyncTokenSchema.safeParse({
    token: decodedToken,
    expiresAt: decodedExpiresAt,
  })
  if (!parsed.success) {
    log.warn(
      '[env] jeton de sync malformé après décodage : ignoré (valeur jamais journalisée) — un nouvel échange ' +
        'POST /api/sync/token le régénérera.',
    )
    return null
  }
  const expired = Date.now() >= Date.parse(parsed.data.expiresAt)
  log.info(
    `[env] jeton de sync ${expired ? 'présent mais EXPIRÉ' : 'présent et valide'} (valeur jamais journalisée)`,
  )
  return { token: parsed.data.token, expiresAt: parsed.data.expiresAt }
}

/**
 * Persiste le jeton (chiffré `safeStorage`) — valide ses entrées au préalable
 * (Zod) : une expiration non-ISO ou un jeton vide est une **erreur de
 * programme**, jamais une condition à absorber silencieusement.
 *
 * Discipline identique à `resolveDeviceId` : un `config.json` corrompu est mis
 * de côté (`quarantineCorruptConfig`) **avant toute réécriture**, jamais écrasé
 * sans sauvegarde. Une réécriture conserve les champs valides déjà présents
 * (`persisted`) : écrire le jeton ne régénère ni le mot de passe, ni
 * `AUTH_SECRET`, ni le `deviceId`.
 */
export function writeSyncToken(token: string, expiresAt: string): void {
  const parsed = decodedSyncTokenSchema.safeParse({ token, expiresAt })
  if (!parsed.success) {
    throw new Error(
      'writeSyncToken : jeton vide ou expiration non-ISO invalide — aucune persistance effectuée ' +
        '(erreur de programme, la valeur n’est pas journalisée).',
    )
  }
  const configPath = path.join(resolveUserDataDir(), 'config.json')
  const { persisted, fileCorrupt } = readPersistedConfig(configPath)
  if (fileCorrupt) {
    quarantineCorruptConfig(configPath)
  }
  // Les deux champs sont chiffrés par le MÊME appel à `encodeSecretForStorage`
  // conceptuel : `safeStorage.isEncryptionAvailable()` est stable au sein d'un
  // process, les deux encodages sont donc identiques — le marqueur unique
  // `syncTokenEncoding` décrit le couple en bloc.
  const encodedToken = encodeSecretForStorage(parsed.data.token, SYNC_TOKEN_LABEL)
  const encodedExpiresAt = encodeSecretForStorage(
    parsed.data.expiresAt,
    'l’expiration du jeton de synchronisation',
  )
  writePersistedConfig(configPath, {
    ...persisted,
    syncToken: encodedToken.encoded,
    syncTokenExpiresAt: encodedExpiresAt.encoded,
    syncTokenEncoding: encodedToken.encoding,
  })
  log.info('[env] jeton de sync persisté chiffré (valeur jamais journalisée)')
}

/**
 * Efface le jeton (`clearSyncToken`) — idempotent, sans effet si aucun champ
 * de jeton n'existe (aucune réécriture inutile du fichier). Un champ de jeton
 * **corrompu** compte comme « présent » : il sera retiré par la réécriture
 * (après mise de côté du fichier, même discipline que `writeSyncToken`).
 * Les autres champs du `config.json` sont recopiés tels quels.
 */
export function clearSyncToken(): void {
  const configPath = path.join(resolveUserDataDir(), 'config.json')
  if (!existsSync(configPath)) {
    return
  }
  const { persisted, fileCorrupt, corruptFields } = readPersistedConfig(configPath)
  const tokenFieldCorrupt = corruptFields.some((field) => field.startsWith('syncToken'))
  const hadTokenField =
    persisted.syncToken !== undefined ||
    persisted.syncTokenExpiresAt !== undefined ||
    persisted.syncTokenEncoding !== undefined ||
    tokenFieldCorrupt
  if (!hadTokenField) {
    return
  }
  if (fileCorrupt) {
    quarantineCorruptConfig(configPath)
  }
  const {
    syncToken: _syncToken,
    syncTokenExpiresAt: _syncTokenExpiresAt,
    syncTokenEncoding: _syncTokenEncoding,
    ...rest
  } = persisted
  writePersistedConfig(configPath, rest)
  log.info('[env] jeton de sync effacé de config.json')
}

/**
 * Construit l'environnement du **processus enfant Next.js** (étape 2.2a).
 *
 * Ordre de résolution dans `main.ts` : `resolveDbConfig()` → `startLocalDb()`
 * → **cette fonction** → `startNextServer({ env })`.
 *
 * - **garde `fileCorrupt` (étape 2.2b)** : si `config.json` était corrompu au
 *   démarrage, on **rejette ici**, avant toute génération — régénérer
 *   `AUTH_SECRET` par-dessus un fichier à restaurer invaliderait toutes les
 *   sessions ouvertes alors que le message promet « restaurez ce fichier » ;
 * - `DATABASE_URL` : URL prête de la base locale (déjà démarrée ou réutilisée) ;
 * - `AUTH_SECRET` : dev → valeur du `.env` (**jamais** régénérée) ; prod →
 *   `randomBytes(32)` généré une fois et persisté (`safeStorage`/`config.json`) ;
 * - `AUTH_URL` : `http://localhost:<port Next>` — le port est recalculé
 *   avec `resolveNextPort()`, la **même logique que `next.ts`** (`process.env.PORT`
 *   validé, sinon 3000), car le handle du serveur n'existe pas encore à ce
 *   stade du démarrage : deux sources de port divergentes casseraient les
 *   cookies/redirects de NextAuth ;
 * - `HOSTNAME` = bouclage strict, `PORT` = port Next (inchangé en dev pour ne
 *   pas entrer en conflit avec `next dev -p`), `NODE_ENV` = `production` **en
 *   prod seulement** (en dev, `next dev` fixe `development` lui-même) ;
 * - `UPLOAD_DIR` : `<racine>/uploads` (dev) ou `<userData>/uploads` (prod) ;
 * - `DEVICE_ID` (étape 3.2) : UUID d'appareil persisté dans
 *   `<userData>/config.json` (D-B) — identifie le poste, y compris en dev ;
 * - `SYNC_BASE_URL` (étape 3.2, optionnelle) : serveur central. Absente → le
 *   contrôle de confiance n'est pas opposable (D-A) ; malformée → démarrage
 *   refusé (jamais de fail-open silencieux) ;
 * - `TRUST_DAYS` (étape 3.2) : entier positif, défaut 30, invalide → refus au
 *   démarrage ;
 * - `SYNC_TOKEN` (tâche 6.1c) : jeton d'appareil, **uniquement s'il est présent
 *   et non expiré** (jamais de jeton périmé transmis) — sert à réserver des
 *   blocs de numéros via `POST /api/sync/blocks` ; la valeur n'est jamais
 *   journalisée (seule sa présence l'est). Le jeton change au plus tous les
 *   30 jours ou à la reconnexion ; un changement nécessite le redémarrage de
 *   l'enfant Next (géré à l'étape 7) ;
 * - **reste de `process.env` conservé** (héritage du parent) — les secrets qui
 *   y traînent sont signalés (noms seuls) par `warnInheritedSecrets()`.
 *
 * Ni `DATABASE_URL`, ni `AUTH_SECRET`, ni `SYNC_TOKEN` ne sont jamais journalisés.
 */
export function buildNextEnv(db: LocalDbHandle, config: DbConfig): NodeJS.ProcessEnv {
  // Garde `fileCorrupt` (étape 2.2b, revue A1-i) : `config.json` était corrompu
  // au démarrage. Sans ce signal — propagé par `resolveDbConfig()` — la garde de
  // `resolveOrCreateAuthSecret()` n'était **jamais** atteinte (`resolveProdDbConfig()`
  // réécrivait le fichier avant sa relecture) et un nouvel `AUTH_SECRET` était
  // régénéré silencieusement par-dessus : toutes les sessions invalidées, alors
  // même que le message promettait « restaurez ce fichier ». Ici : échec
  // propre, avant toute génération.
  if (config.fileCorrupt === true) {
    // Pondération du conseil de récupération selon l'état réel du cluster
    // (étape 2.2c) : si un cluster PostgreSQL existe déjà dans `dataDir`,
    // supprimer `config.json` **ne régénère rien** — le démarrage suivant
    // échouera sur `unrecoverablePasswordMessage()` (mot de passe produit
    // ≠ mot de passe initdb) et imposera de supprimer `pgdata` = **perte
    // définitive des données du cabinet**. Dans ce cas : restauration du
    // fichier, jamais la suppression du répertoire.
    const clusterPresent = existsSync(path.join(config.dataDir, 'PG_VERSION'))
    const recoveryHint = clusterPresent
      ? `Un cluster PostgreSQL existe déjà dans ${config.dataDir} : ne supprimez **jamais** ce répertoire ` +
        '(destruction définitive des données du cabinet). Restaurez à la place un exemplaire ' +
        'config.json.corrupt-<timestamp> conservé à côté, ou récupérez le mot de passe du cluster.'
      : 'Restaurez ce fichier (un exemplaire config.json.corrupt-<timestamp> est conservé à côté s’il a été ' +
        'réécrit), ou supprimez-le pour régénérer la configuration complète.'
    throw new Error(
      'config.json corrompu : AUTH_SECRET de production impossible à résoudre sans risquer une régénération à ' +
        `chaque démarrage (sessions perpétuellement invalidées). ${recoveryHint}`,
    )
  }
  const port = resolveNextPort()
  warnInheritedSecrets()

  const env: NodeJS.ProcessEnv = { ...process.env }
  env.DATABASE_URL = db.url
  env.AUTH_SECRET = config.mode === 'prod' ? resolveOrCreateAuthSecret() : resolveDevAuthSecret()
  env.AUTH_URL = `http://localhost:${port}`
  env.HOSTNAME = LOOPBACK_HOST
  env.PORT = String(port)
  if (config.mode === 'prod') {
    env.NODE_ENV = 'production'
  }
  env.UPLOAD_DIR = resolveUploadDir(config)

  // Confiance d'appareil (étape 3.2) : `DEVICE_ID` est toujours renseigné (il
  // identifie le poste, y compris en dev), mais il n'est **opposable** qu'en
  // présence de `SYNC_BASE_URL` (mode prod desktop, cf. décision D-A — sans
  // serveur central, la confiance n'est pas contrôlée pour ne pas interdire
  // tout login). `TRUST_DAYS` est validé ici : une valeur invalide bloque le
  // démarrage au lieu d'être remplacée silencieusement.
  env.DEVICE_ID = resolveDeviceId()
  const syncBaseUrl = resolveSyncBaseUrl(config.mode)
  if (syncBaseUrl !== undefined) {
    env.SYNC_BASE_URL = syncBaseUrl
  } else {
    // Efface une éventuelle valeur héritée de `process.env` : le mode sans
    // central doit être **absent**, pas seulement ignoré (l'enfant Next lit
    // cette variable pour activer le contrôle).
    delete env.SYNC_BASE_URL
  }
  env.TRUST_DAYS = String(resolveTrustDays(config.mode))

  // Jeton d'appareil (tâche 6.1c) : injecté pour la réservation de BLOCS de
  // numéros (`POST /api/sync/blocks` depuis l'enfant Next). Le jeton vit dans
  // `config.json` chiffré DPAPI — inaccessibles au serveur Next, d'où cette
  // injection en env. Discipline :
  //  - **jamais de jeton périmé transmis** : `readSyncToken()` renvoie aussi un
  //    jeton expiré (documenté) ; seul un couple (jeton, expiration) encore
  //    valide est posé dans l'env, sinon la clé est **absente** (et une valeur
  //    héritée de `process.env` est effacée, comme `SYNC_BASE_URL`) ;
  //  - **jamais journalisé** (voir la liste des clés non loguées ci-dessous) ;
  //  - ⚠️ le jeton change au plus tous les 30 jours ou à la reconnexion ; un
  //    changement nécessite le **redémarrage de l'enfant Next** — géré à
  //    l'étape 7 (ce processus ne lit le `config.json` qu'au démarrage).
  const syncToken = readSyncToken()
  const syncTokenValid = syncToken !== null && Date.now() < Date.parse(syncToken.expiresAt)
  if (syncTokenValid && syncToken !== null) {
    env.SYNC_TOKEN = syncToken.token
  } else {
    // Efface une éventuelle valeur héritée : pas de jeton absent/périmé transmis.
    delete env.SYNC_TOKEN
  }

  log.info(
    `[env] env du serveur Next : AUTH_URL=${env.AUTH_URL}, PORT=${env.PORT}, HOSTNAME=${env.HOSTNAME}, ` +
      `NODE_ENV=${env.NODE_ENV ?? '(inchangé)'}, UPLOAD_DIR=${env.UPLOAD_DIR}, ` +
      `DEVICE_ID=${env.DEVICE_ID}, TRUST_DAYS=${env.TRUST_DAYS}, ` +
      `SYNC_BASE_URL=${syncBaseUrl ?? '(absente : confiance non opposable)'}, ` +
      `SYNC_TOKEN=${syncTokenValid ? 'présent et valide' : '(absent ou expiré : réservation de blocs indisponible)'} ` +
      '(DATABASE_URL, AUTH_SECRET et SYNC_TOKEN jamais journalisés — seuls la présence et l’expiration du jeton le sont)',
  )
  return env
}
