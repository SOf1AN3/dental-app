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
 *  - **fuseau `UTC` (Q-8)** : `postgresFlags` impose `-c timezone=UTC` et
 *    `ensureUtcTimezone()` vérifie (et corrige via `ALTER DATABASE`) avant la
 *    première écriture — `defaultNow()` et les écritures Drizzle partagent
 *    alors la même convention, condition de monotonie d'`updated_at` ;
 *  - **arrêt** : `stop()` idempotent, jamais rejetant ; arrêt **gracieux** via
 *    `pg_ctl stop -m fast` (checkpoint de fermeture → `postmaster.pid` retiré
 *    par PostgreSQL, plus de « automatic recovery » au démarrage suivant), le
 *    `taskkill /F` du package ne servant que de repli ; `forceStopLocalDb()`
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

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import log from 'electron-log'
import EmbeddedPostgresImport from 'embedded-postgres'
import postgres from 'postgres'
// Export existant (`electron/server/next.ts`) : la même redaction sert les logs
// de Next et ceux de PG — un seul traitement des secrets, pas deux.
import { redactSecrets } from '../server/next'
import type { DbConfig } from '../env'

/* -------------------------------------------------------------------------- */
/* Déballage `embedded-postgres` (ESM pur → frontière CJS)                    */
/* -------------------------------------------------------------------------- */

/**
 * `embedded-postgres` est **100 % ESM** (`"type": "module"`, `export default`).
 * Le main Electron est emballé en **CJS** (`electron.vite.config.ts`, externals
 * voulus) : `require()` d'un paquet ESM sous Node 22 (Electron 44) renvoie
 * l'**objet namespace** `{ default: EmbeddedPostgres }`, jamais la fonction
 * directement. Sans déballage, `new` s'applique au namespace →
 * `TypeError: EmbeddedPostgres is not a constructor`, et **uniquement** au
 * premier démarrage (port libre + cluster absent) — c'est-à-dire le chemin de
 * production exact. On déballe ici les **deux formes** possibles :
 * fonction directe (ESM natif, tests `tsx`) **ou** `.default` (namespace CJS).
 */
type EmbeddedPostgresCtor = typeof EmbeddedPostgresImport

const EmbeddedPostgresCandidate: EmbeddedPostgresCtor | undefined =
  typeof EmbeddedPostgresImport === 'function'
    ? EmbeddedPostgresImport
    : (EmbeddedPostgresImport as unknown as { default?: EmbeddedPostgresCtor } | undefined)?.default

// Les deux formes absentes : throw lisible, jamais « undefined is not a
// constructor » au milieu d'un stack trace au premier démarrage.
if (typeof EmbeddedPostgresCandidate !== 'function') {
  throw new Error(
    'embedded-postgres : export inattendu — ni constructeur direct, ni export `.default` ' +
      `(typeof(module)=${typeof EmbeddedPostgresImport}, ` +
      `typeof(module.default)=${typeof (EmbeddedPostgresImport as { default?: unknown } | undefined)?.default}). ` +
      'Paquet ESM inutilisable depuis le bundle CJS du main : la base locale ne peut pas démarrer.',
  )
}

/** Constructeur effectif, quelle que soit la forme renvoyée par `require()`. */
const EmbeddedPostgres: EmbeddedPostgresCtor = EmbeddedPostgresCandidate

/** Type d'instance : `typeof` d'une classe = type **constructeur** → `InstanceType`. */
type EmbeddedPostgresInstance = InstanceType<EmbeddedPostgresCtor>

/* -------------------------------------------------------------------------- */
/* Hook de sortie `async-exit-hook` (désarmement ciblé)                        */
/* -------------------------------------------------------------------------- */

/**
 * API **partielle** d'`async-exit-hook@2` (CJS, partagé avec `embedded-postgres`).
 * Seule la paire `hookedEvents()` / `unhookEvent()` est utilisée ici.
 */
interface AsyncExitHookApi {
  readonly hookedEvents?: () => string[]
  readonly unhookEvent?: (event: string) => void
}

