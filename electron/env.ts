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
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Localise le `.env` : source (`electron/env.ts` → racine) **et** bundle
 * (`dist-electron/main/main.js` → racine), plus le répertoire courant pour les
 * lancements depuis la racine du projet (`npm run dev:desktop`).
 */
function findDotEnvFile(): string | null {
  const candidates = [
    path.resolve(__dirname, '.env'),
    path.resolve(__dirname, '..', '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '.env'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/**
 * Lit le `.env` **sans muter `process.env`** (comme `dotenv`, une variable déjà
 * définie dans l'environnement reste prioritaire — c'est le seul arbitrage fait
 * dans `resolveDbConfig()`).
 */
export function readDotEnvFile(): Record<string, string> {
  const file = findDotEnvFile()
  if (file === null) {
    log.warn('[env] fichier .env introuvable : configuration dev par défaut utilisée')
    return {}
  }
  try {
    const parsed = parseEnvFile(readFileSync(file, 'utf8'))
    log.debug(`[env] .env lu : ${file} (${Object.keys(parsed).length} clés, valeurs jamais journalisées)`)
    return parsed
  } catch (error) {
    log.warn(`[env] .env illisible (${file}) : ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
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
 * `DEV_DB_DATA_DIR` explicite, puis source (`electron/` → racine), puis bundle
 * (`dist-electron/main/` → racine), puis `cwd`. Le premier existant l'emporte ;
 * à défaut, `cwd/pgdata` (défaut exact de `dev-db.ts` : `pgdata` relatif).
 */
function resolveDevDataDir(): string {
  const override = process.env.DEV_DB_DATA_DIR
  if (override !== undefined && override !== '') {
    return path.resolve(override)
  }
  const candidates = [
    path.resolve(__dirname, '..', '..', 'pgdata'),
    path.resolve(__dirname, '..', '..', '..', 'pgdata'),
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

function resolveDevDbConfig(): DbConfigParts {
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
  return { ...parseDbUrl(rawUrl, 'DATABASE_URL'), dataDir: resolveDevDataDir() }
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

const persistedDbConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().min(1).max(63).optional(),
  password: z.string().min(1).optional(),
  encoding: storedEncodingSchema.optional(),
  authSecret: z.string().min(1).max(512).optional(),
  authSecretEncoding: storedEncodingSchema.optional(),
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
    writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    log.info(`[env] configuration de la base persistée : ${configPath}`)
  } catch (error) {
    throw new Error(`Impossible d'écrire ${configPath} (configuration de la base non persistée).`, { cause: error })
  }
}

/** Lecture du `config.json` : valeurs validées, ou `{}` + `fileCorrupt`. */
interface PersistedConfigRead {
  readonly persisted: PersistedDbConfig
  /** `true` = fichier absent de valeurs exploitables (illisible ou invalide). */
  readonly fileCorrupt: boolean
}

function readPersistedConfig(configPath: string): PersistedConfigRead {
  if (!existsSync(configPath)) {
    return { persisted: {}, fileCorrupt: false }
  }
  try {
    const parsed = persistedDbConfigSchema.safeParse(JSON.parse(readFileSync(configPath, 'utf8')))
    if (parsed.success) {
      return { persisted: parsed.data, fileCorrupt: false }
    }
    log.warn(
      `[env] config.json invalide (${parsed.error.issues
        .map((issue) => issue.path.join('.') || '(racine)')
        .join(', ')}) : valeurs par défaut régénérées. Si un cluster existe déjà sur ce port, la ` +
        'connexion échouera (échec fermé) tant que le mot de passe exact n’est pas restauré.',
    )
    return { persisted: {}, fileCorrupt: true }
  } catch (error) {
    log.warn(
      `[env] config.json illisible (${error instanceof Error ? error.message : String(error)}) : valeurs ` +
        'par défaut régénérées. Si un cluster existe déjà sur ce port, la connexion échouera (échec fermé) ' +
        'tant que le mot de passe exact n’est pas restauré.',
    )
    return { persisted: {}, fileCorrupt: true }
  }
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

function resolveProdDbConfig(): DbConfigParts {
  const userDataDir = resolveUserDataDir()
  const configPath = path.join(userDataDir, 'config.json')

  const { persisted, fileCorrupt } = readPersistedConfig(configPath)

  const port = persisted.port ?? PROD_DEFAULT_PORT
  const database = persisted.database ?? DEFAULT_DATABASE
  const storedPassword = fileCorrupt ? null : decodeStoredPassword(persisted)
  const password = storedPassword ?? generatePassword()
  const isIncomplete =
    persisted.port === undefined ||
    persisted.database === undefined ||
    persisted.encoding === undefined ||
    storedPassword === null

  if (isIncomplete) {
    if (storedPassword === null) {
      log.info('[env] premier démarrage : mot de passe de la base locale généré')
    }
    writePersistedConfig(configPath, { ...carryAuthSecret(persisted), port, database, ...encodePasswordForStorage(password) })
  } else if (persisted.encoding === 'plain' && safeStorage.isEncryptionAvailable()) {
    // Rétablissement opportuniste du chiffrement (fallback « clair » réversible).
    log.info('[env] safeStorage de retour : réchiffrement du mot de passe dans config.json')
    writePersistedConfig(configPath, { ...carryAuthSecret(persisted), port, database, ...encodePasswordForStorage(password) })
  }

  return {
    host: LOOPBACK_HOST,
    port,
    user: DEFAULT_USER,
    password,
    database,
    dataDir: path.join(userDataDir, 'pgdata'),
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
  const base = mode === 'dev' ? resolveDevDbConfig() : resolveProdDbConfig()
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
  }
  log.info(
    `[env] base locale ${mode} : 127.0.0.1:${config.port}/${config.database} ` +
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
    throw new Error(
      `config.json illisible : ${AUTH_SECRET_LABEL} de production impossible à résoudre sans risquer une ` +
        'régénération à chaque démarrage (sessions perpétuellement invalidées). Restaurez ce fichier, ' +
        'ou supprimez-le pour régénérer la configuration complète.',
    )
  }
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

/**
 * Construit l'environnement du **processus enfant Next.js** (étape 2.2a).
 *
 * Ordre de résolution dans `main.ts` : `resolveDbConfig()` → `startLocalDb()`
 * → **cette fonction** → `startNextServer({ env })`.
 *
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
 * - **reste de `process.env` conservé** (héritage du parent) — les secrets qui
 *   y traînent sont signalés (noms seuls) par `warnInheritedSecrets()`.
 *
 * Ni `DATABASE_URL` ni `AUTH_SECRET` ne sont jamais journalisés.
 */
export function buildNextEnv(db: LocalDbHandle, config: DbConfig): NodeJS.ProcessEnv {
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

  log.info(
    `[env] env du serveur Next : AUTH_URL=${env.AUTH_URL}, PORT=${env.PORT}, HOSTNAME=${env.HOSTNAME}, ` +
      `NODE_ENV=${env.NODE_ENV ?? '(inchangé)'}, UPLOAD_DIR=${env.UPLOAD_DIR} ` +
      '(DATABASE_URL et AUTH_SECRET jamais journalisés)',
  )
  return env
}
