import { app, dialog, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { registerIpcHandlers } from './ipc'
import { forceKillNextServer, redactSecrets, startNextServer, stopNextServer, type NextServerHandle } from './server/next'
import { createMainWindow, START_URL } from './window'

/** Délai de secours au-delà duquel l'arrêt du serveur est forcé (tâche 1.4). */
const SERVER_SHUTDOWN_TIMEOUT_MS = 5_000

let mainWindow: BrowserWindow | null = null
/** Serveur Next.js courant : lancé par l'application ou réutilisé s'il existait déjà. */
let nextServer: NextServerHandle | null = null
/** Arrêt en cours (ou déjà réalisé) — sert à synchroniser la sortie de l'application. */
let serverShutdown: Promise<void> | null = null

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

async function startApplication(): Promise<void> {
  registerIpcHandlers()
  const server = await startNextServer()
  nextServer = server
  log.info(
    `[main] serveur Next.js ${server.owned ? 'démarré' : 'réutilisé'} sur ${redactSecrets(server.url)} (port ${server.port})`,
  )
  try {
    // `startNextServer()` n'a résolu qu'une fois le serveur **prêt** (boucle
    // d'attente interne) : inutile d'ajouter une seconde boucle d'attente ici.
    await openMainWindow(server.url)
    log.info('[main] application démarrée')
  } catch (error) {
    // `finally` du bloc : aucun processus Next.js ne survit à un démarrage raté.
    await shutdownNextServer('démarrage en échec')
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

  // Sortie de l'application : on arrête (ou on force l'arrêt de) Next.js **avant**
  // `app.exit(0)`, avec un délai de secours de `SERVER_SHUTDOWN_TIMEOUT_MS`.
  app.on('before-quit', (event) => {
    if (nextServer === null && serverShutdown === null) {
      // Rien à arrêter : la sortie suit son cours normal (comportement tâche 1.3).
      return
    }
    event.preventDefault()
    void shutdownNextServer('before-quit')
      .catch((error: unknown) => {
        log.error('[main] échec de l’arrêt du serveur Next.js', error)
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
  // on ne laisse jamais de `next dev` orphelin (kill synchrone, idempotent).
  process.once('exit', () => {
    forceKillNextServer()
  })
}