/** Fichier du bundle courant (CJS) — base de résolution de `createRequire`. */
function bundleFilename(): string {
  // `typeof` sur un global absent (contexte ESM/tsx) ne lève jamais : c'est le
  // garde-fou qui évite un `ReferenceError` au chargement.
  return typeof __filename === 'string' && __filename.length > 0 ? __filename : path.join(process.cwd(), 'index.js')
}

/**
 * Retire le hook **`exit`** qu'`embedded-postgres` enregistre via
 * `async-exit-hook` (`dist/index.js:395` → `AsyncExitHook(gracefulShutdown)`).
 *
 * Cause racine de la réjection observée à l'arrêt :
 *  - `gracefulShutdown(done)` (`embedded-postgres/dist/index.js:386-394`) est une
 *    fonction **asynchrone** qui termine par `done()` **ligne 393** ;
 *  - `async-exit-hook` n'applique le contrat « async » **que** si l'événement est
 *    porteur d'un code de sortie (`runHook` : `if (exit && hook.length > syncArgCount)
 *    → hook(stepTowardExit)`, sinon `hook()` **sans aucun argument**) ;
 *  - l'événement brut `exit` est justement le seul enregistré **sans code**
 *    (`add.hookEvent('exit')` → `exit(false, undefined)`) : le callback `done`
 *    est donc `undefined`, `done()` lève `TypeError: done is not a function`,
 *    et la promesse ainsi rejetée n'est **jamais observée** par le package →
 *    `UnhandledPromiseRejection` à chaque sortie (`app.exit(0)` de `main.ts`).
 *
 * Désarmer **ce hook précis** est sans effet de bord :
 *  - aucun travail asynchrone n'est de toute façon possible pendant l'événement
 *    `exit` (boucle d'événements déjà arrêtée) ;
 *  - les autres événements d'`async-exit-hook` (`beforeExit`, signaux) restent
 *    branchés : ils fournissent bien `done` et ne posent pas ce problème ;
 *  - notre filet synchrone `process.once('exit') → forceStopLocalDb()`
 *    (`main.ts`) couvre toujours une sortie imprévue.
 *
 * L'instance retournée par `createRequire(__filename)('async-exit-hook')` est
 * **celle du cache CJS**, donc exactement celle qu'`embedded-postgres` importe
 * (`import AsyncExitHook from 'async-exit-hook'` → `module.exports`). Le retrait
 * est ensuite **vérifié** sur `process.listenerCount('exit')` : si le compteur
 * n'a pas bougé, on journalise une erreur (le package ne peut pas être désarmé
 * depuis ici) plutôt que de faire croire à un succès silencieux.
 */
function disarmAsyncExitHook(): void {
  try {
    const requireFromBundle = createRequire(bundleFilename())
    const exitHook = requireFromBundle('async-exit-hook') as unknown as AsyncExitHookApi
    if (typeof exitHook.hookedEvents !== 'function' || typeof exitHook.unhookEvent !== 'function') {
      log.error("[pg] async-exit-hook : API hookedEvents/unhookEvent introuvable — hook 'exit' laissé en place")
      return
    }
    if (!exitHook.hookedEvents().includes('exit')) {
      // DURCISSEMENT (étape 10.3) : `hookedEvents()` peut renvoyer `[]` si
      // `createRequire` a résolu une copie DIFFÉRENTE de celle qu'`embedded-postgres`
      // a importée (layout de node_modules non hoisté, pnpm). Auquel cas le hook
      // fautif reste armé malgré ce message : on passe en `warn` avec
      // l'hypothèse « instance différente » explicite plutôt qu'un `info` trompeur.
      log.warn(
        "[pg] hook 'exit' d'async-exit-hook déjà absent sur l'instance résolue — si createRequire " +
          'a chargé une copie différente de celle d’embedded-postgres (layout non hoisté, pnpm), ' +
          'le hook fautif reste armé (hypothèse « instance différente »)',
      )
      return
    }
    const listenersBefore = process.listenerCount('exit')
    exitHook.unhookEvent('exit')
    const listenersAfter = process.listenerCount('exit')
    if (listenersAfter >= listenersBefore) {
      log.error(
        "[pg] retrait du hook 'exit' d'async-exit-hook sans effet (instance partagée introuvable) : " +
          'la réjection interne « done is not a function » subsistera à l’arrêt',
      )
      return
    }
    log.info(
      "[pg] hook 'exit' d'async-exit-hook désarmé : embedded-postgres l'invoquait sans callback " +
        '(TypeError « done is not a function »)',
    )
  } catch (error) {
    log.error(`[pg] désarmement du hook 'exit' d'async-exit-hook impossible : ${describeError(error)}`)
  }
}

