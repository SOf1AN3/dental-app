import { app } from 'electron'
import log from 'electron-log'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
// Source de vérité unique de l'origine : `window.ts` ne fait qu'exporter une
// constante (aucun effet de bord au chargement — voir `resolveServerUrl`).
import { DEFAULT_NEXT_PORT, START_URL } from '../window'

/**
 * Cycle de vie du serveur Next.js embarqué (PLAN-ELECTRON §1.4 — tâche 1.4).
 *
 * Deux modes de lancement :
 *  - **dev** (`ELECTRON_DEV=1`) : `npx next dev -p <port> -H 127.0.0.1` dans la
 *    racine du projet (`npx.cmd` + `shell` sous Windows, seule forme fiable) ;
 *  - **production** : `node <...>/.next/standalone/server.js` avec
 *    `PORT` + `HOSTNAME=127.0.0.1` (+ `ELECTRON_RUN_AS_NODE=1` après packaging,
 *    Electron servant de runtime Node puisqu'aucun `node` externe n'existe sur
 *    le poste du cabinet).
 *
 * Comportements non négociables :
 *  - **réutilisation** : si un serveur répond déjà sur le port (ex. `npm run dev`
 *    lancé dans un autre terminal), il est réutilisé (`owned: false`) et `stop()`
 *    ne tue jamais un processus qui n'est pas le nôtre ;
 *  - **journalisation** : `electron-log` uniquement (jamais `console.log`), et
 *    jamais d'env ni de secret (`DATABASE_URL`, `AUTH_SECRET`, …) — les lignes
 *    reprises du processus enfant passent par `redactSecrets()` avant écriture ;
 *  - **arrêt** : `stop()` est idempotent et tue l'**arbre** de processus
 *    (`taskkill /pid <pid> /T /F`) car sous Windows `child.kill()` ne tue que le
 *    `cmd.exe` intermédiaire et orphelinerait `next dev` ;
 *  - **robustesse** : un enfant qui sort avant d'être prêt fait rejeter
 *    `startNextServer()` avec son code de sortie + les dernières lignes de log.
 *
 * Packaging (étape 9, non implémentée ici) : le build standalone sera copié soit
 * via `extraResources` → `<resources>/standalone/server.js`, soit via
 * `asarUnpack` → `<resources>/app.asar.unpacked/.next/standalone/server.js`.
 * Ces deux dispositions sont déjà recherchées par `resolveStandaloneServer()`
 * (`app.getAppPath()` pointe vers `app.asar`, sur lequel on ne peut pas `spawn`).
 */

/** URL de bouclage utilisée par le renderer — doit rester cohérente avec `START_URL`. */
const LOOPBACK_HOSTNAME = '127.0.0.1'
const DEFAULT_PORT = DEFAULT_NEXT_PORT

const PROBE_INTERVAL_MS = 250
/** Timeout du probe de **readiness** interne (`waitUntilReady`) : inchangé. */
const PROBE_TIMEOUT_MS = 2_000
/**
 * Timeout du probe de **réutilisation** au démarrage : un `next dev` à froid
 * dépasse largement 2 s — un délai trop court classerait un serveur sain en
 * « non réactif » (ou, pire, en « libre » si l'erreur était mal classée).
 */
const REUSE_PROBE_TIMEOUT_MS = 8_000
const DEV_READY_TIMEOUT_MS = 90_000
const STANDALONE_READY_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 5_000
const EXIT_FLUSH_DELAY_MS = 100
const MAX_CAPTURED_LINES = 60
const MAX_CAPTURED_LINE_LENGTH = 2_000

/** Handle public : URL à charger + arrêt idempotent du serveur. */
export interface NextServerHandle {
  /** Origine à charger dans la fenêtre (ex. `http://localhost:3000`). */
  readonly url: string
  readonly port: number
  /** `false` = serveur préexistant réutilisé : `stop()` est sans effet. */
  readonly owned: boolean
  /** Arrêt idempotent (jamais rejeté : les erreurs sont journalisées). */
  stop(): Promise<void>
}

interface ChildState {
  readonly child: ChildProcess
  readonly label: string
  /** Dernières lignes (déjà redactées) du processus enfant. */
  readonly lines: string[]
  exited: boolean
  ready: boolean
  exitCode: number | null
  exitSignal: NodeJS.Signals | null
}

interface LaunchSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly shell: boolean
  readonly readyTimeoutMs: number
  readonly label: string
}

type LogLevel = 'info' | 'warn'

/** État courant du processus que nous avons nous-mêmes lancé (`null` si réutilisation). */
let ownedChild: ChildState | null = null

/* -------------------------------------------------------------------------- */
/* Utilitaires                                                                */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Port du serveur Next.js — **source unique** partagée avec `electron/env.ts`
 * (`buildNextEnv`) : `AUTH_URL`/`PORT` de l'enfant doivent concorder avec le port
 * réellement lancé ici, sinon l'origine servie et l'origine déclarée à NextAuth
 * divergent (cookies `__Secure-` rejetés, redirects refusés).
 */
export function resolveNextPort(): number {
  const raw = process.env.PORT
  if (raw === undefined || raw === '') {
    return DEFAULT_PORT
  }
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) {
    return parsed
  }
  log.warn(`[next] variable PORT invalide : repli sur ${DEFAULT_PORT}`)
  return DEFAULT_PORT
}

