/**
 * Cycle de vie du **PostgreSQL embarqué** (PLAN-ELECTRON §2.1 — tâche 2.1).
 *
 * Pourquoi `embedded-postgres` et **pas PGlite** ? La réponse est documentée en
 * tête de `scripts/dev-db.ts` (l.12-18), preuve de concept du projet : PGlite
 * (Postgres en WASM exposé sur le protocole natif) a été **abandonné** après
 * vérification en conditions réelles — son serveur socket sérialise les requêtes
 * au niveau du *message*, pas de la *connexion* ; deux transactions concurrentes
 * sur deux connexions s'interpénètrent et corrompent le protocole étendu (erreur
 * `portal "" does not exist`). Or ce projet utilise massivement `SELECT ... FOR
 * UPDATE` : on garde donc de **vrais binaires PostgreSQL** (`embedded-postgres`),
 * même dialecte, même driver, transactions verrouillées comprises.
 *
 * Comportements non négociables :
 *  - **réutilisation** : si un PostgreSQL répond déjà sur le port avec **notre**
 *    identité (base + utilisateur), il est réutilisé (`owned: false`) et `stop()`
 *    est un no-op — on ne tue **jamais** un processus qui n'est pas le nôtre ;
 *  - **échec fermé (fail-closed)** : un serveur qui répond mais avec une identité
 *    inattendue (base étrangère, identifiants refusés, protocole muet) fait
 *    **rejeter** `startLocalDb()` **avant** toute tentative de démarrage. Aucun
 *    fail-open : ouvrir un second serveur sur le catalogue d'un autre, c'est la
 *    corruption ;
 *  - **verrou `postmaster.pid`** : copie adaptée de `clearStalePidLock()`
 *    (`scripts/dev-db.ts` l.52-83) — le verrou n'est supprimé **que** si son
 *    détenteur est réellement mort, sinon on abandonne ;
 *  - **journalisation** : `electron-log` **uniquement** (aucun `console.log`), et
 *    toute URL/jeton passe par `redactSecrets()` (l'URL contient le mot de passe) ;
 *  - **arrêt** : `stop()` idempotent, jamais rejetant ; `forceStopLocalDb()`
 *    synchrone en filet de `process.on('exit')`.
 *
 * Ordre de démarrage à venir (**étape 2.2 — branchement dans `main.ts`**, non
 * réalisé ici) :
 *   1. `resolveDbConfig()` (`electron/env.ts`)  → config dev/prod ;
 *   2. `startLocalDb(config)` (**ce fichier**)  → PG prêt (réutilisé ou démarré) ;
 *   3. migrations Drizzle (`drizzle/*.sql`, idempotentes) → **après** santé PG,
 *      **avant** le premier rendu ;
 *   4. `startNextServer()` (`electron/server/next.ts`) → puis seulement `loadURL`.
 * Arrêt : `handle.stop()` sur `before-quit` (gracieux), puis `forceStopLocalDb()`
 * sur `process.on('exit')` (filet **synchrone**, seul type d'appel autorisé là).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import log from 'electron-log'
import EmbeddedPostgres from 'embedded-postgres'
import postgres from 'postgres'
// Export existant (`electron/server/next.ts`) : la même redaction sert les logs
// de Next et ceux de PG — un seul traitement des secrets, pas deux.
import { redactSecrets } from '../server/next'
import type { DbConfig } from '../env'

/* -------------------------------------------------------------------------- */
/* Types publics                                                              */
/* -------------------------------------------------------------------------- */