// Effectué **dès le chargement** : l'import statique `embedded-postgres` ci-dessus
// a déjà enregistré le hook fautif — il faut le retirer avant toute sortie.
disarmAsyncExitHook()

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
/**
 * Attente maximale de `pg_ctl stop -w` (**arrêt gracieux**, en secondes).
 *
 * C'est **ce chemin qui garantit un arrêt propre** : le package, sous Windows,
 * se contente d'un `taskkill /f /t` (`embedded-postgres/dist/index.js:254`) —
 * le postmaster est tué avant son checkpoint de fin, son `postmaster.pid`
 * survit et le démarrage suivant annonce « database system was not properly
 * shut down; automatic recovery in progress ». `pg_ctl stop -m fast` fait
 * jouer à PostgreSQL son propre arrêt (sessions terminées, checkpoint de
 * fermeture, retrait du verrou) — le `postmaster.pid` disparaît **par lui-même**.
 */
const PG_CTL_STOP_TIMEOUT_S = 3
/** Filet matériel autour de `pg_ctl` (ms) : au-delà, on replie sur le package. */
const PG_CTL_EXEC_TIMEOUT_MS = 4_000
/**
 * Attente bornée de `pg.stop()` (le package) : son `spawn('taskkill', …)` est
 * lancé **synchrone­ment** dès le premier tour, l'attente ne sert qu'à laisser
 * le temps au processus enfant de se terminer. Ce garde-fou protège contre la
 * seule configuration où cette promesse peut ne **jamais** se résoudre : l'enfant
 * a déjà émis `exit` (le listener ajouté par `stop()` ne se déclencherait plus).
 */
const PACKAGE_STOP_MAX_WAIT_MS = 1_000

/* -------------------------------------------------------------------------- */
/* État interne                                                               */
/* -------------------------------------------------------------------------- */

