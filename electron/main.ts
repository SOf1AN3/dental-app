import { app, dialog, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { closeDesktopDb, createDesktopDb, getDesktopDb, setDesktopDb } from '@/lib/db/desktop-db'
import { forceStopLocalDb, startLocalDb, type LocalDbHandle } from './db/embedded-pg'
import { runMigrations } from './db/migrate'
import { buildNextEnv, resolveDbConfig } from './env'
import { registerIpcHandlers } from './ipc'
import type { SyncLoginResult } from './preload'
import {
  forceKillNextServer,
  redactSecrets,
  restartNextServer,
  startNextServer,
  stopNextServer,
  type NextServerHandle,
} from './server/next'
import { loginToCentral, type LoginToCentralResult } from './sync/auth'
import { startSyncRunner, type SyncRunnerHandle } from './sync/runner'
import { createMainWindow, START_URL } from './window'

/** Délai de secours au-delà duquel l'arrêt du serveur est forcé (tâche 1.4). */
const SERVER_SHUTDOWN_TIMEOUT_MS = 5_000
/** Délai de secours au-delà duquel l'arrêt de la base locale est forcé (tâche 2.2a). */
const DB_SHUTDOWN_TIMEOUT_MS = 5_000

let mainWindow: BrowserWindow | null = null
/** Serveur Next.js courant : lancé par l'application ou réutilisé s'il existait déjà. */
let nextServer: NextServerHandle | null = null
/** Arrêt en cours (ou déjà réalisé) — sert à synchroniser la sortie de l'application. */
let serverShutdown: Promise<void> | null = null
/** Base locale courante : démarrée (ou réutilisée) **avant** le serveur Next. */
let localDb: LocalDbHandle | null = null
/** Arrêt de la base locale en cours (ou déjà réalisé) — idempotent comme `serverShutdown`. */
let dbShutdown: Promise<void> | null = null
/** Runner de synchronisation (étape 5.5) : démarré **après** Next, arrêté **en premier**. */
let syncRunner: SyncRunnerHandle | null = null
/** `true` si le pool Drizzle du poste est installé ici (à fermer à l'arrêt). */
let desktopDbInstalled = false
/** Fermeture du pool Drizzle en cours (ou déjà réalisée) — idempotente. */
let desktopDbShutdown: Promise<void> | null = null
/**
 * Reconstruction de l'env de l'enfant Next (tâche 7.1) : fermeture sur
 * `buildNextEnv(db, config)` capturés au démarrage, installée **une fois** PG
 * migré et l'env initial construit. Permet à `handleSyncLogin()` de produire un
 * env intégrant le **jeton fraîchement persisté** sans re-exécuter le bootstrap
 * complet. `null` tant que le démarrage n'a pas atteint cette étape.
 */
let rebuildNextEnv: (() => NodeJS.ProcessEnv) | null = null

async function openMainWindow(url: string): Promise<void> {
  const win = createMainWindow()
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })
  await win.loadURL(url)
}

/** URL du serveur courant, avec repli sur `START_URL` (serveur jamais démarré). */
function currentServerUrl(): string {
  return nextServer !== null ? nextServer.url : START_URL
}

/**
 * Hôte **seul** d'une URL de connexion (étape 2.2b, revue C2) : `localDb.url`
 * contient le mot de passe — on n'en extrait que la composante `hostname`, car
 * l'hôte n'est pas toujours le bouclage en dev (il provient du `DATABASE_URL`
 * du `.env`). Repli explicite si l'URL est illisible : jamais l'URL brute.
 */
function hostOfDbUrl(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '(hôte illisible)'
  }
}

/**
 * Arrêt (ou forçage) du serveur Next.js.
 *
 * Idempotent : un second appel retourne la promesse en cours — jamais de rejet.
 * Si l'arrêt dépasse `SERVER_SHUTDOWN_TIMEOUT_MS`, on force via `forceKillNextServer()`
 * pour ne jamais bloquer la sortie de l'application.
 */