const CREDENTIALS_IN_URL_PATTERN = /(\w+:\/\/[^/\s:@]+):([^@\s/]+)@/g
// `["']?\s*[=:]\s*` : accepte `KEY=value`, `KEY: value` **et** les clés JSON
// quotées (`"AUTH_SECRET": "valeur"`, `'TOKEN':'valeur'`) — sans quoi la valeur
// partait en clair dans les logs à chaque ligne d'erreur de configuration.
// La chaîne doublement quoteée gère les échappements (`"pa\"ss"`) via une
// classe sans répétition imbriquée ambiguë → comportement linéaire (pas de ReDoS) :
// `[^"\\]*` ne peut jamais revenir en arrière sur un `\` consommé par `\\.`.
const SECRET_ASSIGNMENT_PATTERN =
  /\b(DATABASE_URL|AUTH_SECRET|AUTH_SECRET_KEY|POSTGRES_PASSWORD|PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)\b(["']?\s*[=:]\s*)("[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\S+)/gi

/** Jamais de secret dans les logs (ni en clair dans les messages d'erreur). */
export function redactSecrets(raw: string): string {
  return raw.replace(CREDENTIALS_IN_URL_PATTERN, '$1:***@').replace(SECRET_ASSIGNMENT_PATTERN, '$1$2***')
}

/** Mémorise + journalise une ligne du processus enfant (redactée, tronquée). */
function recordLine(state: ChildState, raw: string, level: LogLevel): void {
  const line = redactSecrets(raw).replace(/\s+$/, '').slice(0, MAX_CAPTURED_LINE_LENGTH)
  if (line.length === 0) {
    return
  }
  state.lines.push(line)
  if (state.lines.length > MAX_CAPTURED_LINES) {
    state.lines.splice(0, state.lines.length - MAX_CAPTURED_LINES)
  }
  const formatted = `[next:${state.label}] ${line}`
  if (level === 'warn') {
    log.warn(formatted)
  } else {
    log.info(formatted)
  }
}

/** Redirige un pipe du processus enfant vers `electron-log` (jamais `console.*`). */
function forwardStream(state: ChildState, stream: Readable, level: LogLevel): void {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    pending += chunk
    const parts = pending.split(/\r?\n/)
    pending = parts.pop() ?? ''
    for (const part of parts) {
      recordLine(state, part, level)
    }
    if (pending.length > MAX_CAPTURED_LINE_LENGTH * 4) {
      recordLine(state, pending, level)
      pending = ''
    }
  })
  stream.on('error', (error: Error) => {
    log.warn(`[next:${state.label}] flux du processus enfant en erreur : ${error.message}`)
  })
}