/** Handle public : URL prête + arrêt idempotent du cluster. */
export interface LocalDbHandle {
  /** URL de connexion (contient le mot de passe → redact avant tout log). */
  readonly url: string
  readonly port: number
  /** `false` = serveur préexistant réutilisé : `stop()` est sans effet. */
  readonly owned: boolean
  /** Arrêt idempotent (jamais rejeté : les erreurs sont journalisées). */
  stop(): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Constantes                                                                 */
/* -------------------------------------------------------------------------- */

/** `connect_timeout` postgres-js est en **secondes** (README postgres.js). */
const PROBE_CONNECT_TIMEOUT_S = 3
/** Délai max d'acceptation du socket après `start()` (initdb est déjà fait). */
const READY_TIMEOUT_MS = 20_000
const READY_RETRY_INTERVAL_MS = 250
/** Délai laissé à `sql.end()` lors d'une sonde (jamais bloant). */
const CLIENT_END_TIMEOUT_S = 1
/**
 * Attente (bornée) de la fin réelle du shutdown après `pg.stop()`.
 *
 * Observé sous Windows : le socket d'écoute se libère vite (parfois en renvoyant
 * `ECONNRESET` juste après la mort du serveur) mais le package peut tuer le
 * postmaster, laissant un `postmaster.pid` orphelin. `stop()` n'est donc confirmé
 * qu'une fois le port **réellement refusant** *et* le verrou retiré (détenteur
 * prouvé mort) : l'étape 2.2 doit pouvoir enchaîner sans course avec un serveur
 * encore en cours d'extinction.
 */
const STOP_SETTLE_TIMEOUT_MS = 5_000
const STOP_SETTLE_RETRY_INTERVAL_MS = 100

/* -------------------------------------------------------------------------- */
/* État interne                                                               */
/* -------------------------------------------------------------------------- */

/** Cluster que **nous** avons démarré (null = rien à notre actif). */
interface OwnedCluster {
  readonly pg: EmbeddedPostgres
  /** Configuration utilisée au démarrage (URL, port, répertoire). */
  readonly config: DbConfig
  /** `true` = arrêt gracieux confirmé (port libre + verrou retiré). */
  stopped: boolean
}

let ownedCluster: OwnedCluster | null = null

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Code SQLSTATE ou code système (`ECONNREFUSED`, …) d'une erreur inconnue. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const candidate = error as { code?: unknown; cause?: unknown }
  if (typeof candidate.code === 'string') {
    return candidate.code
  }
  const cause = candidate.cause
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code
    if (typeof causeCode === 'string') {
      return causeCode
    }
  }
  return undefined
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Description d'erreur **toujours** redactée (une URL peut s'y être glissée). */
function describeError(error: unknown): string {
  const code = errorCodeOf(error)
  const suffix = code === undefined ? '' : ` [${code}]`
  return redactSecrets(`${errorMessageOf(error)}${suffix}`)
}

/** Un refus de connexion prouve qu'**aucun** serveur n'écoute (port libre). */
function isConnectionRefused(error: unknown): boolean {
  if (errorCodeOf(error) === 'ECONNREFUSED') {
    return true
  }
  return /ECONNREFUSED/i.test(errorMessageOf(error))
}

function isConnectTimeout(error: unknown): boolean {
  const code = errorCodeOf(error)
  if (code === 'ETIMEDOUT' || code === 'CONNECT_TIMEOUT') {
    return true
  }
  return /timeout|timed out/i.test(errorMessageOf(error))
}

/* -------------------------------------------------------------------------- */
/* Verrou `postmaster.pid`                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Copie **adaptée** de `clearStalePidLock()` (`scripts/dev-db.ts` l.52-83).
 * L'import est impossible : `scripts/dev-db.ts` est un *script* (il lance un
 * serveur au top-level), pas un module réutilisable — l'importer exécuterait
 * `main()`. Adaptations : `log.warn` au lieu de `console.warn`, factoration de
 * la lecture du pid, et `EPERM` considéré comme **vivant** (processus existant
 * mais inaccessible : supprimer son verrou ouvrirait un second serveur dessus).
 *
 * PostgreSQL refuse de démarrer sur un répertoire contenant encore un
 * `postmaster.pid` : le fichier signale le détenteur du catalogue et **survit**
 * à un arrêt brutal (fermeture de terminal, `taskkill`, crash).
 */