/** Cluster que **nous** avons démarré (null = rien à notre actif). */
interface OwnedCluster {
  readonly pg: EmbeddedPostgresInstance
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
/* Arrêt (gracieux d'abord, repli sur le package)                             */
/* -------------------------------------------------------------------------- */

/** Cache de résolution **réussie** de `pg_ctl` : `undefined` = pas encore résolu. */
let pgCtlPathCache: string | undefined

/**
 * Chemin absolu de `pg_ctl.exe`, résolu **exactement comme le fait le package**
 * (son `dist/binary.js` importe `@embedded-postgres/<plateforme>`) mais sans
 * import statique : la résolution est lazy et reste isolée à l'arrêt.
 * `null` = indisponible → comportement historique du package (`taskkill /F`).
 *
 * **DURCISSEMENT (étape 10.3)** : seuls les **succès** sont mis en cache. Un
 * échec transitoire (antivirus en lecture de `pg_ctl.exe`, accès momentanément
 * refusé) ne doit pas désactiver l'arrêt gracieux **définitivement** pour la vie
 * du processus — on re-tentera à chaque arrêt (le coût d'un `resolve`+
 * `existsSync` est négligeable, un seul par arrêt).
 */
function resolvePgCtlPath(): string | null {
  if (pgCtlPathCache !== undefined) {
    // Succès déjà résolu et mis en cache.
    return pgCtlPathCache
  }
  if (process.platform !== 'win32') {
    // Seul Windows est couvert ici : `electron.vite.config.ts` externalise
    // `@embedded-postgres/windows-x64` (les binaires des autres plateformes ne
    // sont même pas installés). Ailleurs : repli sur le package, comme avant.
    // Non caché (seuls les succès le sont) — le coût est nul, un seul par arrêt.
    return null
  }
  try {
    const requireFromBundle = createRequire(bundleFilename())
    // `exports` de la plateforme n'expose que `"."` → `…/windows-x64/dist/index.js`,
    // d'où `pg_ctl.exe` vit à `../native/bin/pg_ctl.exe`.
    const entry = requireFromBundle.resolve('@embedded-postgres/windows-x64')
    const candidate = path.join(path.dirname(entry), '..', 'native', 'bin', 'pg_ctl.exe')
    if (existsSync(candidate)) {
      pgCtlPathCache = candidate
      return candidate
    }
    log.warn(
      `[pg] pg_ctl introuvable (${redactSecrets(candidate)}) : arrêt gracieux indisponible ` +
        '(re-tenté au prochain arrêt : échec non mis en cache)',
    )
  } catch (error) {
    log.error(
      `[pg] résolution de pg_ctl impossible : ${describeError(error)} ` +
        '(re-tentée au prochain arrêt : échec non mis en cache)',
    )
  }
  return null
}

/**
 * `pg_ctl stop -D <datadir> -m fast -w -t <n>` — **arrêt gracieux**, seul
 * moyen d'obtenir un `postmaster.pid` retiré par PostgreSQL lui-même.
 * Ne **rejette jamais** : `false` = échec/indisponibilité → repli sur le package.
 */
async function stopClusterWithPgCtl(config: DbConfig): Promise<boolean> {
  const pgCtl = resolvePgCtlPath()
  if (pgCtl === null) {
    return false
  }
  const outcome = await new Promise<{ failed: boolean; details: string }>((resolve) => {
    execFile(
      pgCtl,
      ['stop', '-D', config.dataDir, '-m', 'fast', '-w', '-t', String(PG_CTL_STOP_TIMEOUT_S)],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: PG_CTL_EXEC_TIMEOUT_MS,
        // Même locale que les enfants du package : messages PostgreSQL en anglais.
        env: { ...process.env, LC_MESSAGES: 'C' },
      },
      (error, stdout, stderr) => {
        resolve({ failed: error !== null, details: `${stdout ?? ''}${stderr ?? ''}` })
      },
    )
  })
  const details = outcome.details.replace(/\s+$/, '')
  if (!outcome.failed) {
    if (details.length > 0) {
      log.info(`[pg] ${redactSecrets(details)}`)
    }
    log.info(`[pg] pg_ctl stop -m fast : arrêt gracieux effectué (port ${config.port})`)
    return true
  }
  log.warn(
    `[pg] pg_ctl stop a échoué (port ${config.port}) : ` +
      `${redactSecrets(details.length > 0 ? details : 'aucune sortie')} — repli sur l'arrêt du package`,
  )
  return false
}

/**
 * Efface la référence au processus enfant détenue par `embedded-postgres`
 * (champ privé `process`, **même affectation que son propre `stop()`** :
 * `this.process = undefined`). Indispensable après un arrêt `pg_ctl` réussi :
 * l'enfant est déjà terminé, et sans ce détachement un rappel ultérieur de
 * `pg.stop()` tenterait un `taskkill /pid <…>` sur un **pid éventuellement
 * recyclé** (processus innocent) et attendrait indéfiniment un événement
 * `exit` qui ne viendra plus.
 *
 * **DURCISSEMENT (étape 10.3) — test de succès + risque de version (paquet beta)** :
 * l'affectation d'un champ privé **n'est pas vérifiée** par défaut. Le paquet
 * est en `beta` (`18.4.0-beta.17`) : une nouvelle version peut **renommer** ce
 * champ, auquel cas `internals.process = undefined` créerait une propriété
 * fantôme et laisserait le vrai champ intact — `pg.stop()` retomberait alors
 * sur un `taskkill` de pid recyclé **silencieusement**. On retourne donc un
 * **test de succès** (le champ est relu `undefined` après l'affectation) :
 *  - `true`  → détachement confirmé, l'appelant peut (doit) laisser `pg.stop()`
 *    s'exécuter (devenu no-op sûr) ;
 *  - `false` → détachement **non confirmé** (champ renommé/lecture seule, ou
 *    déjà absent au moment du test) : l'appelant **ne doit pas** appeler
 *    `pg.stop()` mais confirmer l'arrêt par ses propres moyens (port /
 *    `postmaster.pid`), au risque sinon d'un kill de pid recyclé.
 *
 * @returns `true` si le détachement est confirmé (`process` relu `undefined`).
 */