function shutdownNextServer(reason: string): Promise<void> {
  if (serverShutdown !== null) {
    return serverShutdown
  }
  const handle = nextServer
  if (handle === null) {
    serverShutdown = Promise.resolve()
    return serverShutdown
  }
  nextServer = null
  log.info(`[main] arrêt du serveur Next.js (${reason})`)

  serverShutdown = (async () => {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        stopNextServer(handle).then(() => 'stopped' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, SERVER_SHUTDOWN_TIMEOUT_MS)
        }),
      ])
      if (result === 'timeout') {
        log.warn(`[main] arrêt du serveur dépassé (${SERVER_SHUTDOWN_TIMEOUT_MS} ms) : kill forcé`)
        forceKillNextServer()
      } else {
        log.info('[main] serveur Next.js arrêté')
      }
    } catch (error) {
      // `stopNextServer` ne devrait jamais rejeter : on n'interrompt donc pas la sortie.
      log.error('[main] échec de l’arrêt du serveur Next.js', error)
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  })()

  return serverShutdown
}

/**
 * Arrêt (ou forçage) de la base locale.
 *
 * Même contrat que `shutdownNextServer()` : idempotent, jamais rejetant, et si
 * l'arrêt dépasse `DB_SHUTDOWN_TIMEOUT_MS` on force via `forceStopLocalDb()`
 * (filet synchrone) pour ne jamais bloquer la sortie de l'application. Un
 * serveur **réutilisé** (`owned: false`) a un `stop()` no-op : rien n'est tué.
 */
function shutdownLocalDb(reason: string): Promise<void> {
  if (dbShutdown !== null) {
    return dbShutdown
  }
  const handle = localDb
  if (handle === null) {
    dbShutdown = Promise.resolve()
    return dbShutdown
  }
  localDb = null
  log.info(`[main] arrêt de la base locale (${reason})`)

  dbShutdown = (async () => {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        handle.stop().then(() => 'stopped' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout')
          }, DB_SHUTDOWN_TIMEOUT_MS)
        }),
      ])
      if (result === 'timeout') {
        log.warn(`[main] arrêt de la base locale dépassé (${DB_SHUTDOWN_TIMEOUT_MS} ms) : kill forcé`)
        forceStopLocalDb()
      } else {
        log.info('[main] base locale arrêtée')
      }
    } catch (error) {
      // `handle.stop()` ne devrait jamais rejeter : on n'interrompt donc pas la sortie.
      log.error('[main] échec de l’arrêt de la base locale', error)
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
    }
  })()

  return dbShutdown
}

/**
 * Fermeture du pool Drizzle du poste (étape 5.5) : client du cluster local,
 * utilisé par le runner de synchro. À exécuter **après** l'arrêt du runner et
 * **avant** l'arrêt de Next / de la base locale.
 *
 * Idempotent comme `shutdownNextServer()` : un second appel retourne la
 * promesse en cours, jamais de rejet (un échec est journalisé, pas propagé —
 * il ne doit jamais bloquer la sortie).
 */
function shutdownDesktopDb(): Promise<void> {
  if (desktopDbShutdown !== null) {
    return desktopDbShutdown
  }
  if (!desktopDbInstalled) {
    desktopDbShutdown = Promise.resolve()
    return desktopDbShutdown
  }
  desktopDbInstalled = false
  log.info('[main] fermeture du pool de synchronisation')
  desktopDbShutdown = closeDesktopDb(getDesktopDb()).catch((error: unknown) => {
    log.error('[main] échec de la fermeture du pool de synchronisation', error)
  })
  return desktopDbShutdown
}

/**
 * Reconnexion au serveur central (tâche 7.1) — séquence complète :
 *  1. `loginToCentral()` : échange email + mot de passe contre un **jeton
 *     d'appareil**, persisté chiffré (`writeSyncToken`). Le mot de passe n'est
 *     **ni journalisé ni conservé** : il ne survit pas à cet appel ;
 *  2. reconstruction de l'env de l'enfant (`buildNextEnv`) : `SYNC_TOKEN` y
 *     figure désormais (jeton frais, non expiré) ;
 *  3. `restartNextServer()` : l'enfant Next **redémarre** avec ce nouvel env —
 *     seul moyen de lui transmettre un `SYNC_TOKEN` (indispensable à la
 *     réservation de blocs, tâche 6.1c) ;
 *  4. déclenchement immédiat du runner (`triggerNow`) : le cœur **relit** le
 *     jeton persisté à chaque cycle (`deps.token.read` → `readSyncToken()`),
 *     aucune configuration n'a donc à être poussée — d'où l'absence de
 *     `setSyncToken` sur le handle du runner.
 *
 * **Aucune défaillance ne casse l'application** : chaque étape est encapsulée
 * et se termine par un `SyncLoginResult` typé pour le renderer (échec du login
 * → `ok: false` ; jeton acquis mais env non appliqué → `ok: true` +
 * `warning`). Aucun message ne contient de mot de passe ni de jeton.
 */
