import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
// Type seulement (effacé à la compilation) : le preload sandboxé n'embarque
// **aucun** code applicatif — seule l'union `SyncCycleResult` est référencée.
import type { SyncCycleResult } from '../src/lib/sync/runner-core'

/**
 * Pont renderer ⇄ main (Electron).
 *
 * Sécurité :
 * - `contextIsolation: true` + `sandbox: true` (voir `window.ts`) : aucun objet Node
 *   n'est exposé au renderer.
 * - Aucun `ipcRenderer` brut n'est exposé : uniquement les méthodes de haut niveau
 *   ci-dessous, et uniquement pour les canaux présents dans `DesktopEventMap`.
 */

/** Versions des composants de l'application. */
export interface AppVersions {
  /** Version de l'application elle-même (issue de `package.json`). */
  app: string
  /** Version du runtime Electron. */
  electron: string
  /** Version de Node.js embarquée. */
  node: string
}

/** Informations système exposées au renderer via `desktop.getInfo()`. */
export interface AppInfo {
  platform: NodeJS.Platform
  versions: AppVersions
}

/**
 * État du runner de synchronisation (miroir du contrat servi par
 * `sync:status` — voir `electron/sync/runner.ts`).
 *
 *  - `state`   : `online`/`offline`/`unknown` (dernier probe, via
 *    l'ordonnanceur) ou `inactive` (aucun runner : démarrage différé, échec de
 *    construction ou arrêt) ;
 *  - `lastSyncAt` : ISO du dernier cycle **réussi** (`pushed`/`pulled`) ;
 *  - `pendingCount` : lignes `pending` de l'outbox local (`null` si la base
 *    est indisponible) ;
 *  - `lastError` : dernier motif d'erreur **rédigé** (`null` si aucun).
 */
export interface SyncStatus {
  state: 'online' | 'offline' | 'unknown' | 'inactive'
  lastSyncAt: string | null
  pendingCount: number | null
  lastError: string | null
}

/** Résultat d'un cycle déclenché via `triggerSync()` — union du cœur pur. */
export type SyncTriggerResult = SyncCycleResult

/**
 * Résultat de `loginToSync(email, password)` (tâche 7.1 — bootstrap).
 *
 *  - `ok: true`  : jeton d'appareil **acquis et persisté** chiffré côté main ;
 *  - `ok: false` : échec de l'échange — `reason` est un motif **générique**
 *    (union fermée) et `message` un texte court à afficher ; **aucun** détail
 *    du serveur central, aucun mot de passe, aucun jeton n'y figurent ;
 *  - `serverRestarted` : `true` = l'enfant Next a bien été **redémarré** avec
 *    le nouvel env `SYNC_TOKEN` (le serveur local peut donc réserver des blocs
 *    et servir `/api/sync/bootstrap`) ;
 *  - `warning` : avertissement non bloquant quand `ok: true` mais que l'env n'a
 *    pas pu être appliqué (`env-unavailable`, `env-rebuild-failed`,
 *    `restart-failed`, `server-not-restartable`).
 *
 * ⚠️ Le mot de passe **ne transite** que dans le message IPC `sync:login` :
 * il n'est jamais journalisé, ni persisté, côté main.
 */
export interface SyncLoginResult {
  readonly ok: boolean
  readonly reason?: string
  readonly message?: string
  readonly serverRestarted: boolean
  readonly warning?: string
}

/**
 * Canaux IPC autorisés : c'est la allow-list unique du pont.
 *
 * Pour étendre le pont (synchronisation, etc.) :
 *  1. ajouter le canal + son type de payload ici ;
 *  2. enregistrer le `ipcMain.handle` correspondant dans `ipc.ts`.
 */
export interface DesktopEventMap {
  'app:info': AppInfo
  /** Réservé à l'état réseau — payload typé à l'étape synchronisation. */
  'net:state': unknown
  /** État courant du runner de synchronisation (`getSyncStatus()`). */
  'sync:status': SyncStatus
  /** Cycle déclenché à la demande (`triggerSync()`) — union `SyncCycleResult`. */
  'sync:trigger': SyncTriggerResult
  /** Échange d'identifiants contre un jeton d'appareil (`loginToSync()`). */
  'sync:login': SyncLoginResult
}

