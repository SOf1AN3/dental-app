import { app, dialog, type BrowserWindow } from 'electron'
import log from 'electron-log'
import { registerIpcHandlers } from './ipc'
import { createMainWindow, START_URL } from './window'

const SERVER_POLL_INTERVAL_MS = 150
const SERVER_STARTUP_TIMEOUT_MS = 60_000

let mainWindow: BrowserWindow | null = null

/**
 * Attend que le serveur Next.js accepte les requêtes avant de charger l'URL.
 * Sans cela, la fenêtre afficherait une page d'erreur blanche pendant le démarrage
 * (compilation à froid de Next.js) ou un `loadURL` rejeté.
 */
async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS
  log.info(`[main] attente du serveur Next.js sur ${url}`)

  for (;;) {
    try {
      const response = await fetch(url, { method: 'HEAD' })
      // Toute réponse HTTP prouve que le serveur écoute sur le port.
      if (response.ok) {
        log.info(`[main] serveur prêt (HTTP ${response.status}) : ${url}`)
      } else {
        log.warn(`[main] serveur joignable mais en erreur (HTTP ${response.status}) : ${url}`)
      }
      return
    } catch {
      // Le serveur n'accepte pas encore les connexions : on réessaie.
    }

    if (Date.now() >= deadline) {
      break
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, SERVER_POLL_INTERVAL_MS)
    })
  }

  throw new Error(`Le serveur Next.js n'est pas prêt après ${SERVER_STARTUP_TIMEOUT_MS} ms : ${url}`)
}

async function openMainWindow(): Promise<void> {
  const win = createMainWindow()
  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })
  await win.loadURL(START_URL)
}

async function startApplication(): Promise<void> {
  registerIpcHandlers()
  await waitForServer(START_URL)
  await openMainWindow()
  log.info('[main] application démarrée')
}

function handleStartupFailure(error: unknown): void {
  log.error('[main] échec du démarrage', error)
  void dialog
    .showMessageBox({
      type: 'error',
      title: 'Échec du démarrage',
      message: "L'application de bureau n'a pas pu démarrer.",
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['OK'],
      noLink: true,
    })
    .catch((dialogError: unknown) => {
      log.error("[main] impossible d'afficher la boîte de dialogue d'erreur", dialogError)
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
    void openMainWindow().catch(handleStartupFailure)
  })

  // Hors macOS : fermeture de la dernière fenêtre = sortie de l'application.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
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
}