async function handleSyncLogin(email: string, password: string): Promise<SyncLoginResult> {
  // 1 — échange d'identifiants (garde anti-throw : `loginToCentral` se veut
  //     non levante, mais une défaillance imprévue ne doit jamais remonter
  //     en travers de l'IPC).
  let auth: LoginToCentralResult
  try {
    auth = await loginToCentral({ email, password })
  } catch (error) {
    log.error(`[main] échange d’identifiants imprévu (${error instanceof Error ? error.name : 'unknown'})`)
    return {
      ok: false,
      reason: 'central-error',
      message: 'Échange d’identifiants impossible (erreur interne).',
      serverRestarted: false,
    }
  }
  if (!auth.ok) {
    log.warn(`[main] connexion au serveur central refusée : ${auth.reason}`)
    return { ok: false, reason: auth.reason, message: auth.message, serverRestarted: false }
  }

  // 2 — env reconstruit avec le jeton fraîchement persisté.
  if (rebuildNextEnv === null) {
    log.warn('[main] env de l’enfant Next indisponible : jeton acquis mais non transmis (aucun redémarrage)')
    return { ok: true, serverRestarted: false, warning: 'env-unavailable' }
  }
  let env: NodeJS.ProcessEnv
  try {
    env = rebuildNextEnv()
  } catch (error) {
    // `redactSecrets` : le message peut reprendre un chemin ou une clé de config.
    log.warn(redactSecrets(`[main] reconstruction de l’env Next impossible : ${messageOf(error)}`))
    return { ok: true, serverRestarted: false, warning: 'env-rebuild-failed' }
  }

  // 3 — redémarrage de l'enfant avec le nouvel env (serveur réutilisé →
  //     `restarted: false` + avertissement journalisé côté `next.ts`).
  try {
    const restarted = await restartNextServer({ env, previous: nextServer })
    nextServer = restarted.handle
    if (!restarted.restarted) {
      log.warn('[main] env de connexion NON appliqué : serveur Next réutilisé hors de notre contrôle')
      return { ok: true, serverRestarted: false, warning: 'server-not-restartable' }
    }
  } catch (error) {
    log.warn(redactSecrets(`[main] redémarrage du serveur Next impossible : ${messageOf(error)}`))
    return { ok: true, serverRestarted: false, warning: 'restart-failed' }
  }
  log.info('[main] serveur Next redémarré avec le jeton d’appareil à jour')

  // 4 — runner : premier cycle immédiat (jamais bloquant pour l'UI).
  const runner = syncRunner
  if (runner !== null) {
    void runner.triggerNow().catch((error: unknown) => {
      log.warn(`[main] premier cycle après reconnexion impossible (${error instanceof Error ? error.name : 'unknown'})`)
    })
  }

  return { ok: true, serverRestarted: true }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Démarrage de l'application — **ordre imposé (étapes 2.2a + 2.5 + 5.5)** :
 *   1. `resolveDbConfig()`   → config dev/prod ;
 *   2. `startLocalDb()`      → PostgreSQL prêt (réutilisé ou démarré) ;
 *   3. `runMigrations()`     → schéma migré (`drizzle/*.sql`, idempotent) :
 *      échec → nettoyage via le chemin d'arrêt existant + `handleStartupFailure`
 *      (dialogue + `app.quit()`) — **jamais** de fenêtre sur un schéma non migré ;
 *   4. `buildNextEnv()`      → env de l'enfant Next (DATABASE_URL, AUTH_SECRET…) ;
 *   5. `startNextServer()`   → serveur prêt ;
 *   6. `openMainWindow()`    → `loadURL` uniquement quand tout est prêt ;
 *   7. `startSyncRunner()`   → runner de synchronisation **après** migrations +
 *      Next : échec → `log.warn` + runner inactif, **l'app reste utilisable**.
 *
 * L'arrêt (`before-quit`) reprend cet ordre **inversé** : runner d'abord (aucun
 * cycle en vol), pool de synchro, puis Next (plus aucune écriture possible),
 * et seulement ensuite la base locale.
 */
async function startApplication(): Promise<void> {
  // Handlers IPC : `sync:login` délègue à `handleSyncLogin` (tâche 7.1) —
  // injection explicite pour éviter tout cycle d'import ipc ↔ main.
  registerIpcHandlers({ onSyncLogin: handleSyncLogin })

  // 1 + 2 — base locale : doit être saine avant tout enfant Next.
  const config = resolveDbConfig()
  try {
    localDb = await startLocalDb(config)
  } catch (error) {
    // Chemin d'erreur existant (`handleStartupFailure` → dialogue → `app.quit()`)
    // avec un message explicite : c'est la base qui a échoué, pas Next.
    throw new Error(
      `Impossible de démarrer la base locale : ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  log.info(
    // L'hôte provient du `DATABASE_URL` résolue (du `.env` en dev) : il n'est
    // **pas** toujours `127.0.0.1` — on journalise l'hôte réel, redacté (jamais
    // l'URL ni les identifiants).
    redactSecrets(
      `[main] base locale ${localDb.owned ? 'démarrée' : 'réutilisée'} sur ${hostOfDbUrl(localDb.url)}:${localDb.port}` +
        `${localDb.owned ? '' : ' (aucun processus à notre charge)'}`,
    ),
  )

  try {
    // 3 — migrations Drizzle : strictement après santé de PG et **avant** tout
    // env / serveur / fenêtre. `runMigrations()` rejette sur tout échec (cause
    // racine redactée) : le `catch` ci-dessous nettoie la base locale lancée
    // (Next n'a pas encore démarré, `shutdownNextServer()` y est un no-op),
    // puis `handleStartupFailure()` affiche « les migrations ont échoué » et
    // quitte — aucun rendu sur un schéma partiel.
    await runMigrations(localDb.url)
    // 4 — env de l'enfant : construit uniquement une fois PG prêt et migré.
    const env = buildNextEnv(localDb, config)
    // Fermeture de reconnexion (tâche 7.1) : rejoue **exactement** cette
    // construction plus tard, avec le jeton d'appareil à jour — `buildNextEnv`
    // relit `config.json` (donc `readSyncToken()`) à chaque appel.
    const dbHandle = localDb
    rebuildNextEnv = () => buildNextEnv(dbHandle, config)
    // 5 — serveur Next (réutilise un `next dev` déjà actif, sinon le lance).
    // En prod, l'injection est **obligatoire** : un serveur réutilisé garde son
    // propre `DATABASE_URL`/`AUTH_SECRET` → rejet explicite plutôt que de parler
    // à une autre base que le cluster embarqué (revue C3).
    const server = await startNextServer({ env, requireEnvInjection: config.mode === 'prod' })
    nextServer = server
    log.info(
      `[main] serveur Next.js ${server.owned ? 'démarré' : 'réutilisé'} sur ${redactSecrets(server.url)} (port ${server.port})`,
    )
    // 6 — la fenêtre ne se charge que d'un serveur déjà disponible.
    // `startNextServer()` n'a résolu qu'une fois le serveur **prêt** (boucle
    // d'attente interne) : inutile d'ajouter une seconde boucle d'attente ici.
    await openMainWindow(server.url)
    log.info('[main] application démarrée')

    // 7 — runner de synchronisation (étape 5.5) : **jamais bloquant**. Le main
    //     fournit l'URL de la base (singleton `desktop-db`) puis lance la
    //     boucle ; toute défaillance reste en `warn` + runner inactif — le
    //     démarrage de l'app n'est jamais remis en cause à ce stade.
    try {
      if (getDesktopDb() === null) {
        setDesktopDb(createDesktopDb(localDb.url))
        desktopDbInstalled = true
      }
      syncRunner = startSyncRunner({ baseUrl: env.SYNC_BASE_URL })
    } catch (error) {
      log.warn(
        redactSecrets(
          `[main] runner de synchronisation non démarré (application inchangée) : ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
    }
  } catch (error) {
    // `finally` du bloc : ni processus Next.js ni base locale ne survivent à un
    // démarrage raté (arrêt dans l'ordre inversé, idempotent).
    await shutdownNextServer('démarrage en échec')
    await shutdownLocalDb('démarrage en échec')
    throw error
  }
}

function handleStartupFailure(error: unknown): void {
  log.error('[main] échec du démarrage', error)
  void dialog
    .showMessageBox({
      type: 'error',
      title: 'Échec du démarrage',
      message: "L'application de bureau n'a pas pu démarrer.",
      // Par prudence : le message peut reprendre une URL (timeout, config) —
      // même redaction que les logs de `next.ts` (aucune donnée sensible en clair).
      detail: redactSecrets(error instanceof Error ? error.message : String(error)),
      buttons: ['OK'],
      noLink: true,
    })
    .catch((dialogError: unknown) => {
      log.error("[main] impossible d'afficher la boîte de dialogue d'erreur", dialogError)
    })
    .finally(() => {
      // Sans fenêtre, l'app resterait un processus zombie après fermeture du
      // dialogue : on sort proprement. `app.quit()` déclenche `before-quit`,
      // qui gère déjà l'arrêt du serveur (aucun `app.exit` en double).
      app.quit()
    })
}

function bootstrap(): void {
  const hasSingleInstanceLock = app.requestSingleInstanceLock()

  if (!hasSingleInstanceLock) {
    // Une autre instance détient le verrou : on laisse la première prendre le relais.
    app.quit()
    return
  }

  // Deuxième lancement : on remonte la fenêtre existante.
  app.on('second-instance', () => {
    if (mainWindow === null) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  })

  // macOS : toutes les fenêtres sont fermées, l'application reste active.
  app.on('activate', () => {
    if (mainWindow !== null) {
      return
    }
    void openMainWindow(currentServerUrl()).catch(handleStartupFailure)
  })

  // Hors macOS : fermeture de la dernière fenêtre = sortie de l'application.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // Sortie de l'application : arrêt **séquentiel et inversé** — runner de
  // synchro d'abord (aucun cycle ne doit survivre à l'arrêt), pool de synchro,
  // ensuite Next (aucune écriture ne doit subsister), et seulement enfin la
  // base locale, avant `app.exit(0)`. Chaque étape est bornée à ~5 s.
  app.on('before-quit', (event) => {
    const runner = syncRunner
    if (
      runner === null &&
      nextServer === null &&
      serverShutdown === null &&
      localDb === null &&
      dbShutdown === null &&
      desktopDbShutdown === null &&
      !desktopDbInstalled
    ) {
      // Rien à arrêter : la sortie suit son cours normal (comportement tâche 1.3).
      return
    }
    event.preventDefault()

    // 1 — runner : `stop()` est idempotent et libère le timer (aucun tick ne
    //     s'exécutera pendant la fermeture des ressources).
    if (runner !== null) {
      syncRunner = null
      try {
        runner.stop()
      } catch (error) {
        log.error('[main] échec de l’arrêt du runner de synchronisation', error)
      }
    }

    void shutdownDesktopDb()
      .then(() => shutdownNextServer('before-quit'))
      .catch((error: unknown) => {
        log.error('[main] échec de l’arrêt du serveur Next.js', error)
      })
      .then(() => shutdownLocalDb('before-quit'))
      .catch((error: unknown) => {
        log.error('[main] échec de l’arrêt de la base locale', error)
      })
      .finally(() => {
        app.exit(0)
      })
  })

  log.transports.file.level = 'info'
  log.transports.console.level = 'info'

  void app
    .whenReady()
    .then(startApplication)
    .catch(handleStartupFailure)
}

try {
  bootstrap()
} catch (error) {
  handleStartupFailure(error)
} finally {
  // Filet de sécurité : même en cas de sortie imprévue du processus main,
  // on ne laisse ni `next dev` orphelin (kill synchrone, idempotent) ni un
  // cluster PostgreSQL que nous aurions lancé (`forceStopLocalDb` ne tue que
  // le cluster `owned` — un serveur réutilisé n'est jamais touché).
  process.once('exit', () => {
    forceKillNextServer()
    forceStopLocalDb()
  })
}
