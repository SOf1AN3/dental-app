import { app, ipcMain } from 'electron'
import log from 'electron-log'
import type { SyncCycleResult } from '@/lib/sync/runner-core'
import type { AppInfo, DesktopChannel, SyncStatus } from './preload'
import { getCurrentSyncRunner } from './sync/runner'

let handlersRegistered = false

/** Canal « app:info » — doit rester synchronisé avec la allow-list de `preload.ts`. */
const APP_INFO_CHANNEL: DesktopChannel = 'app:info'
/** Canal « sync:status » — état courant du runner de synchronisation. */
const SYNC_STATUS_CHANNEL: DesktopChannel = 'sync:status'
/** Canal « sync:trigger » — déclenche un cycle à la demande. */
const SYNC_TRIGGER_CHANNEL: DesktopChannel = 'sync:trigger'

/** État servi quand aucun runner n'est actif (démarrage différé, échec, arrêt). */
const INACTIVE_SYNC_STATUS: SyncStatus = {
  state: 'inactive',
  lastSyncAt: null,
  pendingCount: null,
  lastError: null,
}

/**
 * Enregistre les handlers IPC du processus principal.
 *
 * Deux handlers de synchronisation complètent le socle (`app:info`) :
 *  1. `sync:status`  → `{ state, lastSyncAt, pendingCount, lastError }` ;
 *  2. `sync:trigger` → le `SyncCycleResult` du cycle déclenché.
 * Les deux **répondent toujours** (jamais de rejet propagate au renderer) :
 * runner absent → état inactif / `noop` ; imprévu → `log.error` + repli typé.
 * La logique métier reste dans `electron/sync/runner.ts` — ici, aucun SQL,
 * aucune règle de synchronisation.
 *
 * `ipcMain.handle` ne peut être enregistré qu'une seule fois : d'où le garde
 * `handlersRegistered`.
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

  ipcMain.handle(SYNC_STATUS_CHANNEL, async (): Promise<SyncStatus> => {
    const runner = getCurrentSyncRunner()
    if (runner === null) {
      return INACTIVE_SYNC_STATUS
    }
    try {
      return await runner.getStatus()
    } catch (error) {
      log.error('[ipc] statut de synchronisation indisponible', error)
      return {
        state: 'unknown',
        lastSyncAt: null,
        pendingCount: null,
        lastError: 'statut indisponible',
      }
    }
  })

  ipcMain.handle(SYNC_TRIGGER_CHANNEL, async (): Promise<SyncCycleResult> => {
    const runner = getCurrentSyncRunner()
    if (runner === null) {
      return { status: 'noop', reason: 'runner-inactive' }
    }
    try {
      return await runner.triggerNow()
    } catch (error) {
      // `runSyncCycle` ne rejette jamais : filet contre un runner défaillant.
      log.error('[ipc] déclenchement de synchronisation impossible', error)
      return { status: 'error', reason: 'déclenchement impossible' }
    }
  })

  log.info('[ipc] handlers IPC enregistrés')
}