function detachPackageProcessRef(pg: EmbeddedPostgresInstance): boolean {
  const internals = pg as unknown as { process?: unknown }
  if (internals.process === undefined) {
    // Déjà absent : soit déjà détaché, soit le champ a été renommé (nouvelle
    // version du paquet beta) et le vrai processus subsiste ailleurs. Impossible
    // à distinguer ici → on retourne `false` (échec fermé) pour que l'appelant
    // confirme l'arrêt par port/verrou plutôt que par `pg.stop()`.
    log.warn(
      "[pg] champ `process` du package déjà absent : détachement NON confirmé " +
        '(champ éventuellement renommé par une version plus récente du paquet beta)',
    )
    return false
  }
  internals.process = undefined
  if (internals.process !== undefined) {
    // Affectation sans effet : accesseur en lecture seule / champ renommé qui
    // masque encore la valeur. On n'affirme jamais un succès silencieux.
    log.warn(
      "[pg] affectation du champ `process` du package sans effet : détachement NON confirmé " +
        '(champ renommé ou lecture seule — paquet beta)',
    )
    return false
  }
  log.info('[pg] référence de processus du package effacée et confirmée (enfant déjà terminé)')
  return true
}

/** `pg.stop()` **jamais rejetant et jamais bloquant** (attente bornée ci-dessus). */
async function stopViaPackageBounded(pg: EmbeddedPostgresInstance): Promise<boolean> {
  let failed = false
  const stopping = pg.stop().catch((error: unknown) => {
    failed = true
    log.error(`[pg] arrêt du package impossible : ${describeError(error)}`)
  })
  await Promise.race([stopping, delay(PACKAGE_STOP_MAX_WAIT_MS)])
  return !failed
}

/**
 * Arrêt complet du cluster `pg` : **gracieux d'abord** (`pg_ctl stop -m fast`),
 * **repli sur le package** (`taskkill /F`, comportement historique, brutal)
 * uniquement si `pg_ctl` est indisponible ou échoue **et** que le postmaster
 * est toujours vivant. Ne rejette jamais ; `true` = cluster arrêté **et confirmé**.
 *
 * Durcissements (étape 10.3) :
 *  1. le repli `taskkill` vérifie **l'image** du pid (`isPostgresImage`) avant
 *     de tuer — un pid recyclé par Windows n'est jamais tué à l'aveugle ;
 *  2. l'arrêt n'est conclu (`true`) qu'après **confirmation réelle** (port
 *     refusant **et/ou** `postmaster.pid` retiré) — sinon `false` pour garder
 *     `forceStopLocalDb()` armé ;
 *  3. `pg.stop()` n'est appelé que si le **détachement du champ `process` est
 *     confirmé** (paquet beta) ; sinon on confirme par port/verrou.
 */
