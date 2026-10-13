import { app, dialog, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { forceStopLocalDb, startLocalDb, type LocalDbHandle } from './db/embedded-pg'
import { buildNextEnv, resolveDbConfig } from './env'
import { registerIpcHandlers } from './ipc'
import { forceKillNextServer, redactSecrets, startNextServer, stopNextServer, type NextServerHandle } from './server/next'
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
 * Démarrage de l'application — **ordre imposé (étape 2.2a)** :
 *   1. `resolveDbConfig()`  → config dev/prod ;
 *   2. `startLocalDb()`     → PostgreSQL prêt (réutilisé ou démarré) ;
 *   3. `buildNextEnv()`     → env de l'enfant Next (DATABASE_URL, AUTH_SECRET…) ;
 *   4. `startNextServer()`  → serveur prêt ;
 *   5. `openMainWindow()`   → `loadURL` uniquement quand tout est prêt.
 *
 * L'arrêt (`before-quit`) reprend cet ordre **inversé** : Next d'abord (plus
 * aucune écriture possible), puis la base locale.
 */
async function startApplication(): Promise<void> {
  registerIpcHandlers()

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
    `[main] base locale ${localDb.owned ? 'démarrée' : 'réutilisée'} sur 127.0.0.1:${localDb.port}` +
      `${localDb.owned ? '' : ' (aucun processus à notre charge)'}`,
  )

  try {
    // 3 — env de l'enfant : construit uniquement une fois PG prêt.
    const env = buildNextEnv(localDb, config)
    // 4 — serveur Next (réutilise un `next dev` déjà actif, sinon le lance).
    const server = await startNextServer({ env })
    nextServer = server
    log.info(
      `[main] serveur Next.js ${server.owned ? 'démarré' : 'réutilisé'} sur ${redactSecrets(server.url)} (port ${server.port})`,
    )
    // 5 — la fenêtre ne se charge que d'un serveur déjà disponible.
    // `startNextServer()` n'a résolu qu'une fois le serveur **prêt** (boucle
    // d'attente interne) : inutile d'ajouter une seconde boucle d'attente ici.
    await openMainWindow(server.url)
    log.info('[main] application démarrée')
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

  // Sortie de l'application : arrêt **séquentiel et inversé** — Next d'abord
  // (aucune écriture ne doit subsister), puis la base locale, et seulement
  // ensuite `app.exit(0)`. Chaque étape est bornée à ~5 s (`…_SHUTDOWN_TIMEOUT_MS`).
  app.on('before-quit', (event) => {
    if (nextServer === null && serverShutdown === null && localDb === null && dbShutdown === null) {
      // Rien à arrêter : la sortie suit son cours normal (comportement tâche 1.3).
      return
    }
    event.preventDefault()
    void shutdownNextServer('before-quit')
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