function readPostmasterPid(dataDir: string): number | null {
  try {
    const rawPid = readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim()
    const pid = Number(rawPid)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** `process.kill(pid, 0)` sonde l'existence sans signal : ESRCH = mort, EPERM = vivant. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

function clearStalePidLock(dataDir: string): void {
  const pidFile = path.join(dataDir, 'postmaster.pid')
  if (!existsSync(pidFile)) {
    return
  }

  const pid = readPostmasterPid(dataDir)
  if (pid !== null && isProcessAlive(pid)) {
    // Fail-closed : jamais deux serveurs sur le même catalogue.
    throw new Error(
      `Le cluster de ${dataDir} est déjà détenu par le processus ${pid} (postmaster.pid). ` +
        'Arrêtez-le avant de relancer, ou changez de répertoire de données.',
    )
  }

  log.warn(`[pg] verrou orphelin détecté (postmaster.pid, pid ${pid ?? 'illisible'}, processus absent) : suppression`)
  rmSync(pidFile, { force: true })
}

/* -------------------------------------------------------------------------- */
/* Sondage du port                                                            */
/* -------------------------------------------------------------------------- */

/** Identité réelle du serveur interrogé (contrôle d'échec fermé). */
interface ServerIdentity {
  readonly database: string
  readonly user: string
}

function readTextColumn(row: unknown, column: string): string {
  if (typeof row !== 'object' || row === null) {
    return ''
  }
  const value = (row as Record<string, unknown>)[column]
  if (value === null || value === undefined) {
    return ''
  }
  return typeof value === 'string' ? value : String(value)
}

/** Connexion unique et immédiate : identité du serveur, ou rejet. */
async function readIdentity(config: DbConfig): Promise<ServerIdentity> {
  const sql = postgres(config.url, {
    connect_timeout: PROBE_CONNECT_TIMEOUT_S,
    max: 1,
    fetch_types: false,
    onnotice: () => undefined,
  })
  try {
    const rows = await sql`select current_database() as database, current_user as user`
    const row: unknown = rows[0]
    return { database: readTextColumn(row, 'database'), user: readTextColumn(row, 'user') }
  } finally {
    await sql.end({ timeout: CLIENT_END_TIMEOUT_S }).catch(() => undefined)
  }
}

/** `true` = **aucun** serveur n'accepte plus la connexion sur ce port. */
async function isPortFree(config: DbConfig): Promise<boolean> {
  try {
    await readIdentity(config)
    return false
  } catch (error) {
    return isConnectionRefused(error)
  }
}

/**
 * Retire un `postmaster.pid` orphelin — **uniquement** quand le détenteur est
 * prouvé mort (même règle que `clearStalePidLock()` / `scripts/dev-db.ts`).
 * Un arrêt brutal du package peut laisser ce verrou derrière lui : sans ce
 * réap, le démarrage suivant le rencontrerait (inutilement) et l'état de stop()
 * resterait ambigu. `true` = aucun verrou subsistant.
 */
function reapDeadPidLock(dataDir: string): boolean {
  const pidFile = path.join(dataDir, 'postmaster.pid')
  if (!existsSync(pidFile)) {
    return true
  }
  const pid = readPostmasterPid(dataDir)
  if (pid !== null && isProcessAlive(pid)) {
    // Détenteur toujours vivant : on n'y touche pas (ouvrirait un second serveur).
    return false
  }
  log.info(`[pg] verrou orphelin laissé par l'arrêt (pid ${pid ?? 'illisible'} absent) : suppression`)
  rmSync(pidFile, { force: true })
  return !existsSync(pidFile)
}

/** Attend (de façon bornée) que le shutdown soit réellement achevé. */
async function waitClusterFullyStopped(config: DbConfig): Promise<boolean> {
  const deadline = Date.now() + STOP_SETTLE_TIMEOUT_MS
  for (;;) {
    if (await isPortFree(config) && reapDeadPidLock(config.dataDir)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await delay(STOP_SETTLE_RETRY_INTERVAL_MS)
  }
}

type ReuseVerdict =
  /** Refus de connexion prouvé : le port est libre, on peut démarrer. */
  | 'free'
  /** Notre propre identité répond : réutilisation sûre (`owned: false`). */
  | 'match'

/**
 * Détecte si une base peut être réutilisée sur `config.port`.
 *
 * | Situation                                   | Résultat                          |
 * |---------------------------------------------|-----------------------------------|
 * | `ECONNREFUSED` (aucun serveur)              | `free`                            |
 * | identité attendue (base + utilisateur)      | `match`                           |
 * | base ou utilisateur inattendus              | **throw** « étranger »            |
 * | identifiants refusés (`28P01`/`28000`)      | **throw** « étranger »            |
 * | base inconnue (`3D000`)                     | **throw** « étranger »            |
 * | port muet (timeout) ou protocole illisible  | **throw** « service non identifié」|
 *
 * Seul un **refus de connexion** prouve un port libre : tout le reste échoue
 * fermé **avant** toute tentative de démarrage (jamais de fail-open).
 */
async function probeExistingServer(config: DbConfig): Promise<ReuseVerdict> {
  let identity: ServerIdentity
  try {
    identity = await readIdentity(config)
  } catch (error) {
    if (isConnectionRefused(error)) {
      log.info(`[pg] port ${config.port} libre (refus de connexion) : aucun serveur à réutiliser`)
      return 'free'
    }
    if (isConnectTimeout(error)) {
      throw new Error(
        `Le port ${config.port} accepte les connexions mais n'a pas parlé le protocole PostgreSQL sous ` +
          `${PROBE_CONNECT_TIMEOUT_S} s : service non identifié, démarrage refusé (échec fermé). ` +
          'Arrêtez ce service ou changez de port.',
      )
    }
    throw new Error(
      `Le port ${config.port} est occupé par un PostgreSQL étranger ou refuse nos identifiants ` +
        `(${describeError(error)}) : démarrage refusé (échec fermé, jamais de fail-open).`,
    )
  }

  if (identity.database !== config.database || identity.user !== config.user) {
    throw new Error(
      `Le port ${config.port} est occupé par un PostgreSQL étranger : base « ${identity.database} » / ` +
        `utilisateur « ${identity.user} » au lieu de « ${config.database} » / « ${config.user} » ` +
        '(identité non vérifiable → démarrage refusé, échec fermé).',
    )
  }
  return 'match'
}

/* -------------------------------------------------------------------------- */
/* Démarrage                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Attend que le socket accepte **et** que l'identité corresponde au cluster
 * que nous venons de lancer (échec fermé si un autre serveur répondait).
 */
async function waitUntilReady(config: DbConfig): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let lastError: unknown = null

  for (;;) {
    try {
      const identity = await readIdentity(config)
      if (identity.database !== config.database || identity.user !== config.user) {
        throw new Error(
          `identité inattendue après démarrage : base « ${identity.database} » / utilisateur ` +
            `« ${identity.user} » (attendu « ${config.database} » / « ${config.user} »)`,
        )
      }
      log.info(`[pg] serveur prêt sur 127.0.0.1:${config.port} (base ${config.database})`)
      return
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) {
        throw new Error(
          `Le cluster de ${config.dataDir} n'est pas prêt après ${READY_TIMEOUT_MS} ms : ${describeError(lastError)}`,
        )
      }
      await delay(READY_RETRY_INTERVAL_MS)
    }
  }
}

/** Journalisation du processus enfant → `electron-log`, redactée (jamais `console.*`). */
function buildPostgresLogHandlers(): { onLog: (message: string) => void; onError: (error: unknown) => void } {
  return {
    onLog: (message: string) => {
      log.info(`[pg] ${redactSecrets(String(message)).replace(/\s+$/, '')}`)
    },
    onError: (error: unknown) => {
      log.error(`[pg] ${redactSecrets(errorMessageOf(error))}`)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Handle                                                                     */
/* -------------------------------------------------------------------------- */

async function stopOwnedCluster(cluster: OwnedCluster): Promise<void> {
  if (cluster.stopped) {
    return
  }
  const config = cluster.config
  log.info(`[pg] arrêt du cluster sur le port ${config.port} …`)
  try {
    await cluster.pg.stop()
    cluster.stopped = true
    log.info('[pg] cluster arrêté')
  } catch (error) {
    // Ne pas marquer `stopped` : le filet `forceStopLocalDb()` reste armé.
    log.error(`[pg] échec de l'arrêt du cluster : ${describeError(error)}`)
  } finally {
    if (cluster.stopped && ownedCluster === cluster) {
      ownedCluster = null
    }
  }
  if (!cluster.stopped) {
    return
  }
  // L'arrêt gracieux a réussi : on attend (borné) que shutdown soit achevé —
  // port libéré **et** verrou retiré — sans quoi l'appelant croirait pouvoir
  // enchaîner sur un serveur encore en cours d'extinction.
  //
  // **Contrat : `stop()` ne rejette jamais** (un rejet ferait échouer le
  // `before-quit` de `main.ts`). La phase de settle peut pourtant lever :
  // `reapDeadPidLock()` appelle `rmSync(postmaster.pid, { force: true })`, qui
  // échoue en `EPERM`/`EBUSY` dès qu'un antivirus Windows verrouille le
  // fichier. Simple avertissement : la sortie de l'application n'est jamais
  // bloquée par un verrou de fichier (le verrou sera démêlé au démarrage
  // suivant, le détenteur étant prouvé mort).
  try {
    if (await waitClusterFullyStopped(config)) {
      log.info(`[pg] port ${config.port} libéré, verrou retiré : arrêt confirmé`)
    } else {
      log.warn(
        `[pg] cluster arrêté mais shutdown non confirmé après ${STOP_SETTLE_TIMEOUT_MS} ms ` +
          `(port ${config.port} et/ou postmaster.pid)`,
      )
    }
  } catch (error) {
    log.warn(`[pg] confirmation d'arrêt interrompue (verrou de fichier refusé ?) : ${describeError(error)}`)
  }
}

function createHandle(cluster: OwnedCluster, config: DbConfig): LocalDbHandle {
  let stopPromise: Promise<void> | null = null
  return {
    url: config.url,
    port: config.port,
    owned: true,
    stop: (): Promise<void> => {
      // Idempotent : un second appel (ou un appel concurrent) retourne la même promesse.
      stopPromise ??= stopOwnedCluster(cluster)
      return stopPromise
    },
  }
}

/** Handle de réutilisation : `stop()` est un no-op (on ne tue pas l'étranger). */
function createReusedHandle(config: DbConfig): LocalDbHandle {
  return {
    url: config.url,
    port: config.port,
    owned: false,
    stop: (): Promise<void> => {
      log.info('[pg] base préexistante réutilisée : aucun processus à arrêter')
      return Promise.resolve()
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Démarre (ou réutilise) la base PostgreSQL locale.
 *
 * Étapes : sondage du port → réutilisation **ou** `clearStalePidLock` →
 * `initialise()` (si `PG_VERSION` absent) → `start()` → health-check `SELECT`
 * avec contrôle d'identité. En cas d'échec, le cluster que nous venons de
 * lancer est arrêté avant de rejeter (aucun orphelin).
 */
export async function startLocalDb(config: DbConfig): Promise<LocalDbHandle> {
  if (ownedCluster !== null && !ownedCluster.stopped) {
    throw new Error(
      `Une base locale est déjà démarrée sur le port ${ownedCluster.config.port} : appelez stop() avant de relancer startLocalDb().`,
    )
  }

  const verdict = await probeExistingServer(config)
  if (verdict === 'match') {
    log.info(
      `[pg] serveur PostgreSQL déjà actif sur le port ${config.port} (identité vérifiée) : réutilisation, ` +
        'aucun processus lancé',
    )
    return createReusedHandle(config)
  }

  log.info(`[pg] démarrage d'un cluster dans ${config.dataDir} (port ${config.port})`)
  mkdirSync(config.dataDir, { recursive: true })
  clearStalePidLock(config.dataDir)

  const needsInitialisation = !existsSync(path.join(config.dataDir, 'PG_VERSION'))
  const handlers = buildPostgresLogHandlers()
  const pg = new EmbeddedPostgres({
    databaseDir: config.dataDir,
    port: config.port,
    user: config.user,
    password: config.password,
    // scram-sha-256 : norme par défaut de PostgreSQL ≥ 14 (voir scripts/dev-db.ts).
    authMethod: 'scram-sha-256',
    persistent: true,
    // initdb hérite de la locale système (ici French_France.1252) et en déduit
    // WIN1252 comme encodage par défaut. Win1252 couvre le latin-1 mais PAS
    // l'au-delà : postgres-js émet de l'UTF-8, donc tout caractère hors latin-1
    // (arabe, emoji, certains noms) serait réinterprété et corrompu
    // silencieusement. Application médicale en Algérie → UTF8 obligatoire.
    initdbFlags: ['--encoding=UTF8', '--no-locale'],
    postgresFlags: [
      // Écoute sur l'interface de bouclage uniquement.
      '-c',
      'listen_addresses=127.0.0.1',
    ],
    onLog: handlers.onLog,
    onError: handlers.onError,
  })

  try {
    if (needsInitialisation) {
      log.info('[pg] premier démarrage : initialisation du catalogue (initdb) …')
      await pg.initialise()
    }
    await pg.start()
    await waitUntilReady(config)
  } catch (error) {
    // Jamais de cluster orphelin derrière un démarrage avorté.
    await pg.stop().catch((stopError: unknown) => {
      log.error(`[pg] nettoyage du démarrage avorté impossible : ${describeError(stopError)}`)
    })
    throw error instanceof Error ? error : new Error(`Démarrage du cluster impossible : ${describeError(error)}`)
  }

  const cluster: OwnedCluster = { pg, config, stopped: false }
  ownedCluster = cluster
  log.info(`[pg] cluster prêt sur 127.0.0.1:${config.port} (pid du postmaster : ${readPostmasterPid(config.dataDir) ?? 'n/a'})`)
  return createHandle(cluster, config)
}

/**
 * Windows — identifie l'image d'un pid **avant** tout `taskkill` (étape 2.2b,
 * revue B2).
 *
 * `postmaster.pid` peut avoir survécu à la mort de notre postmaster : Windows
 * recycle alors les pid, et le pid lu désignerait un processus **étranger**
 * que `taskkill /T /F` détruirait. Les deux filtres `tasklist` (PID **et**
 * IMAGENAME) ne renvoient une ligne que si le pid correspond bien à
 * `postgres.exe` ; `/FO CSV /NH` évite tout en-tête et tout nom de colonne
 * localisé (le nom d'image n'est jamais traduit). `false` = on ne tue **rien**
 * (image non vérifiée → échec fermé, jamais de kill à l'aveugle).
 */
function isPostgresImage(pid: number): boolean {
  try {
    const output = execFileSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FI', 'IMAGENAME eq postgres.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    // `"postgres.exe","<pid>",…` (guillemets de CSV acceptés en option).
    return new RegExp(`^"postgres\\.exe"\\s*,\\s*"?${pid}"?`, 'im').test(output)
  } catch {
    // `tasklist` indisponible/inaccessible : la vérification a échoué → on ne
    // tue pas (un processus étranger tué est irréversible, un PG orphelin se
    // rattrape au démarrage suivant).
    return false
  }
}

/**
 * Filet **synchrone** : à n'utiliser que depuis `process.on('exit')`, où aucune
 * API asynchrone n'est autorisée. L'arrêt gracieux normal reste
 * `handle.stop()` (sur `before-quit`). Ne tue que le cluster que nous avons
 * lancé (`owned`) — un serveur réutilisé n'est jamais touché.
 *
 * Méthode : `postmaster.pid` → pid du postmaster → **vérification de l'image**
 * (Windows : `taskkill` n'est lancé que si le pid est toujours celui de
 * `postgres.exe`, sinon PID recyclé → rien n'est tué) → `taskkill` de l'arbre
 * (Windows) / `SIGKILL` (POSIX). Un arrêt brutal laisse un verrou : c'est
 * assumé, il sera démêlé au démarrage suivant par `clearStalePidLock()` (le
 * détenteur est mort).
 */
export function forceStopLocalDb(): void {
  const cluster = ownedCluster
  if (cluster === null || cluster.stopped) {
    return
  }
  const pid = readPostmasterPid(cluster.config.dataDir)
  if (pid === null) {
    log.warn(`[pg] kill de secours : aucun postmaster.pid exploitable dans ${cluster.config.dataDir} — rien à tuer`)
    cluster.stopped = true
    ownedCluster = null
    return
  }
  if (process.platform === 'win32' && !isPostgresImage(pid)) {
    // PID recyclé : le pid lu n'est plus un `postgres.exe` (mort ou étranger).
    // Tuer tel quel détruirait un processus qui n'a rien à voir — on n'y touche pas.
    log.warn(
      `[pg] kill de secours annulé : le pid ${pid} n'est plus identifié comme postgres.exe (postmaster mort ou ` +
        'pid recyclé) — processus étranger laissé intact.',
    )
    cluster.stopped = true
    ownedCluster = null
    return
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
    log.warn(`[pg] kill de secours du postmaster (pid ${pid}, port ${cluster.config.port})`)
  } catch (error) {
    log.error(`[pg] kill de secours impossible : ${describeError(error)}`)
  }
  cluster.stopped = true
  ownedCluster = null
}
