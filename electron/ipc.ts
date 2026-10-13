import { app, ipcMain } from 'electron'
import log from 'electron-log'
import type { AppInfo, DesktopChannel } from './preload'

let handlersRegistered = false

/** Canal « app:info » — doit rester synchronisé avec la allow-list de `preload.ts`. */
const APP_INFO_CHANNEL: DesktopChannel = 'app:info'

/**
 * Enregistre les handlers IPC du processus principal.
 *
 * Aucune logique de synchronisation à ce stade (étape 1 : socle Electron minimal).
 * Structure prévue pour les futurs handlers de synchronisation :
 *  1. déclarer le canal + son payload dans `DesktopEventMap` (preload.ts) ;
 *  2. ajouter ici `ipcMain.handle('<canal>', …)` avec validation Zod du payload
 *     (`ipcMain.handle` ne peut être enregistré qu'une seule fois : d'où le garde
 *     `handlersRegistered`).
 */
export function registerIpcHandlers(): void {
  if (handlersRegistered) {
    return
  }
  handlersRegistered = true

  ipcMain.handle(APP_INFO_CHANNEL, (): AppInfo => {
    return {
      platform: process.platform,
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron ?? 'unknown',
        node: process.versions.node ?? 'unknown',
      },
    }
  })

  log.info('[ipc] handlers IPC enregistrés')
}