/** Une réponse HTTP (quelle qu'elle soit) prouve que le port est servi. */
async function probe(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, PROBE_TIMEOUT_MS)
  try {
    await fetch(url, { method: 'HEAD', signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Détection de réutilisation (Next.js uniquement)                            */
/* -------------------------------------------------------------------------- */

/** Verdict du probe de réutilisation du port au démarrage. */
type ReuseProbeResult =
  /** Personne ne répond (refus de connexion prouvé) : on peut lancer. */
  | 'free'
  /** Un serveur **Next.js** répond : réutilisation sûre. */
  | 'nextjs'
  /** Un service **inconnu** (pas Next.js) occupe le port : refus de le charger. */
  | 'foreign'
  /** Le port **accepte** les connexions mais n'a pas parlé HTTP dans le délai. */
  | 'unresponsive'

/**
 * Verdict enrichi d'une cause honnête : le verdict seul (`foreign`) ne dit pas
 * **pourquoi** le port est refusé, et le message de rejet doit distinguer
 * (a) une redirection sortante (IdP externe) d'(b) une réponse sans marqueur
 * Next.js et d'(c) un service non réactif — ne pas amalgamer en « service inconnu ».
 */
interface ReuseProbeOutcome {
  readonly verdict: ReuseProbeResult
  /** Description factuelle de la cause (vide pour `free` / `nextjs`). */
  readonly detail: string
}

const PROBE_MAX_BODY_BYTES = 8_192
const PROBE_REDIRECT_HOPS_MAX = 3
const NEXTJS_HEADER_PREFIX = 'x-nextjs-'
/** Marqueurs stables d'une page Next.js (App Router inclut `/_next/static/…`). */
const NEXTJS_BODY_MARKERS = ['__NEXT_DATA__', '/_next/'] as const

/** Marqueurs Next.js : en-tête `x-nextjs-*` ou marqueur dans le corps (échantillon). */
function hasNextJsMarker(response: Response, bodySample: string): boolean {
  for (const name of response.headers.keys()) {
    if (name.toLowerCase().startsWith(NEXTJS_HEADER_PREFIX)) {
      return true
    }
  }
  return NEXTJS_BODY_MARKERS.some((marker) => bodySample.includes(marker))
}

/** Suit une redirection **même origine** uniquement ; sinon refus (`null`). */
function sameOriginRedirect(location: string, base: URL): string | null {
  try {
    const target = new URL(location, base)
    return target.origin === base.origin ? target.href : null
  } catch {
    return null
  }
}

/** Échantillon de corps plafonné (un service étranger peut servir un flux illimité). */
async function readBodySample(response: Response): Promise<string> {
  const body = response.body
  if (body === null) {
    return ''
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let sample = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value !== undefined) {
        sample += decoder.decode(value, { stream: true })
        if (sample.length >= PROBE_MAX_BODY_BYTES) {
          break
        }
      }
    }
  } catch (error) {
    // Un **abort** (timer du probe déclenché pendant la lecture du corps) n'est
    // pas un corps tronqué : le re-jeter laisse le `catch` de `probeReuse()`
    // classer `unresponsive` (« non réactif ») au lieu d'un diagnostic faux
    // « aucun marqueur Next.js ».
    const name = error instanceof Error ? error.name : ''
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw error
    }
    // Corps tronqué ou invalide : l'échantillon déjà lu reste exploitable.
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return sample
}

/**
 * Détecte si on peut réutiliser ce qui répond sur `url`.
 *
 * Seul un serveur **Next.js** (en-tête `x-nextjs-*` ou marqueur `/_next/`,
 * `__NEXT_DATA__` dans le corps) est réutilisé : charger un service étranger
 * (autre app Node, serveur de fichiers, …) exposerait un contenu inconnu.
 * Les redirections internes (ex. redirect login du middleware) sont suivies,
 * les redirections sortantes classent le port en « inconnu ».
 *
 * **Classification du `catch` (fail-safe, aucun défaut « libre »)** :
 * | Cause                                   | Verdict        |
 * |-----------------------------------------|----------------|
 * | `AbortError` / `TimeoutError` (timeout) | `unresponsive` |
 * | `ECONNREFUSED` / `ENOTFOUND` (cause)    | `free`         |
 * | Tout le reste (ECONNRESET, protocole…)  | `foreign`      |
 *
 * Seul un **refus de connexion** prouve un port libre. Un timeout ou une erreur
 * de protocole ne prouve rien : un service étranger lié sur `[::1]:3000` alors
 * que notre enfant se lie sur `127.0.0.1:3000` démarre **sans EADDRINUSE**, et
 * `http://localhost:3000` résout vers `::1` dans Chromium → contenu étranger
 * chargé à l'origine exacte de l'app.
 */
async function probeReuse(url: string): Promise<ReuseProbeOutcome> {
  let current = url
  for (let hop = 0; hop <= PROBE_REDIRECT_HOPS_MAX; hop += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, REUSE_PROBE_TIMEOUT_MS)
    const startedAt = Date.now()
    try {
      const response = await fetch(current, { method: 'GET', redirect: 'manual', signal: controller.signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (location === null) {
          return {
            verdict: 'foreign',
            detail: `redirection HTTP ${response.status} sans en-tête Location sur ${redactSecrets(current)}`,
          }
        }
        const next = sameOriginRedirect(location, new URL(current))
        if (next === null) {
          // (a) Redirection **sortante** : un Next redirigeant vers un IdP
          // externe n'est pas « un service inconnu » — le dire honnêtement.
          let target = location
          try {
            target = new URL(location, current).href
          } catch {
            // `location` illisible : on garde la valeur brute dans le message.
          }
          return {
            verdict: 'foreign',
            detail: `redirection sortante détectée vers ${redactSecrets(target)} (hors origine ${new URL(current).origin})`,
          }
        }
        current = next
        continue
      }
      const bodySample = await readBodySample(response)
      if (hasNextJsMarker(response, bodySample)) {
        return { verdict: 'nextjs', detail: '' }
      }
      // (b) Réponse HTTP valide mais sans aucun marqueur Next.js.
      return {
        verdict: 'foreign',
        detail: `aucun marqueur Next.js détecté sur ${redactSecrets(current)} (réponse HTTP ${response.status})`,
      }
    } catch (error) {
      // (c) Classification par cause — **jamais « libre » par défaut**.
      const elapsedMs = Date.now() - startedAt
      const name = error instanceof Error ? error.name : ''
      if (name === 'AbortError' || name === 'TimeoutError') {
        return {
          verdict: 'unresponsive',
          detail: `n'a pas répondu sous ${elapsedMs} ms`,
        }
      }
      const code = (error as { cause?: { code?: string } }).cause?.code
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
        return { verdict: 'free', detail: '' }
      }
      return {
        verdict: 'foreign',
        detail: `protocole illisible (${code ?? (name === '' ? 'erreur inconnue' : name)}) : le service ne parle pas HTTP`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    verdict: 'foreign',
    detail: `plus de ${PROBE_REDIRECT_HOPS_MAX} redirections internes consécutives sans marqueur Next.js`,
  }
}

/**
 * « Un **serveur Next.js** répond-il encore sur cette origine ? » — verdict
 * réutilisé par `main.ts` (tâche 7.1c) pour statuer, **après** un redémarrage
 * échoué et sa relance de secours, si le renderer dispose encore d'une API
 * locale. Réutilise {@link probeReuse} (en-tête `x-nextjs-*` / marqueurs
 * `__NEXT_DATA__`, `/_next/`) : un service étranger qui répondrait sur le port
 * n'est **jamais** compté comme serveur local (→ verdict `down`).
 *
 * Toute erreur interne est absorbée en `false` (échec fermé : un doute vaut
 * « pas de serveur », jamais l'inverse).
 */
export async function isNextServerServing(url: string): Promise<boolean> {
  try {
    return (await probeReuse(url)).verdict === 'nextjs'
  } catch {
    return false
  }
}

/* -------------------------------------------------------------------------- */
/* Résolution des chemins                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Racine du projet en développement (le seul cas où on lance `npx next dev`).
 *
 * `app.getAppPath()` dépend de la façon dont Electron est lancé (dossier ou
 * fichier) : on remonte d'abord depuis le bundle compilé
 * (`<racine>/dist-electron/main/main.js` → deux niveaux au-dessus), puis on
 * valide la présence d'un `package.json`.
 *
 * Exportée : `electron/env.ts` (`buildNextEnv`) s'en sert pour `<racine>/uploads`
 * (`UPLOAD_DIR` dev) — une racine divergente écrirait les pièces jointes ailleurs
 * que le serveur ne les lit.
 */
export function resolveDevProjectRoot(): string {
  const candidates = [path.resolve(__dirname, '..', '..'), app.getAppPath(), process.cwd()]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'package.json'))) {
      return candidate
    }
  }
  return candidates[0]
}

/** Liste des emplacements possibles du `server.js` standalone (voir en-tête). */
function standaloneCandidates(): string[] {
  // Sans packaging : `<racine projet>/.next/standalone/server.js`.
  // Après packaging : `app.getAppPath()` = `app.asar` (non spawnable) → on part
  // de `process.resourcesPath` où le build a été copié à l'étape 9.
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  const candidates = [path.join(root, '.next', 'standalone', 'server.js')]
  if (app.isPackaged) {
    // `extraResources` → `<resources>/standalone/server.js`.
    candidates.unshift(path.join(root, 'standalone', 'server.js'))
    // `asarUnpack` → `<resources>/app.asar.unpacked/.next/standalone/server.js`.
    candidates.push(path.join(root, 'app.asar.unpacked', '.next', 'standalone', 'server.js'))
  }
  return candidates
}

