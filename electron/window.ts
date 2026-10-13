import { app, BrowserWindow, shell } from 'electron'
import log from 'electron-log'
import path from 'node:path'

/**
 * URL de départ de l'application : le renderer est l'application Next.js existante,
 * servie par `next dev` (développement) ou `next start` (production).
 * Partagée avec `main.ts`, qui attend la disponibilité du serveur avant le chargement.
 */
export const START_URL = process.env.ELECTRON_START_URL || 'http://localhost:3000'

const WINDOW_WIDTH = 1440
const WINDOW_HEIGHT = 900

/** Hôtels autorisés pour l'ouverture de liens externes dans le navigateur système. */
const EXTERNAL_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  // À compléter (support, paiement, …) au fil des besoins.
  'github.com',
])

function resolveAppOrigin(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return 'http://localhost:3000'
  }
}

const APP_ORIGIN = resolveAppOrigin(START_URL)

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase()
}

/** Ouvre une URL dans le navigateur système uniquement si https + allow-listed. */
function openExternalIfAllowed(rawUrl: string): void {
  if (!rawUrl.startsWith('https://')) {
    return
  }
  let hostname: string
  try {
    hostname = normalizeHostname(new URL(rawUrl).hostname)
  } catch {
    log.warn(`[window] URL externe illisible, ignorée : ${rawUrl}`)
    return
  }
  if (!EXTERNAL_HOST_ALLOWLIST.has(hostname)) {
    return
  }
  void shell.openExternal(rawUrl).catch((error: unknown) => {
    log.error(`[window] échec de l'ouverture externe : ${rawUrl}`, error)
  })
}

/**
 * Fabrique la fenêtre principale de l'application.
 *
 * Durcissement appliqué (§1.3) :
 * - `contextIsolation`, `sandbox`, `webSecurity` activés, `nodeIntegration` désactivé ;
 * - toute création de fenêtre (`window.open`, `target="_blank"`) est refusée ;
 * - la navigation est limitée à l'origine de l'application Next.js.
 *
 * TODO(étape 10 — durcissement) : CSP stricte via `session.webRequest.onHeadersReceived`.
 * Volontairement absente ici : elle casserait le HMR de Next.js en développement.
 */
export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    center: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      // Le preload sandboxé n'a pas accès à l'API `app` : la version est passée par argv.
      additionalArguments: [`--dental-app-version=${app.getVersion()}`],
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  // Toute tentative d'ouverture de fenêtre est refusée ; seuls des liens externes
  // https et autorisés sont délégués au navigateur système.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfAllowed(url)
    return { action: 'deny' }
  })

  // Interdiction de naviguer hors de l'origine de l'application (ex. lien externe
  // chargé dans la fenêtre principale).
  win.webContents.on('will-navigate', (event, targetUrl) => {
    let origin: string | null = null
    try {
      origin = new URL(targetUrl).origin
    } catch {
      origin = null
    }
    if (origin === APP_ORIGIN) {
      return
    }
    event.preventDefault()
    log.warn(`[window] navigation hors origine bloquée : ${targetUrl}`)
  })

  return win
}