async function stopCluster(pg: EmbeddedPostgresInstance, config: DbConfig): Promise<boolean> {
  if (await stopClusterWithPgCtl(config)) {
    // Arrêt gracieux confirmé par pg_ctl (-w). Détachement VÉRIFIÉ (durc. 3).
    if (detachPackageProcessRef(pg)) {
      // Détachement confirmé : `process === undefined` → `pg.stop()` est un
      // no-op sûr (aucun taskkill possible), il fait juste relicuer le package.
      await stopViaPackageBounded(pg)
      return true
    }
    // Détachement NON confirmé : ne PAS appeler `pg.stop()` (il tenterait un
    // taskkill de pid éventuellement recyclé). On confirme l'arrêt par nos
    // propres moyens (port / postmaster.pid) — durcissement 3.
    log.warn("[pg] detach du processus du package non confirmé : pg.stop() évité, confirmation par port/verrou")
    return await waitClusterFullyStopped(config)
  }

  // Repli : pg_ctl indisponible ou échoué.
  const pid = readPostmasterPid(config.dataDir)
  if (pid === null || !isProcessAlive(pid)) {
    log.info('[pg] aucun postmaster actif : plus rien à arrêter')
    return true
  }

  // DURCISSEMENT 1 : ne jamais `taskkill` un pid non identifié `postgres.exe`.
  // Si le postmaster est mort et que Windows a recyclé le pid, tuer cet à l'aveugle
  // détruirait un processus étranger. Fail-closed : on n'y touche pas et on ne
  // conclut PAS à l'arrêt (`false`) — `ownedCluster` reste peuplé et
  // `forceStopLocalDb()` reste armé : il réévaluera (même garde `isPostgresImage`)
  // à la sortie et laissera l'étranger intact. Retourner `true` ici désarmerait
  // prématurément le filet (durcissement 2) au cas où `tasklist` aurait échoué
  // plutôt que le pid être réellement étranger.
  if (process.platform === 'win32' && !isPostgresImage(pid)) {
    log.warn(
      `[pg] repli taskkill annulé : le pid ${pid} n'est plus identifié comme postgres.exe ` +
        '(postmaster mort ou pid recyclé) — processus étranger laissé intact, filet forceStopLocalDb maintenu armé.',
    )
    return false
  }

  log.warn("[pg] repli sur l'arrêt du package (taskkill /F) : arrêt brutal, récupération automatique au prochain démarrage")
  const packageStopped = await stopViaPackageBounded(pg)
  if (!packageStopped) {
    // Échec/explicite de `pg.stop()` : on ne conclut rien, filet maintenu armé.
    return false
  }
  // DURCISSEMENT 2 : l'attente bornée ci-dessus (≤1 s) a pu renvoyer `true` alors
  // que `taskkill` n'avait pas terminé. On CONFIRME la mort réelle (port refusant
  // et/ou verrou retiré) avant de conclure ; sinon `false` → `ownedCluster` n'est
  // pas vidé et `forceStopLocalDb()` reste armé.
  return await waitClusterFullyStopped(config)
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
    if (await stopCluster(cluster.pg, config)) {
      cluster.stopped = true
      log.info('[pg] cluster arrêté')
    }
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
/* Fuseau UTC — convention d'horodatage unique (Q-8)                           */
/* -------------------------------------------------------------------------- */

/** Nom d'identifiant SQL sûr (base issue de la config, jamais d'un utilisateur). */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `current_setting('TimeZone')` sur une session **dédiée** (ouverte puis
 * fermée) : chaque session porte son propre fuseau, une session réutilisée
 * ne prouve rien pour les suivantes.
 */
async function readTimeZone(config: DbConfig): Promise<string> {
  const sql = postgres(config.url, {
    connect_timeout: PROBE_CONNECT_TIMEOUT_S,
    max: 1,
    fetch_types: false,
    onnotice: () => undefined,
  })
  try {
    const rows = await sql<{ tz: string }[]>`select current_setting('TimeZone') as tz`
    return readTextColumn(rows[0], 'tz')
  } finally {
    await sql.end({ timeout: CLIENT_END_TIMEOUT_S }).catch(() => undefined)
  }
}

/**
 * Garantit que **toute nouvelle session** démarre en `UTC` — prérequis de la
 * monotonie d'`updated_at` (Q-8).
 *
 * Deux filets, dans cet ordre :
 *  1. le drapeau `-c timezone=UTC` du `postgresFlags` ci-dessus (déjà appliqué
 *     au moment où cette fonction est appelée) ;
 *  2. si le fuseau lu reste non-UTC (paquet `embedded-postgres` **beta** qui
 *     n'aurait pas transmis le drapeau, cluster préexistant, drapeau filtré),
 *     `ALTER DATABASE … SET timezone = 'UTC'` — persistant dans le catalogue,
 *     puis **re-vérifié sur une nouvelle session** (`ALTER DATABASE` ne
 *     s'applique jamais à la session courante).
 *
 * Échec fermé : si le fuseau n'est toujours pas `UTC` après correction, on
 * REJETTE le démarrage (le cluster démarré est nettoyé par l'appelant) plutôt
 * que d'écrire des horodatages dans deux conventions — c'est exactement le
 * défaut silencieux que cette vérification doit empêcher.
 */
async function ensureUtcTimezone(config: DbConfig): Promise<void> {
  const before = await readTimeZone(config)
  if (before === 'UTC') {
    log.info(`[pg] TimeZone = ${before} (convention d'horodatage unique, drapeau -c timezone=UTC appliqué)`)
    return
  }

  log.warn(`[pg] TimeZone = ${before} (attendu UTC) : correction par ALTER DATABASE … SET timezone = 'UTC'`)
  if (!SAFE_IDENTIFIER.test(config.database)) {
    throw new Error(`Nom de base inattendu (${JSON.stringify(config.database)}) : correction du fuseau impossible.`)
  }
  const sql = postgres(config.url, {
    connect_timeout: PROBE_CONNECT_TIMEOUT_S,
    max: 1,
    fetch_types: false,
    onnotice: () => undefined,
  })
  try {
    await sql.unsafe(`ALTER DATABASE "${config.database}" SET timezone = 'UTC'`)
  } finally {
    await sql.end({ timeout: CLIENT_END_TIMEOUT_S }).catch(() => undefined)
  }

  // Nouvelle session : c'est elle qui porte le réglage persisté.
  const after = await readTimeZone(config)
  if (after !== 'UTC') {
    throw new Error(
      `Fuseau PostgreSQL non aligné : TimeZone = ${after} au lieu de UTC après correction. ` +
        'Démarrage refusé (les horodatages mélangeraient le local et l\'UTC).',
    )
  }
  log.info('[pg] TimeZone = UTC confirmé après correction (ALTER DATABASE persistant)')
}

/**
 * Chemin **réutilisation** : on ne modifie JAMAIS un serveur qui n'est pas le
 * nôtre (contrat du fichier) — on se contente de signaler un fuseau non-UTC,
 * qui dégraderait la monotonie d'`updated_at` sur cette base.
 */
async function warnIfNonUtcTimezone(config: DbConfig): Promise<void> {
  try {
    const tz = await readTimeZone(config)
    if (tz !== 'UTC') {
      log.warn(
        `[pg] TimeZone = ${tz} sur la base réutilisée (attendu UTC) : serveur non nôtre, aucun réglage appliqué. ` +
          'Exécuter « ALTER DATABASE … SET timezone = \'UTC\' » sur cette base (Q-8).',
      )
    } else {
      log.info('[pg] TimeZone = UTC sur la base réutilisée')
    }
  } catch (error) {
    // Sonde non bloquante : l'identité du serveur est déjà vérifiée.
    log.warn(`[pg] lecture du TimeZone impossible : ${describeError(error)}`)
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
    // Sonde seule (jamais de mutation sur un serveur qui n'est pas le nôtre).
    await warnIfNonUtcTimezone(config)
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
      // Q-8 — convention d'horodatage UNIQUE : UTC.
      // `updated_at`/`created_at` sont des `timestamp` sans fuseau ; Drizzle
      // écrit et relit l'UTC de la `Date` JS, tandis que `defaultNow()` écrit
      // `now()` = fuseau de la SESSION PostgreSQL. Sans ce réglage, une même
      // colonne mélange Paris (+2 h) et UTC : `updated_at` peut RECULER après
      // un insert, et le curseur `(updated_at, id)` perd l'édition pour
      // toujours. `-c` vaut pour les clusters neufs COMME pour les data dirs
      // déjà créés (paramètre appliqué à chaque session, quel que soit le
      // `postgresql.conf` existant) — la vérification `ensureUtcTimezone()`
      // plus bas couvre le cas où le paquet beta ne transmettrait pas le
      // drapeau.
      '-c',
      'timezone=UTC',
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
    // Q-8 : fuseau UTC vérifié (et corrigé) AVANT la première écriture.
    await ensureUtcTimezone(config)
  } catch (error) {
    // Jamais de cluster orphelin derrière un démarrage avorté — et, si possible,
    // arrêt **gracieux** (`pg_ctl`) : même ici, pas de `taskkill /F` inutile.
    await stopCluster(pg, config).catch((stopError: unknown) => {
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