/** Erreur explicite (jamais de crash silencieux) si le build desktop est absent. */
function resolveStandaloneServer(): string {
  const candidates = standaloneCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    [
      "Le serveur Next.js embarqué est introuvable : aucun build `standalone` détecté.",
      `Chemins recherchés :\n- ${candidates.join('\n- ')}`,
      'Lancez `npm run build:desktop` pour générer `.next/standalone/` (étape 9 du plan).',
    ].join('\n'),
  )
}

/* -------------------------------------------------------------------------- */
/* Spécifications de lancement                                                */
/* -------------------------------------------------------------------------- */

function devLaunchSpec(port: number): LaunchSpec {
  return {
    // `npx` sous POSIX, `npx.cmd` sous Windows (où `shell: true` est indispensable).
    command: 'npx',
    args: ['next', 'dev', '-p', String(port), '-H', LOOPBACK_HOSTNAME],
    cwd: resolveDevProjectRoot(),
    env: { ...process.env },
    shell: process.platform === 'win32',
    readyTimeoutMs: DEV_READY_TIMEOUT_MS,
    label: 'next dev',
  }
}

function standaloneLaunchSpec(port: number): LaunchSpec {
  const serverScript = resolveStandaloneServer()
  const packaged = app.isPackaged
  return {
    // Après packaging, Electron fait office de runtime Node (`ELECTRON_RUN_AS_NODE`) :
    // aucun binaire `node` n'est installé sur le poste du cabinet.
    command: packaged ? process.execPath : 'node',
    args: [serverScript],
    cwd: path.dirname(serverScript),
    env: {
      ...process.env,
      PORT: String(port),
      // Impératif : écouter sur le bouclage uniquement, jamais sur 0.0.0.0.
      HOSTNAME: LOOPBACK_HOSTNAME,
      NODE_ENV: 'production',
      ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    shell: false,
    readyTimeoutMs: STANDALONE_READY_TIMEOUT_MS,
    label: 'standalone',
  }
}

/* -------------------------------------------------------------------------- */
/* Arrêt du processus enfant                                                  */
/* -------------------------------------------------------------------------- */

function taskkillTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // `/T` = arbre de processus, `/F` = forcer : indispensable sous Windows pour
    // ne pas orpheliner le `node.exe` derrière le `cmd.exe` de `npx`/`npm`.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) {
        // Le plus souvent « processus introuvable » (= déjà sorti) : bénin.
        log.debug(`[next] taskkill pid ${pid} : ${error.message}`)
      }
      resolve()
    })
  })
}

async function waitForExit(state: ChildState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!state.exited && Date.now() < deadline) {
    await delay(50)
  }
  return state.exited
}

/** Arrête l'arbre du processus (idempotent, jamais de rejet). */
async function killChild(state: ChildState): Promise<void> {
  if (state.exited) {
    return
  }
  const pid = state.child.pid
  if (pid === undefined) {
    state.exited = true
    return
  }
  log.info(`[next] arrêt de ${state.label} (pid ${pid})`)

  if (process.platform === 'win32') {
    await taskkillTree(pid)
    if (!(await waitForExit(state, STOP_TIMEOUT_MS))) {
      log.error(`[next] ${state.label} (pid ${pid}) n'a pas pu être arrêté`)
    }
    return
  }

  state.child.kill('SIGTERM')
  if (await waitForExit(state, STOP_TIMEOUT_MS)) {
    return
  }
  log.warn(`[next] ${state.label} toujours actif après ${STOP_TIMEOUT_MS} ms : SIGKILL`)
  state.child.kill('SIGKILL')
  if (!(await waitForExit(state, STOP_TIMEOUT_MS))) {
    log.error(`[next] ${state.label} (pid ${pid}) n'a pas pu être arrêté`)
  }
}

/**
 * Kill de secours **synchrone** : à n'utiliser que depuis `process.on('exit')`
 * (aucune API asynchrone n'y est autorisée) et le délai de sécurité de `main.ts`.
 */
export function forceKillNextServer(): void {
  const state = ownedChild
  if (state === null || state.exited) {
    return
  }
  const pid = state.child.pid
  if (pid === undefined) {
    return
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      state.child.kill('SIGKILL')
    }
  } catch {
    // Déjà sorti ou inaccessible : rien de plus qu'on puisse faire à cette phase.
  }
  state.exited = true
  log.info(`[next] kill de secours de ${state.label} (pid ${pid})`)
}

function createHandle(state: ChildState | null, url: string, port: number, owned: boolean): NextServerHandle {
  if (!owned || state === null) {
    return {
      url,
      port,
      owned: false,
      stop: () => {
        log.info('[next] serveur préexistant réutilisé : aucun processus à arrêter')
        return Promise.resolve()
      },
    }
  }

  let stopPromise: Promise<void> | null = null
  return {
    url,
    port,
    owned: true,
    stop: (): Promise<void> => {
      // Idempotent : un second appel (ou un appel concurrent) retourne la même promesse.
      stopPromise ??= killChild(state).catch((error: unknown) => {
        log.error('[next] échec de l’arrêt du serveur Next.js', error)
      })
      return stopPromise
    },
  }
}

/**
 * Lancement effectif du processus enfant.
 *
 * Sous Windows, `npx` est un `.cmd` : un `shell` est donc obligatoire — mais Node
 * émet alors **DEP0190** (« args … not escaped, only concatenated ») si on lui
 * passe un tableau d'`args`. On construit donc une ligne de commande unique, dont
 * tous les fragments sont des constantes ou des entiers déjà validés par
 * `resolveNextPort()` (`-p` reçoit forcément un entier 1-65535) : aucune injection
 * n'est possible. Les lancements sans `shell` (standalone) gardent le tableau d'args.
 */
function spawnChild(spec: LaunchSpec): ChildProcess {
  const options = { cwd: spec.cwd, env: spec.env, windowsHide: true } as const
  if (spec.shell) {
    return spawn(`${spec.command} ${spec.args.join(' ')}`, { ...options, shell: true })
  }
  return spawn(spec.command, [...spec.args], { ...options, shell: false })
}

