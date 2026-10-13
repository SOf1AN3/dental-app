import { app } from 'electron'
import log from 'electron-log'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'

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
const DEFAULT_PORT = 3000

const PROBE_INTERVAL_MS = 250
const PROBE_TIMEOUT_MS = 2_000
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

/** Port : `process.env.PORT ? Number(...) : 3000` (avec garde-fou sur la valeur). */
function resolvePort(): number {
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
const SECRET_ASSIGNMENT_PATTERN =
  /\b(DATABASE_URL|AUTH_SECRET|AUTH_SECRET_KEY|POSTGRES_PASSWORD|PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi

/** Jamais de secret dans les logs (ni en clair dans les messages d'erreur). */
function redactSecrets(raw: string): string {
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
/* Résolution des chemins                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Racine du projet en développement (le seul cas où on lance `npx next dev`).
 *
 * `app.getAppPath()` dépend de la façon dont Electron est lancé (dossier ou
 * fichier) : on remonte d'abord depuis le bundle compilé
 * (`<racine>/dist-electron/main/main.js` → deux niveaux au-dessus), puis on
 * valide la présence d'un `package.json`.
 */
function resolveDevProjectRoot(): string {
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
 * `resolvePort()` (`-p` reçoit forcément un entier 1-65535) : aucune injection
 * n'est possible. Les lancements sans `shell` (standalone) gardent le tableau d'args.
 */
function spawnChild(spec: LaunchSpec): ChildProcess {
  const options = { cwd: spec.cwd, env: spec.env, windowsHide: true } as const
  if (spec.shell) {
    return spawn(`${spec.command} ${spec.args.join(' ')}`, { ...options, shell: true })
  }
  return spawn(spec.command, [...spec.args], { ...options, shell: false })
}

/**
 * Point d'entrée : démarre (ou réutilise) le serveur Next.js.
 * Rejette si le processus enfant sort avant d'être prêt, ou en cas de timeout.
 */
export async function startNextServer(): Promise<NextServerHandle> {
  const port = resolvePort()
  // `localhost` (et non `127.0.0.1`) : c'est l'origine de `START_URL` dans
  // `window.ts`, que cette étape ne doit pas modifier. L'écoute, elle, reste
  // strictement bouclage via `HOSTNAME`/`-H`.
  const url = `http://localhost:${port}`

  if (await probe(url)) {
    log.info(`[next] serveur déjà actif sur ${url} : réutilisation (aucun processus lancé)`)
    return createHandle(null, url, port, false)
  }

  const spec = process.env.ELECTRON_DEV === '1' ? devLaunchSpec(port) : standaloneLaunchSpec(port)
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
    await waitUntilReady(state, url, port, spec.readyTimeoutMs)
    state.ready = true
  } catch (error) {
    if (!state.exited) {
      // Timeout : on ne laisse jamais un serveur orphelin derrière nous.
      await killChild(state)
    }
    throw error
  }

  log.info(`[next] serveur ${spec.label} prêt sur ${url} (pid ${child.pid ?? 'n/a'})`)
  return createHandle(state, url, port, true)
}

/** Arrêt public : idempotent et tolérant à `null` (aucun rejet). */
export async function stopNextServer(handle: NextServerHandle | null | undefined): Promise<void> {
  if (handle === null || handle === undefined) {
    return
  }
  await handle.stop()
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
