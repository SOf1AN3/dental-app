import { app, BrowserWindow, session, shell } from 'electron'
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

/* -------------------------------------------------------------------------- */
/* Content-Security-Policy (durcissement — étape 10)                          */
/* -------------------------------------------------------------------------- */

/**
 * Indique si l'URL pointe vers une origine de **bouclage** (le serveur Next
 * local embarqué). On ne réécrit la CSP que pour ces réponses : la fenêtre ne
 * charge que le serveur local (navigation hors origine déjà bloquée par
 * `will-navigate`), et aucune autre origine n'est touchée.
 *
 * On accepte `localhost`, `127.0.0.1` et `[::1]` — le port peut varier (le
 * serveur Next en dev prend un port libre si 3000 est pris), d'où une vérification
 * sur l'**hôte** seule plutôt que sur `APP_ORIGIN` exact.
 */
function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
  } catch {
    return false
  }
}

/**
 * Construit la politique de CSP selon le mode.
 *
 * ## Analyse des charges réelles du renderer (vérifiées dans le code)
 *
 * - **Polices** : `src/app/layout.tsx` utilise `next/font/google` (Inter), mais
 *   `next/font` **auto-héberge** les fichiers au build (`/_next/static/media/*.woff2`) :
 *   **aucune** requête runtime vers `fonts.googleapis.com`/`fonts.gstatic.com`. → `font-src 'self'`.
 * - **Images** : routes locales `/api/files/*` (`'self'`), SVG d'odontogramme en
 *   `data:image/svg+xml` (`data:`), aperçus de logos/radios via
 *   `URL.createObjectURL` (`blob:`). L'adaptateur S3 est **inactif** en desktop
 *   (`buildNextEnv` ne définit pas `S3_REGION`/`S3_BUCKET` → `LocalStorageAdapter`).
 *   → `img-src 'self' data: blob:`.
 * - **Scripts** : Next.js App Router **inliné** le payload RSC/flight dans le HTML
 *   (`self.__next_f.push(…)` en `<script>` **sans nonce ni hash déterministe**) :
 *   un `script-src 'self'` strict **casserait le rendu** (aucune hydratation).
 *   → `'unsafe-inline'` **indispensable** (compromis documenté ci-dessous).
 * - **Styles** : CSS Next (`'self'`) + attributs/`<style>` inline React et
 *   `next-themes` → `style-src 'self' 'unsafe-inline'`.
 *
 * ## Compromis retenu (prod)
 *
 * `script-src 'self' 'unsafe-inline'` : on **sécurise sans casser**. Le
 * `'unsafe-inline'` est requis par le bootstrap inline d'App Router ; on le
 * compense par le reste de la politique — `object-src 'none'`,
 * `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, et surtout
 * `default-src`/`connect-src`/`img-src` bornés à `'self'` : un `<script src>`
 * vers une origine tierce reste **bloqué**, seuls les scripts *inline* sont
 * tolérés. Un nonce exigerait un câblage serveur (`next.config.ts` + injection
 * dans le HTML), hors périmètre de cette tâche.
 *
 * ## Mode dev (`ELECTRON_DEV=1`)
 *
 * Permissive **mais locale** : HMR Next/React Refresh exige `'unsafe-eval'`,
 * des scripts inline et des **websockets** — bornées à `ws(s)://localhost:*` et
 * `ws(s)://127.0.0.1:*` (aucune origine distante). `object-src 'none'` et
 * `frame-ancestors 'none'` restent appliqués. La permissivité est **limitée au
 * dev** : la build de production n'embarque ni HMR ni eval.
 */
function buildContentSecurityPolicy(): string {
  // Directives communes aux deux modes (sécurité de base, jamais relâchée).
  const shared = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ]

  if (process.env.ELECTRON_DEV === '1') {
    return [
      // DEV : HMR (React Refresh inline + eval des source maps).
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // DEV : websockets HMR, **uniquement** sur bouclage.
      "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
      ...shared,
    ].join('; ')
  }

  return [
    // PROD : payload RSC/flight inline (voir doc) → 'unsafe-inline' indispensable.
    "script-src 'self' 'unsafe-inline'",
    // PROD : Server Actions = fetch same-origin ; aucun websocket.
    "connect-src 'self'",
    ...shared,
  ].join('; ')
}

/** Garde d'installation unique (un seul listener `onHeadersReceived` par session). */
let cspInstalled = false

/**
 * Installe la réécriture de l'en-tête `Content-Security-Policy` sur la session
 * par défaut (étape 10 — durcissement, §6.4).
 *
 * `session.webRequest.onHeadersReceived` ne conserve qu'**un** listener : un
 * second appel remplacerait le premier, d'où la garde `cspInstalled`. On réécrit
 * l'en-tête côté **main process**, ce qui évite de modifier `next.config.ts`
 * (build web Vercel inchangé) tout en couvrant dev **et** prod.
 *
 * Seules les réponses de **bouclage** (le serveur Next local) sont réécrites :
 * on écrase toute CSP déjà présente (aucune aujourd'hui) pour que la nôtre soit
 * l'autorité unique, sans toucher aux autres origines.
 */
function installContentSecurityPolicy(): void {
  if (cspInstalled) {
    return
  }
  cspInstalled = true
  const policy = buildContentSecurityPolicy()

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isLoopbackUrl(details.url)) {
      // Origine non locale : on laisse les en-têtes intacts.
      callback({})
      return
    }
    const headers: Record<string, string[]> = {}
    for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
      // On écrase toute CSP déjà présente : la nôtre devient l'autorité unique.
      if (key.toLowerCase() === 'content-security-policy') {
        continue
      }
      headers[key] = value
    }
    headers['Content-Security-Policy'] = [policy]
    callback({ responseHeaders: headers })
  })

  log.info(
    `[window] CSP ${process.env.ELECTRON_DEV === '1' ? 'dev (permissive, bornée au bouclage)' : 'prod (stricte)'} installée`,
  )
}

/**
 * Fabrique la fenêtre principale de l'application.
 *
 * Durcissement appliqué (§1.3) :
 * - `contextIsolation`, `sandbox`, `webSecurity` activés, `nodeIntegration` désactivé ;
 * - toute création de fenêtre (`window.open`, `target="_blank"`) est refusée ;
 * - la navigation est limitée à l'origine de l'application Next.js ;
 * - **CSP** posée via `session.webRequest.onHeadersReceived` (voir
 *   {@link buildContentSecurityPolicy}) — dev permissive/locales, prod stricte.
 */
export function createMainWindow(): BrowserWindow {
  // CSP installée **avant** le premier `loadURL` (main.ts) pour couvrir le
  // document initial comme les navigations suivantes.
  installContentSecurityPolicy()

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