/** Supprime les barres obliques finales (comparaison d'origines insensible au `/` final). */
function normalizeOrigin(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, '')
}

/**
 * **Origine** normalisée d'une URL (`scheme://host[:port]`), seule comparaison
 * pertinente : `window.ts` whitelist **par origine**, un chemin (`/app`) ou un
 * `/` final ne doit donc jamais faire échouer la comparaison.
 * Repli sur `normalizeOrigin()` si l'URL est illisible (aucune exception propagée).
 */
function originOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin
  } catch {
    return normalizeOrigin(rawUrl)
  }
}

/**
 * Port **réellement servi** par une URL de réutilisation (composante `:port`,
 * ou port par défaut du schéma) : le handle d'un serveur réutilisé doit
 * refléter l'URL qui a répondu, pas la variable `PORT` — avec
 * `ELECTRON_START_URL=http://localhost:4000` + `PORT=3000`, afficher 3000 serait
 * un log mensonger. Repli sur `port` si l'URL est illisible (quasi impossible
 * après un probe réussi).
 */
function reusePortOf(url: string, fallback: number): number {
  try {
    return Number(new URL(url).port || DEFAULT_PORT)
  } catch {
    return fallback
  }
}

/**
 * Origine exposée au renderer.
 *
 * **Source de vérité unique** : `START_URL`, exporté par `window.ts`, qui construit
 * déjà sa liste blanche `will-navigate` sur `ELECTRON_START_URL || http://localhost:3000`.
 * On ne redéfinit **jamais** cette expression ici (divergence future impossible).
 * `process.env.ELECTRON_START_URL` n'est consulté que pour sa **présence**, afin
 * de distinguer (a) `PORT ≠ 3000` sans override — erreur de configuration
 * **bloquante** — de (b) une divergence entre deux origines explicites
 * (avertissement seul), sans double source de vérité.
 *
 * Si notre `handle.url` diverge, le premier `loadURL` passerait mais toute
 * navigation suivante (redirect login, middleware) serait bloquée → écran blanc.
 *
 * **Sous-cas « `PORT ≠ 3000` + origines convergentes » impossible** : sans
 * override, `window.ts` whitelist `http://localhost:3000` par défaut et
 * `derivedUrl` est toujours `http://localhost:<port>` — les origines ne peuvent
 * donc converger que si `port = 3000`. Tout `PORT ≠ 3000` sans
 * `ELECTRON_START_URL` est **rejeté** par l'erreur actionnable ci-dessous : il
 * n'existe aucun cas d'avertissement seul dans cette branche.
 */
function resolveServerUrl(derivedUrl: string, port: number): string {
  const startUrl = START_URL
  const hasOverride = process.env.ELECTRON_START_URL !== undefined && process.env.ELECTRON_START_URL !== ''
  if (!hasOverride) {
    const startOrigin = originOf(startUrl)
    const derivedOrigin = originOf(derivedUrl)
    if (port !== DEFAULT_PORT && startOrigin !== derivedOrigin) {
      // Fail-fast **avant** le spawn : sans override, `window.ts` whitelist
      // l'origine par défaut de `START_URL` alors que l'enfant écouterait sur un
      // autre port → toute navigation suivante serait bloquée (écran blanc
      // silencieux). Une erreur de configuration explicite vaut mieux.
      throw new Error(
        `PORT=${port} mais ELECTRON_START_URL n'est pas défini : la navigation serait bloquée ` +
          `(window.ts whitelist ${startOrigin}, le serveur écouterait ${derivedOrigin}). ` +
          `Définissez ELECTRON_START_URL=${derivedUrl} ou laissez PORT=${DEFAULT_PORT}.`,
      )
    }
    return derivedUrl
  }
  if (originOf(startUrl) !== originOf(derivedUrl)) {
    log.warn(
      `[next] ELECTRON_START_URL (${redactSecrets(startUrl)}) diverge de l'origine dérivée de PORT (${derivedUrl}) : ` +
        'la première fait foi (cohérence avec window.ts) — alignez PORT et ELECTRON_START_URL.',
    )
  }
  return startUrl
}

/**
 * Divergence `ELECTRON_START_URL` / `PORT` détectée **avant** le `spawn`.
 *
 * Notre enfant écoutera sur `derivedUrl` (où `waitUntilReady` prouve la
 * disponibilité), or `window.ts` whitelist `START_URL` : charger l'une pendant
 * que l'autre est prête laisserait `handle.url` pointer ailleurs que l'endroit
 * réellement servi (URL morte en config périmée). Plutôt que de deviner, on
 * rejette avec une erreur de configuration explicite.
 */
function assertOwnedOriginConsistent(url: string, derivedUrl: string, port: number): void {
  if (originOf(url) === originOf(derivedUrl)) {
    return
  }
  throw new Error(
    `ELECTRON_START_URL (${redactSecrets(url)}) ne correspond pas au port ${port} (origine dérivée ${derivedUrl}) : ` +
      'le serveur que nous lançons écouterait une autre origine que celle whitelistée par window.ts. ' +
      `Utilisez l'origine dérivée http://localhost:${port} (ex. ELECTRON_START_URL=${derivedUrl}) ` +
      `ou laissez PORT=${DEFAULT_PORT}.`,
  )
}

