import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

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

const ALLOWED_CHANNELS: readonly DesktopChannel[] = ['app:info', 'net:state']

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