/** Union des canaux IPC autorisés. */
export type DesktopChannel = keyof DesktopEventMap

/** API publique exposée au renderer sous `window.desktop`. */
export interface DesktopApi {
  readonly platform: NodeJS.Platform
  readonly versions: AppVersions
  readonly isDesktop: true
  /** Récupère des informations fraîches depuis le processus principal. */
  getInfo(): Promise<AppInfo>
  /**
   * État courant de la synchronisation : `{ state, lastSyncAt, pendingCount,
   * lastError }` (runner inactif → `state: "inactive"`).
   */
  getSyncStatus(): Promise<SyncStatus>
  /**
   * Déclenche immédiatement un cycle de synchronisation et en retourne le
   * `SyncCycleResult` (un cycle déjà en cours est refusé : `noop` +
   * `reason: "concurrent-cycle"`).
   */
  triggerSync(): Promise<SyncTriggerResult>
  /**
   * Échange email + mot de passe contre un **jeton d'appareil** (tâche 7.1).
   *
   * Le payload `{ email, password }` voyage dans le message IPC **uniquement** :
   * le main ne le journalise ni ne le persiste, et renvoie un
   * `SyncLoginResult` générique. En cas de succès, le main redémarre l'enfant
   * Next avec `SYNC_TOKEN` à jour puis relance le runner.
   */
  loginToSync(email: string, password: string): Promise<SyncLoginResult>
  /**
   * S'abonne à un événement émis par le processus principal.
   * @returns fonction de désabonnement.
   */
  onEvent<C extends DesktopChannel>(channel: C, cb: (payload: DesktopEventMap[C]) => void): () => void
}

/**
 * Le preload est sandboxé : il n'a pas accès à l'API `app` du main.
 * La version de l'application est donc transmise via `webPreferences.additionalArguments`
 * (cf. `window.ts`) et lue depuis `process.argv` (polyfillé par Electron en mode sandbox).
 */
const APP_VERSION_ARG = '--dental-app-version='

function readAppVersionFromArgv(): string {
  const argv: readonly string[] = Array.isArray(process.argv) ? process.argv : []
  const arg = argv.find((value) => value.startsWith(APP_VERSION_ARG))
  return arg === undefined ? 'unknown' : arg.slice(APP_VERSION_ARG.length)
}

const ALLOWED_CHANNELS: readonly DesktopChannel[] = [
  'app:info',
  'net:state',
  'sync:status',
  'sync:trigger',
  'sync:login',
]

function isAllowedChannel(channel: string): channel is DesktopChannel {
  return (ALLOWED_CHANNELS as readonly string[]).includes(channel)
}

/** Handler `ipcRenderer.invoke` privé : aucun canal hors allow-list n'est accepté. */
function invoke<C extends DesktopChannel>(channel: C, ...args: unknown[]): Promise<DesktopEventMap[C]> {
  if (!isAllowedChannel(channel)) {
    return Promise.reject(new Error(`Canal IPC refusé : ${channel}`))
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<DesktopEventMap[C]>
}

function onEvent<C extends DesktopChannel>(channel: C, cb: (payload: DesktopEventMap[C]) => void): () => void {
  if (!isAllowedChannel(channel)) {
    throw new Error(`Canal IPC refusé : ${channel}`)
  }
  const listener = (_event: IpcRendererEvent, payload: DesktopEventMap[C]): void => {
    cb(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: DesktopApi = {
  platform: process.platform,
  versions: {
    app: readAppVersionFromArgv(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
  isDesktop: true,
  getInfo: () => invoke('app:info'),
  getSyncStatus: () => invoke('sync:status'),
  triggerSync: () => invoke('sync:trigger'),
  // Le couple identifiants ne quitte pas le message IPC : jamais de journal,
  // jamais de stockage côté main (voir `handleSyncLogin` de `main.ts`).
  loginToSync: (email, password) => invoke('sync:login', { email, password }),
  onEvent,
}

// Aucun objet Node (`ipcRenderer`, `require`, …) n'est exposé : uniquement `api`.
contextBridge.exposeInMainWorld('desktop', api)

declare global {
  interface Window {
    /**
     * API Electron exposée par le preload.
     * `undefined` si la page est ouverte dans un navigateur classique (`next dev` seul).
     */
    readonly desktop?: DesktopApi
  }
}