/** Options de `startNextServer()`. */
export interface StartNextServerOptions {
  /**
   * Variables ajoutées à l'environnement du processus enfant **en complément**
   * de `process.env` (jamais en remplacement) : `{ ...spec.env, ...env }`.
   * Fournies par `electron/env.ts` (`buildNextEnv`) : `DATABASE_URL`,
   * `AUTH_SECRET`, `AUTH_URL`, `HOSTNAME`, `PORT`, `NODE_ENV`, `UPLOAD_DIR`.
   * Ignorée si le serveur est **réutilisé** (aucun enfant à équiper) — un
   * avertissement en est alors journalisé, ou un rejet si
   * `requireEnvInjection` est `true` (voir ci-dessous).
   */
  readonly env?: NodeJS.ProcessEnv
  /**
   * `true` = l'injection d'`env` est **obligatoire** (mode production) : un
   * serveur réutilisé conserverait son propre `DATABASE_URL`/`AUTH_SECRET`, et
   * l'application parlerait alors à une base **autre que le cluster embarqué**.
   * Dans ce cas, `startNextServer()` **rejette** (fail-fast) au lieu de
   * réutiliser en silence. Dev (`false`/omis, comportement conservé) : la
   * réutilisation reste permise avec un simple avertissement — un `next dev`
   * réutilisé lit le même `.env` que nous.
   */
  readonly requireEnvInjection?: boolean
}

/**
 * Point d'entrée : démarre (ou réutilise) le serveur Next.js.
 * Rejette si le processus enfant sort avant d'être prêt, ou en cas de timeout.
 */
export async function startNextServer(options: StartNextServerOptions = {}): Promise<NextServerHandle> {
  const port = resolveNextPort()
  // `localhost` (et non `127.0.0.1`) : c'est l'origine de `START_URL` dans
  // `window.ts`, que cette étape ne doit pas modifier. L'écoute, elle, reste
  // strictement bouclage via `HOSTNAME`/`-H`.
  const derivedUrl = `http://localhost:${port}`
  const url = resolveServerUrl(derivedUrl, port)

  const reuse = await probeReuse(url)
  if (reuse.verdict === 'nextjs') {
    if (options.requireEnvInjection === true) {
      // Fail-fast prod (étape 2.2b, revue C3) : un serveur réutilisé garde son
      // propre `DATABASE_URL`/`AUTH_SECRET` — l'application parlerait à une base
      // autre que le cluster embarqué, sans le moindre signe visible. Mieux
      // vaut refuser le démarrage que de servir une mauvaise base.
      throw new Error(
        `Le serveur Next.js déjà actif sur le port ${port} serait réutilisé alors que l'injection d'environnement ` +
          'est obligatoire (mode production) : il conserverait son propre DATABASE_URL/AUTH_SECRET et ' +
          "l'application parlerait à une base autre que le cluster embarqué. Arrêtez ce serveur (ou changez " +
          'PORT/ELECTRON_START_URL) avant de relancer l’application.',
      )
    }
    if (options.env !== undefined) {
      // Aucun enfant lancé : l'env injecté n'a aucun effet (le serveur réutilisé
      // garde sa propre configuration) — un avertissement (et non plus une simple
      // information) plutôt que de laisser croire que `DATABASE_URL`/`AUTH_SECRET`
      // ont été appliqués.
      log.warn('[next] serveur réutilisé : env injecté ignoré (aucun processus enfant lancé)')
    }
    log.info(`[next] serveur Next.js déjà actif sur ${redactSecrets(url)} : réutilisation (aucun processus lancé)`)
    // Réutilisé : l'URL probeée est celle qui a répondu — c'est elle qui devient
    // le handle, **port réel compris** (`reusePortOf`) : le port du handle doit
    // refléter l'URL servie, jamais la variable `PORT`.
    return createHandle(null, url, reusePortOf(url, port), false)
  }
  if (reuse.verdict === 'unresponsive') {
    // Fail-safe : le port accepte les connexions mais n'a jamais parlé HTTP.
    throw new Error(
      `Le port ${port} accepte les connexions mais ${redactSecrets(reuse.detail)} : service non identifié, chargement refusé. ` +
        'Arrêtez ce service ou changez la variable PORT/ELECTRON_START_URL.',
    )
  }
  if (reuse.verdict === 'foreign') {
    // Rejet propre : jamais de `loadURL` sur un service qui n'est pas Next.js.
    // `reuse.detail` distingue honnêtement la cause (redirection sortante,
    // marqueur Next absent, protocole illisible, boucle de redirection).
    throw new Error(
      `Le port ${port} est occupé par un service inconnu (${redactSecrets(reuse.detail)}). ` +
        'Arrêtez ce service ou changez la variable PORT/ELECTRON_START_URL.',
    )
  }

  return launchOwnedServer({ port, derivedUrl, url, env: options.env })
}

/* -------------------------------------------------------------------------- */
/* Lancement d'un enfant possédé (démarrage ET redémarrage, tâche 7.1)        */
/* -------------------------------------------------------------------------- */

/** Paramètres du spawn d'un enfant **possédé** — communs à start et restart. */
interface LaunchOwnedParams {
  readonly port: number
  readonly derivedUrl: string
  readonly url: string
  /** Env complet de l'enfant (`buildNextEnv`) — jamais de remplacement silencieux. */
  readonly env: NodeJS.ProcessEnv | undefined
}

/**
 * Spawn + attente de disponibilité d'un enfant **que nous possédons**.
 *
 * Extrait de `startNextServer()` (étape 7.1) afin que `restartNextServer()`
 * réutilise **exactement** la même logique : validation d'origine, fusion
 * d'env, journal des clés injectées (noms seuls), redirection des pipes par
 * `redactSecrets()`, `waitUntilReady()` puis handle `owned: true`.
 */
