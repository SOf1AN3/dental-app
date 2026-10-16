import { app, ipcMain } from 'electron'
import log from 'electron-log'
import { z } from 'zod'
import type { SyncCycleResult } from '@/lib/sync/runner-core'
import type { AppInfo, DesktopChannel, SyncLoginResult, SyncStatus } from './preload'
import { getCurrentSyncRunner } from './sync/runner'

let handlersRegistered = false

/** Canal « app:info » — doit rester synchronisé avec la allow-list de `preload.ts`. */
const APP_INFO_CHANNEL: DesktopChannel = 'app:info'
/** Canal « sync:status » — état courant du runner de synchronisation. */
const SYNC_STATUS_CHANNEL: DesktopChannel = 'sync:status'
/** Canal « sync:trigger » — déclenche un cycle à la demande. */
const SYNC_TRIGGER_CHANNEL: DesktopChannel = 'sync:trigger'
/**
 * Canal « sync:login » — échange email/mot de passe contre un jeton
 * d'appareil (tâche 7.1). Le `SyncLoginResult` propagé porte aussi les
 * `clinicIds` du compte (tâche P1, ajoutés par `electron/sync/auth.ts`).
 */
const SYNC_LOGIN_CHANNEL: DesktopChannel = 'sync:login'

/**
 * Payload de `sync:login` — validé par Zod **avant** tout traitement.
 *
 * Bornes raisonnables (email RFC usuel, mot de passe ≤ 1 KiB) : un payload
 * hors bornes est refusé **sans appel réseau et sans journaliser de valeur**
 * (le corps porte un mot de passe).
 */
const syncLoginPayloadSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(1024),
})

/**
 * Dépendances injectées au registre des handlers — `main.ts` fournit
 * `onSyncLogin` (connexion au central, tâche 7.1). L'injection évite tout
 * cycle d'import `ipc.ts` ↔ `main.ts` (ce dernier appelle ce registre).
 */
export interface IpcHandlerDeps {
  readonly onSyncLogin?: (email: string, password: string) => Promise<SyncLoginResult>
}

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
 * Trois handlers de synchronisation complètent le socle (`app:info`) :
 *  1. `sync:status`  → `{ state, lastSyncAt, pendingCount, lastError }` ;
 *  2. `sync:trigger` → le `SyncCycleResult` du cycle déclenché ;
 *  3. `sync:login`   → `SyncLoginResult` (tâche 7.1 — échange d'identifiants
 *     contre un jeton d'appareil, délégation à `main.ts` via `deps.onSyncLogin`).
 * Les trois **répondent toujours** (jamais de rejet propagé au renderer) :
 * runner absent → état inactif / `noop` ; imprévu → `log.error` + repli typé.
 * La logique métier reste dans `electron/sync/runner.ts` et
 * `electron/sync/auth.ts` — ici, aucun SQL, aucune règle de synchronisation.
 *
 * ⚠️ **`sync:login` porte un mot de passe** : le payload est validé (Zod),
 * **jamais journalisé** (ni valeur, ni longueur, ni échec détaillé — seul le
 * type d'erreur est tracé) et **jamais persisté** côté main.
 *
 * `ipcMain.handle` ne peut être enregistré qu'une seule fois : d'où le garde
 * `handlersRegistered` (les déps sont donc ceux du **premier** appel).
 */
export function registerIpcHandlers(deps: IpcHandlerDeps = {}): void {
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

  ipcMain.handle(SYNC_LOGIN_CHANNEL, async (_event, payload: unknown): Promise<SyncLoginResult> => {
    // (1) Validation Zod — échec = réponse typée, **aucune valeur journalisée**
    //     (le payload contient le mot de passe de l'utilisateur).
    const parsed = syncLoginPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      log.warn('[ipc] payload sync:login invalide (détails et valeurs non journalisés)')
      return {
        ok: false,
        reason: 'invalid-identifiers',
        message: 'Identifiants incomplets ou trop longs.',
        serverRestarted: false,
      }
    }
    const onSyncLogin = deps.onSyncLogin
    if (onSyncLogin === undefined) {
      log.warn('[ipc] handler sync:login non câblé (onSyncLogin absent)')
      return {
        ok: false,
        reason: 'central-error',
        message: 'Connexion au serveur central indisponible.',
        serverRestarted: false,
      }
    }
    // (2) Délégation à `main.ts` — le mot de passe vit le temps de cet appel.
    //     Le `SyncLoginResult` est retourné **tel quel** : `clinicIds` (cabinets
    //     du compte, tâche P1) fait partie du contrat et n'est ni dégradé, ni
    //     complété, ni journalisé ici (jamais de valeur inventée côté IPC).
    try {
      return await onSyncLogin(parsed.data.email, parsed.data.password)
    } catch (error) {
      // Seul le **nom** de l'erreur est journalisé : un message d'exception
      // pourrait reprendre une URL ou un fragment de requête.
      log.error(`[ipc] échec de sync:login (raison=${error instanceof Error ? error.name : 'unknown'})`)
      return {
        ok: false,
        reason: 'central-error',
        message: 'Échange d’identifiants impossible (erreur interne).',
        serverRestarted: false,
      }
    }
  })

  log.info('[ipc] handlers IPC enregistrés')
}