async function launchOwnedServer(params: LaunchOwnedParams): Promise<NextServerHandle> {
  const { port, derivedUrl, url } = params

  // Avant tout spawn : l'enfant écoutera sur `derivedUrl` (URL réellement prête).
  // Toute divergence avec `START_URL` (whitelist de window.ts) est une erreur de
  // configuration explicite — jamais une URL morte dans `handle.url`.
  assertOwnedOriginConsistent(url, derivedUrl, port)

  const baseSpec = process.env.ELECTRON_DEV === '1' ? devLaunchSpec(port) : standaloneLaunchSpec(port)
  // Fusion **en complément** de `baseSpec.env` (qui contient déjà `process.env`,
  // plus `PORT`/`HOSTNAME`/`NODE_ENV` en prod) : les clés injectées l'emportent,
  // le reste de l'environnement parent est conservé tel quel.
  const spec: LaunchSpec =
    params.env === undefined ? baseSpec : { ...baseSpec, env: { ...baseSpec.env, ...params.env } }
  const injected = params.env
  if (injected !== undefined) {
    // Noms de clés **seulement**, et **delta uniquement** (étape 2.2b, revue
    // C1) : `buildNextEnv()` reconstruit l'env sur tout l'héritage de
    // `process.env` (~60 clés) — les lister ici serait un doublon inutile avec
    // `warnInheritedSecrets()` (`env.ts`). Ne restent que les clés **réellement
    // modifiées ou ajoutées** par rapport à l'environnement de base du spec.
    const deltaKeys = Object.keys(injected).filter((key) => baseSpec.env[key] !== injected[key])
    log.info(
      `[next] ${deltaKeys.length} variable(s) réellement injectée(s) dans l'enfant (par rapport à ` +
        `l'environnement de base) : ${deltaKeys.length === 0 ? '(aucune)' : deltaKeys.join(', ')} ` +
        '(valeurs jamais journalisées)',
    )
  }
  log.info(`[next] lancement de ${spec.label} : ${spec.command} ${spec.args.join(' ')} (port ${port})`)

  const child = spawnChild(spec)

  const state: ChildState = {
    child,
    label: spec.label,
    lines: [],
    exited: false,
    ready: false,
    exitCode: null,
    exitSignal: null,
  }
  ownedChild = state

  if (child.stdout !== null) {
    forwardStream(state, child.stdout, 'info')
  }
  if (child.stderr !== null) {
    forwardStream(state, child.stderr, 'warn')
  }

  child.on('error', (error: Error) => {
    state.exited = true
    recordLine(state, `échec de lancement du processus : ${error.message}`, 'warn')
  })

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    state.exited = true
    state.exitCode = code
    state.exitSignal = signal
    const status = `code=${code === null ? 'n/a' : code}, signal=${signal === null ? 'n/a' : signal}`
    if (state.ready) {
      log.warn(`[next] ${spec.label} s'est arrêté (${status})`)
    } else {
      log.warn(`[next] ${spec.label} s'est arrêté avant d'être prêt (${status})`)
    }
  })

  try {
    // Le probe cible l'URL dérivée (l'adresse où l'enfant écoute réellement) :
    // `ELECTRON_START_URL` peut désigner une autre origine en cas de config
    // hétérogène — voir l'avertissement de `resolveServerUrl`.
    await waitUntilReady(state, derivedUrl, port, spec.readyTimeoutMs)
    state.ready = true
  } catch (error) {
    if (!state.exited) {
      // Timeout : on ne laisse jamais un serveur orphelin derrière nous.
      await killChild(state)
    }
    throw error
  }

  log.info(`[next] serveur ${spec.label} prêt sur ${derivedUrl} (pid ${child.pid ?? 'n/a'})`)
  // Possédé : `handle.url` = URL **dérivée**, celle que `waitUntilReady` vient de
  // prouver disponible (l'enfant écoute sur `derivedUrl`, pas sur `url` arbitraire).
  return createHandle(state, derivedUrl, port, true)
}

/** Arrêt public : idempotent et tolérant à `null` (aucun rejet). */
export async function stopNextServer(handle: NextServerHandle | null | undefined): Promise<void> {
  if (handle === null || handle === undefined) {
    return
  }
  await handle.stop()
}

/* -------------------------------------------------------------------------- */
/* Redémarrage avec un nouvel env (tâche 7.1 — reconnexion au central)         */
/* -------------------------------------------------------------------------- */

/** Délai d'attente de libération du port **après** l'arrêt de l'ancien enfant. */
const PORT_RELEASE_TIMEOUT_MS = 5_000

export interface RestartNextServerOptions {
  /**
   * Env **complet** du nouvel enfant — reconstruit par `main.ts` via
   * `buildNextEnv()` après persistance du jeton (`SYNC_TOKEN` à jour).
   */
  readonly env: NodeJS.ProcessEnv
  /**
   * Handle courant retourné par `startNextServer()` — permet de distinguer un
   * enfant **possédé** (à arrêter puis relancer) d'un serveur **réutilisé**
   * (à ne jamais toucher). `null` inconnu → repli sur `ownedChild`.
   */
  readonly previous?: NextServerHandle | null
}

export interface RestartNextServerResult {
  /** Handle **actuel** (nouveau si redémarré, inchangé si réutilisé). */
  readonly handle: NextServerHandle
  /**
   * `false` = rien n'a été redémarré (serveur préexistant réutilisé) : l'env
   * — dont `SYNC_TOKEN` — **n'a PAS été appliqué**, l'enfant conserve sa
   * configuration initiale. Avertissement journalisé, jamais de kill.
   */
  readonly restarted: boolean
}

/** Redémarrage en cours (garde d'idempotence : jamais deux spawns concurrents). */
let restartInFlight: Promise<RestartNextServerResult> | null = null

/**
 * Redémarre l'enfant Next avec un **nouvel env** (tâche 7.1).
 *
 * Contrats :
 *  - **jamais de kill d'un serveur réutilisé** (`owned: false`) : rien n'est
 *    arrêté, `{ handle: previous, restarted: false }` est renvoyé et le fait
 *    que l'env n'ait **pas** pu être appliqué est journalisé (`log.warn`) ;
 *  - **`stop()` du vieux handle AVANT le nouveau spawn** (le port doit être
 *    libéré — `waitPortReleased()` borne l'attente à 5 s) ;
 *  - **idempotent** : appel concurrent → même promesse en vol ; appel séquentiel
 *    → arrêt du handle courant puis relance propre (aucun enfant orphelin) ;
 *  - **échecs** : rejet explicite (aucun démarrage silencieux d'un second
 *    enfant). **Garantie côté appelant (tâche 7.1c)** : ce rejet ne conclut
 *    **jamais** par un succès. `main.ts` (a) borne son attente à 30 s
 *    (`restart-timeout`), (b) tente **une** relance de secours
 *    (`startNextServer({ env })`) après chaque rejet, puis (c) vérifie via
 *    {@link isNextServerServing} qu'un serveur répond **réellement** : sans
 *    serveur, le renderer reçoit `ok: false` / `local-server-down`
 *    (« serveur local non redémarré — redémarrez l'application ») — jamais
 *    `ok: true`, jamais un handle mort laissé pour seul état.
 *
 * @throws si aucun enfant possédé n'existe (rien à redémarrer) ou si le
 *         nouveau spawn échoue (timeout / EADDRINUSE — message d'actionnable).
 */
export function restartNextServer(
  options: RestartNextServerOptions,
): Promise<RestartNextServerResult> {
  if (restartInFlight !== null) {
    log.info('[next] redémarrage déjà en cours : promesse en vol réutilisée (aucun double spawn)')
    return restartInFlight
  }
  const run = restartNextServerUnsafe(options).finally(() => {
    restartInFlight = null
  })
  restartInFlight = run
  return run
}

async function restartNextServerUnsafe(
  options: RestartNextServerOptions,
): Promise<RestartNextServerResult> {
  const previous = options.previous ?? null
  const owned = previous !== null ? previous.owned : ownedChild !== null

  // (1) Serveur réutilisé : **rien** à notre charge — on ne tue jamais le
  //     `next dev` d'un autre terminal, mais on ne prétend pas non plus avoir
  //     appliqué l'env.
  if (!owned) {
    log.warn(
      '[next] redémarrage impossible : serveur préexistant réutilisé (owned: false) — le nouvel env ' +
        '(SYNC_TOKEN) n’a PAS été appliqué, l’enfant conserve sa configuration initiale. ' +
        'Redémarrez ce serveur manuellement pour lui transmettre le jeton.',
    )
    if (previous !== null) {
      return { handle: previous, restarted: false }
    }
    throw new Error(
      'restartNextServer : aucun serveur Next possédé à redémarrer (aucun enfant lancé par l’application).',
    )
  }

  const port = resolveNextPort()
  const derivedUrl = `http://localhost:${port}`
  const url = resolveServerUrl(derivedUrl, port)

  // (2) Arrêt de l'ancien enfant AVANT tout nouveau spawn (`stop()` idempotent
  //     du handle ; repli sur `ownedChild` si le handle est inconnu).
  log.info('[next] redémarrage demandé : arrêt de l’enfant courant avant relance')
  if (previous !== null && previous.owned) {
    await previous.stop()
  } else if (ownedChild !== null) {
    await killChild(ownedChild)
  }
  await waitPortReleased(url)

  // (3) Nouveau spawn avec le nouvel env — logique strictement identique au
  //     démarrage (validation d'origine, delta de clés journalisé, readiness).
  const handle = await launchOwnedServer({ port, derivedUrl, url, env: options.env })
  log.info(`[next] serveur redémarré sur ${redactSecrets(handle.url)} (env appliqué, port ${handle.port})`)
  return { handle, restarted: true }
}

/**
 * Attend que le port se libère après l'arrêt de notre enfant (borné à
 * `PORT_RELEASE_TIMEOUT_MS`) : un spawn immédiat sur un socket encore ouvert
 * échouerait en `EADDRINUSE`. Un serveur **toujours actif** après le délai est
 * simplement signalé — `waitUntilReady()` remontera un `EADDRINUSE` explicite
 * si le nouveau spawn échoue, jamais un démarrage silencieux à côté.
 */
async function waitPortReleased(url: string): Promise<void> {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS
  for (;;) {
    if (!(await probe(url))) {
      return
    }
    if (Date.now() >= deadline) {
      log.warn(
        `[next] port toujours actif après ${PORT_RELEASE_TIMEOUT_MS} ms (${redactSecrets(url)}) : ` +
          'poursuite du redémarrage (EADDRINUSE explicite en cas de conflit)',
      )
      return
    }
    await delay(PROBE_INTERVAL_MS)
  }
}

/* -------------------------------------------------------------------------- */
/* Attente de disponibilité                                                   */
/* -------------------------------------------------------------------------- */

function describeExit(state: ChildState, port: number): string {
  const code = state.exitCode === null ? 'inconnu' : String(state.exitCode)
  const signal = state.exitSignal === null ? '' : `, signal ${state.exitSignal}`
  let message = `Le serveur Next.js (${state.label}) s'est arrêté prématurément (code ${code}${signal}).`
  if (state.lines.some((line) => /EADDRINUSE/i.test(line))) {
    message += ` Le port ${port} est déjà occupé par un autre processus.`
  }
  if (state.lines.length > 0) {
    message += `\nDernières lignes du serveur :\n${state.lines.slice(-20).join('\n')}`
  }
  return message
}

function describeTimeout(state: ChildState, url: string, timeoutMs: number): string {
  let message = `Le serveur Next.js (${state.label}) n'est pas prêt après ${timeoutMs} ms : ${url}`
  if (state.lines.length > 0) {
    message += `\nDernières lignes du serveur :\n${state.lines.slice(-20).join('\n')}`
  }
  return message
}

async function waitUntilReady(state: ChildState, url: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  log.info(`[next] attente du serveur ${state.label} sur ${url} (délai max ${timeoutMs} ms)`)

  for (;;) {
    if (state.exited) {
      // Laisse la fin des pipes se déposer avant de rapporter l'erreur.
      await delay(EXIT_FLUSH_DELAY_MS)
      throw new Error(describeExit(state, port))
    }
    if (await probe(url)) {
      return
    }
    if (state.exited) {
      await delay(EXIT_FLUSH_DELAY_MS)
      throw new Error(describeExit(state, port))
    }
    if (Date.now() >= deadline) {
      throw new Error(describeTimeout(state, url, timeoutMs))
    }
    await delay(PROBE_INTERVAL_MS)
  }
}
