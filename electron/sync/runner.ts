/**
 * Tâche 5.5 — CÂBLAGE Electron du cœur de synchronisation (`runner-core.ts`).
 *
 * Ce module est la **seule** frontière entre le cœur PUR (`src/lib/sync/*`) et
 * les ressources réelles du processus **main** :
 *
 *  - probe réseau      → `createCentralProbe()` (`net.ts`, délégué à
 *                        `isCentralReachable` — garde-fou SSRF fail-closed) ;
 *  - ordonnanceur     → `SyncScheduler` + `createBackoff()` (exponentiel ±20 %) ;
 *  - outbox/curseur   → repo **Drizzle** sur `getDesktopDb()` (jamais `db.ts`,
 *                        qui plante au top-level hors Next), helpers testés de
 *                        `outbox.ts` pré-liés via `bindOutbox` ;
 *  - application      → `applyPulledChanges(createLocalApplyRepo(db), …)` ;
 *  - conflits (D-4)   → `recordPushConflicts(createConflictsDbRepo(db), …)` :
 *                        les `conflicts[]` du push sont journalisés dans
 *                        `sync_conflict` (base locale) pour la revue humaine ;
 *                        repo construit **seulement** si `db` existe (base
 *                        absente → runner inactif, dep non câblée) ;
 *  - jeton            → `readSyncToken` / `writeSyncToken` / `clearSyncToken`
 *                        (`config.json` chiffré `safeStorage`) ;
 *  - journal          → `electron-log` **uniquement**, messages passés par
 *                        `redactSecrets` (aucun jeton, aucune URL avec
 *                        identifiants, jamais `DATABASE_URL`).
 *
 * ## Cycle de vie
 *
 *  - `startSyncRunner(options?)` construit les deps et planifie une **boucle**
 *    (`setTimeout` périodique) qui n'entre en cycle que si `shouldRun()` est
 *    vrai (le backoff reste porté par l'ordonnanceur). Premier tick différé de
 *    3 s pour laisser le démarrage de l'app se terminer ;
 *  - `stop()` est **idempotent** : plus de timer, plus de runner courant,
 *    aucun timer orphelin (chaque tick se replanifie dans un `finally` sous
 *    garde `stopped`) ;
 *  - `triggerNow()` déclenche un cycle à la demande (le mutex du cœur refuse
 *    un chevauchement : `noop` + `concurrent-cycle`) ;
 *  - `getStatus()` expose `{ state, lastSyncAt, pendingCount, lastError }` pour
 *    le canal IPC `sync:status`.
 *
 * ## Jamais bloquant
 *
 *  - `getDesktopDb() === null` (base non installée par le main) → `log.warn` +
 *    **runner inactif** : le démarrage de l'app n'est pas affecté ;
 *  - toute exception de construction → `log.error` + runner inactif ;
 *  - un cycle qui échoue reste géré par le cœur (`{ status: "error" }`), jamais
 *    par une exception qui remonterait au main.
 */

import log from 'electron-log'
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { DesktopDb } from '@/lib/db/desktop-db'
import { getDesktopDb } from '@/lib/db/desktop-db'
import { radiographs, syncOutbox, syncState } from '@/lib/db/schema'
import { createLocalBlobStore } from '@/lib/offline/blob-store'
import { applyPulledChanges, createLocalApplyRepo } from '@/lib/sync/local-apply'
import { createConflictsDbRepo, recordPushConflicts } from '@/lib/sync/conflict'
import { syncMediaOnce } from '@/lib/sync/media-sync'
import type { MediaSyncDeps } from '@/lib/sync/media-sync'
import { createBackoff, createCentralProbe, SyncScheduler } from '@/lib/sync/net'
import {
  OUTBOX_SEQ_KEY,
  markFailed,
  markSent,
  pendingBatch,
  readCursor,
  writeCursor,
} from '@/lib/sync/outbox'
import type { OutboxRepo, OutboxRow } from '@/lib/sync/outbox'
import type { ChangeOp } from '@/lib/sync/protocol'
import { runSyncCycle } from '@/lib/sync/runner-core'
import type {
  ApplyResultLike,
  SyncCycleResult,
  SyncOutboxApi,
  SyncRunnerDeps,
} from '@/lib/sync/runner-core'
import { LOCAL_UPLOADS_BASE_PATH } from '@/lib/storage'
import { clearSyncToken, readSyncToken, resolveDeviceId, writeSyncToken } from '../env'
import type { SyncStatus } from '../preload'
import { redactSecrets } from '../server/next'

/* -------------------------------------------------------------------------- */
/* Types publics                                                              */
/* -------------------------------------------------------------------------- */

/** Période par défaut de la boucle (le backoff reste géré par l'ordonnanceur). */
const DEFAULT_TICK_MS = 30_000
/** Premier différé : le démarrage de l'app (fenêtre, Next) n'est pas gêné. */
const FIRST_TICK_DELAY_MS = 3_000

/* -------------------------------------------------------------------------- */
/* Étape best-effort de synchronisation des médias (tâche 8.1)                */
/* -------------------------------------------------------------------------- */

/**
 * Plafond d'items (téléchargements **et** téléversements confondus) traités
 * par cycle : un cycle média reste borné, quel que soit le nombre de
 * radiographies du cabinet. Le cœur (`runner-core.ts`) n'est pas modifié :
 * cette étape vit ici, dans le câblage.
 */
const MEDIA_SYNC_MAX_ITEMS = 20
/** Timeout par item distant — aligné sur `SYNC_REQUEST_TIMEOUT_MS` du cœur. */
const MEDIA_REQUEST_TIMEOUT_MS = 15_000

/**
 * États de cycle qui **prouvent** que le central est joignable et le jeton
 * valide lors de CE cycle : le probe (étape 4 du cœur) puis l'habilitation
 * (étape 5) sont franchis avant le push/pull. Tous les autres états
 * (`offline`, `needs-auth`, `needs-clinic`, `idle-no-base-url`, `error`,
 * `noop` refusé) → **aucune** étape média : hors-ligne, aucun aller-retour.
 */
function allowsMediaStep(result: SyncCycleResult): boolean {
  if (result.status === 'pushed' || result.status === 'pulled') return true
  return result.status === 'noop' && result.reason === undefined
}

/**
 * Annule le corps d'une réponse **sans le lire** : la décision (présence,
 * acceptation) repose sur le statut HTTP, jamais sur les octets — on ne
 * re-télécharge pas un fichier entier pour savoir s'il existe.
 * (La route n'exporte pas `HEAD` : Next répondrait 405.)
 */
async function discardBody(response: Response): Promise<void> {
  const body = response.body
  if (body === null) return
  try {
    await body.cancel()
  } catch {
    // Corps déjà fermé ou verrouillé : sans conséquence sur la décision.
  }
}

export interface SyncRunnerHandle {
  /** Arrêt **idempotent** : libère le timer, désactive le runner courant. */
  stop(): void;
  /** Déclenche un cycle à la demande (mutex : refus `noop` si un cycle roule). */
  triggerNow(): Promise<SyncCycleResult>;
  /** État courant pour `sync:status` (comptage `pending` via la base locale). */
  getStatus(): Promise<SyncStatus>;
  /** Cabinet actif (étape 7 — l'UI le choisit) ; `null` → cycles `needs-clinic`. */
  setActiveClinicId(clinicId: string | null): void;
}

export interface StartSyncRunnerOptions {
  /**
   * Origine du central telle que résolue par `buildNextEnv` (validée, rejet
   * des URL malformées). Défaut : `process.env.SYNC_BASE_URL`.
   */
  baseUrl?: string | null;
  /** Cabinet actif déjà connu au démarrage (défaut `null` → `needs-clinic`). */
  clinicId?: string | null;
  /** Période de la boucle — principalement pour les tests. */
  tickMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Runner courant (consulté par `ipc.ts`)                                      */
/* -------------------------------------------------------------------------- */

let currentRunner: SyncRunnerHandle | null = null

/** Runner actif, `null` si aucun (ou après `stop()`). */
export function getCurrentSyncRunner(): SyncRunnerHandle | null {
  return currentRunner
}

/* -------------------------------------------------------------------------- */
/* Repo Drizzle d'outbox (poste local)                                         */
/* -------------------------------------------------------------------------- */

/** Ligne `sync_outbox` → `OutboxRow` (`id` ↔ `opId`, `table_name` ↔ `table`). */
type SyncOutboxRow = typeof syncOutbox.$inferSelect

function toOutboxRow(row: SyncOutboxRow): OutboxRow {
  return {
    opId: row.id,
    table: row.tableName,
    rowId: row.rowId,
    op: row.op,
    payload: row.payload,
    clinicId: row.clinicId,
    deviceId: row.deviceId,
    seq: row.seq,
    createdAt: row.createdAt,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
  }
}

/**
 * Implémentation SQL du repo `outbox.ts` sur l'instance du poste.
 *
 * Les méthodes `insertOutbox` / `nextSeq` / `purgeSent` complètent l'interface
 * (`enqueueInTransaction`, purge) sans être consommées ici : elles sont
 * nécessaires à la conformité de `OutboxRepo` et réutiliseront la même
 * transaction que les actions métier (étape 7.5). `nextSeq` est atomique
 * (`INSERT … ON CONFLICT … SET value = value + 1`) : un `max(seq)` non
 * verrouillé attribuerait deux fois le même `seq` et casserait l'ordre
 * parent→enfant du push.
 */
function createDrizzleOutboxRepo(db: DesktopDb): OutboxRepo {
  return {
    async insertOutbox(entry) {
      await db.insert(syncOutbox).values({
        id: entry.opId,
        tableName: entry.table,
        rowId: entry.rowId,
        op: entry.op,
        payload: entry.payload,
        clinicId: entry.clinicId,
        deviceId: entry.deviceId,
        seq: entry.seq,
        createdAt: entry.createdAt,
      })
    },

    async nextSeq() {
      const rows = await db
        .insert(syncState)
        .values({ key: OUTBOX_SEQ_KEY, value: 1 })
        .onConflictDoUpdate({
          target: syncState.key,
          set: { value: sql`${syncState.value} + 1`, updatedAt: new Date() },
        })
        .returning({ value: syncState.value })
      const value = rows[0]?.value
      if (typeof value !== 'number') {
        throw new Error('sync : compteur sync_state.outbox_seq illisible.')
      }
      return value
    },

    async listPending(limit) {
      const rows = await db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.status, 'pending'))
        .orderBy(asc(syncOutbox.seq))
        .limit(limit)
      return rows.map(toOutboxRow)
    },

    async getOutbox(opId) {
      const rows = await db
        .select()
        .from(syncOutbox)
        .where(eq(syncOutbox.id, opId))
        .limit(1)
      const row = rows[0]
      return row === undefined ? null : toOutboxRow(row)
    },

    async markSent(opIds) {
      if (opIds.length === 0) return
      await db.update(syncOutbox).set({ status: 'sent' }).where(inArray(syncOutbox.id, opIds))
    },

    async updateOutbox(opId, patch) {
      await db.update(syncOutbox).set(patch).where(eq(syncOutbox.id, opId))
    },

    async purgeSent(olderThan) {
      const rows = await db
        .delete(syncOutbox)
        .where(and(eq(syncOutbox.status, 'sent'), lt(syncOutbox.createdAt, olderThan)))
        .returning({ id: syncOutbox.id })
      return rows.length
    },

    async setState(key, value) {
      await db
        .insert(syncState)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: syncState.key,
          set: { value, updatedAt: new Date() },
        })
    },

    async getState(key) {
      const rows = await db
        .select({ value: syncState.value })
        .from(syncState)
        .where(eq(syncState.key, key))
        .limit(1)
      return rows[0]?.value ?? null
    },
  }
}

/** Pré-lie les helpers testés de `outbox.ts` au repo Drizzle du poste. */
function bindOutbox(repo: OutboxRepo): SyncOutboxApi {
  return {
    pendingBatch: (limit) => pendingBatch(repo, limit),
    markSent: (opIds) => markSent(repo, opIds),
    markFailed: (opId, error) => markFailed(repo, opId, error),
    readCursor: () => readCursor(repo),
    writeCursor: (cursor) => writeCursor(repo, cursor),
  }
}

/* -------------------------------------------------------------------------- */
/* Application locale                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A1 — une ligne possédant une entrée `pending` dans `sync_outbox` est
 * **ignorée** par le pull (le poste pousse d'abord la sienne). Requête bornée
 * à `idx_sync_outbox_status_seq` (statut `pending`).
 */
async function isRowLocallyPending(
  db: DesktopDb,
  table: string,
  rowId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: syncOutbox.id })
    .from(syncOutbox)
    .where(
      and(
        eq(syncOutbox.tableName, table),
        eq(syncOutbox.rowId, rowId),
        eq(syncOutbox.status, 'pending'),
      ),
    )
    .limit(1)
  return rows.length > 0
}

function applyChanges(db: DesktopDb, ops: ChangeOp[]): Promise<ApplyResultLike> {
  return applyPulledChanges(createLocalApplyRepo(db), ops, {
    isRowLocallyPending: (table, rowId) => isRowLocallyPending(db, table, rowId),
    now: new Date(),
  })
}

/* -------------------------------------------------------------------------- */
/* Statut                                                                      */
/* -------------------------------------------------------------------------- */

/** Nombre de lignes `pending` (comptage best-effort : `null` si indisponible). */
async function readPendingCount(db: DesktopDb | null): Promise<number | null> {
  if (db === null) return null
  try {
    const rows = await db
      .select({ total: sql<number>`count(*)` })
      .from(syncOutbox)
      .where(eq(syncOutbox.status, 'pending'))
    return Number(rows[0]?.total ?? 0)
  } catch (error) {
    log.warn(`[sync] comptage de l'outbox impossible : ${redactSecrets(messageOf(error))}`)
    return null
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Étiquette sûre d'une origine centrale : **origine seule** (pas de chemin). */
function describeOrigin(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return 'absent'
  try {
    return new URL(baseUrl).origin
  } catch {
    return '(illisible)'
  }
}

/* -------------------------------------------------------------------------- */
/* Runner inactif                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Handle de repli : aucune boucle, aucun réseau. `triggerNow` répond
 * `noop` + `reason`, `getStatus` expose `state: "inactive"`. **Toujours**
 * enregistré comme runner courant (le pont IPC a un état à servir).
 */
function createInactiveHandle(reason: string): SyncRunnerHandle {
  const handle: SyncRunnerHandle = {
    stop() {
      if (currentRunner === handle) {
        currentRunner = null
      }
    },
    triggerNow: async () => ({ status: 'noop', reason }),
    getStatus: async () => ({
      state: 'inactive',
      lastSyncAt: null,
      pendingCount: await readPendingCount(getDesktopDb()),
      lastError: null,
    }),
    setActiveClinicId: () => {
      // Runner inactif : aucun cabinet à porter.
    },
  }
  currentRunner = handle
  return handle
}

/* -------------------------------------------------------------------------- */
/* Démarrage                                                                   */
/* -------------------------------------------------------------------------- */

export function startSyncRunner(options: StartSyncRunnerOptions = {}): SyncRunnerHandle {
  if (currentRunner !== null) {
    // Jamais deux boucles : le runner précédent est arrêté (idempotent).
    currentRunner.stop()
  }
  try {
    return startRunnerUnsafe(options)
  } catch (error) {
    // Aucune défaillance du runner ne doit empêcher le démarrage de l'app.
    log.error(`[sync] démarrage du runner impossible (app inchangée) : ${redactSecrets(messageOf(error))}`)
    return createInactiveHandle('runner-start-failed')
  }
}

function startRunnerUnsafe(options: StartSyncRunnerOptions): SyncRunnerHandle {
  const db = getDesktopDb()
  if (db === null) {
    // Le main n'a pas installé l'instance : runner inactif, app utilisable.
    log.warn('[sync] runner INACTIF : aucune base locale installée (getDesktopDb() null) — synchronisation désactivée')
    return createInactiveHandle('runner-inactive')
  }

  const rawBaseUrl =
    options.baseUrl === undefined || options.baseUrl === null
      ? process.env.SYNC_BASE_URL
      : options.baseUrl
  const baseUrl =
    rawBaseUrl === undefined || rawBaseUrl.trim().length === 0 ? undefined : rawBaseUrl.trim()
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS

  // Garde-fou SSRF du probe : `isCentralReachable` lit
  // `process.env.SYNC_BASE_URL` pour comparer l'origine autorisée à celle du
  // central. On aligne l'env du main sur la valeur **résolue** (jamais
  // journalisée) : sans cela, le probe échouerait fail-closed en dev (la
  // valeur du `.env` n'existe pas dans `process.env` du main).
  if (baseUrl !== undefined) {
    process.env.SYNC_BASE_URL = baseUrl
  } else {
    delete process.env.SYNC_BASE_URL
  }

  // Journal des conflits (D-4) : repo lié à la base du poste. Construit
  // UNIQUEMENT ici (base non nulle) : sans base, ce bloc n'est pas atteint et
  // le runner reste inactif — comportement inchangé.
  const conflictsRepo = createConflictsDbRepo(db)

  // Magasin binaire local (tâche 8.1) : même base que `LocalStorageAdapter`
  // (`uploads/<key>`), résolue contre `process.cwd()` — les octets téléchargés
  // sont donc lisibles par la route `/api/files/[...key]` sans autre câblage.
  const mediaBlobs = createLocalBlobStore(LOCAL_UPLOADS_BASE_PATH)

  const deps: SyncRunnerDeps = {
    baseUrl,
    clinicId: options.clinicId ?? null,
    deviceId: resolveDeviceId(),
    probe: createCentralProbe(),
    scheduler: new SyncScheduler({ now: () => new Date(), backoff: createBackoff() }),
    outbox: bindOutbox(createDrizzleOutboxRepo(db)),
    token: {
      read: () => readSyncToken(),
      write: (token, expiresAt) => writeSyncToken(token, expiresAt),
      clear: () => clearSyncToken(),
    },
    applyChanges: (ops) => applyChanges(db, ops),
    // D-4 : `conflicts[]` du push → `sync_conflict` locale (idempotent,
    // payloads projetés). `now` pris à l'écriture : `decided_at` = réception
    // réelle de la réponse. Jamais de jeton ni d'URL d'origine transmis.
    recordConflicts: async (entries) => {
      await recordPushConflicts(conflictsRepo, entries, new Date())
    },
    fetchImpl: fetch,
    now: () => new Date(),
    logger: {
      info: (message) => log.info(redactSecrets(`[sync] ${message}`)),
      warn: (message) => log.warn(redactSecrets(`[sync] ${message}`)),
      error: (message) => log.error(redactSecrets(`[sync] ${message}`)),
    },
  }

  let stopped = false
  let timer: NodeJS.Timeout | null = null
  let lastSyncAt: string | null = null
  let lastError: string | null = null

  function applyStatus(result: SyncCycleResult): void {
    if (result.status === 'error') {
      // Deuxième niveau de redaction : ce message part vers le renderer via
      // `sync:status`, il passe donc par la même barrière que les logs.
      lastError = redactSecrets(result.reason)
      return
    }
    if (result.status === 'pulled' || result.status === 'pushed') {
      lastSyncAt = deps.now().toISOString()
      lastError = null
    }
  }

  /**
   * Dépendances de l'étape média (tâche 8.1) — construites à chaque étape
   * pour figer le cabinet ACTIF et le jeton VALIDE du cycle en cours. Aucune
   * de ces valeurs n'est journalisée.
   *
   * Déclarée en `const` **après** la garde `db === null` ci-dessus : le corps
   * d'une déclaration de fonction étant hoisté, il ne bénéficierait pas du
   * narrowing de `db`.
   */
  const createMediaSyncDeps = (
    base: string,
    clinicId: string,
    token: string,
  ): MediaSyncDeps => {
    const authHeader = { Authorization: `Bearer ${token}` }
    const urlFor = (key: string): string => {
      const url = new URL(`${base}/api/sync/media`)
      url.searchParams.set('key', key)
      url.searchParams.set('clinicId', clinicId)
      return url.toString()
    }
    return {
      blobs: mediaBlobs,
      // Radiographies du cabinet actif, non supprimées, **plus récentes
      // d'abord** : le plafond `maxItems` examine toujours les têtes de liste
      // à chaque cycle — un téléversement relégué en fin de liste n'est donc
      // jamais éternellement starvé.
      async listLocalRadiographs() {
        const rows = await db
          .select({ fileKey: radiographs.fileKey })
          .from(radiographs)
          .where(
            and(eq(radiographs.clinicId, clinicId), isNull(radiographs.deletedAt)),
          )
          .orderBy(desc(radiographs.createdAt))
        return rows.map((row) => ({ fileKey: row.fileKey }))
      },
      async hasRemote(key) {
        const response = await deps.fetchImpl(urlFor(key), {
          method: 'GET',
          headers: authHeader,
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        })
        await discardBody(response)
        if (response.status === 200) return true
        if (response.status === 404) return false
        throw new Error(`présence distante refusée (HTTP ${response.status})`)
      },
      async downloadRemote(key) {
        const response = await deps.fetchImpl(urlFor(key), {
          method: 'GET',
          headers: authHeader,
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        })
        if (response.status === 200) {
          return new Uint8Array(await response.arrayBuffer())
        }
        await discardBody(response)
        if (response.status === 404) return null
        throw new Error(`téléchargement refusé (HTTP ${response.status})`)
      },
      async uploadLocal(key, bytes) {
        const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
        const response = await deps.fetchImpl(`${base}/api/sync/media`, {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key,
            clinicId,
            contentBase64: buffer.toString('base64'),
          }),
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        })
        await discardBody(response)
        if (response.status === 200) return true
        // Refus FERME du central : taille (413), type (415) ou portée (403)
        // → item écarté (`skipped`), jamais une erreur de cycle.
        if (
          response.status === 413 ||
          response.status === 415 ||
          response.status === 403
        ) {
          return false
        }
        throw new Error(`téléversement refusé (HTTP ${response.status})`)
      },
      logger: deps.logger,
    }
  }

  /**
   * Étape best-effort de synchronisation des médias (tâche 8.1), exécutée
   * **après** le push/pull :
   *
   *  - **seulement si en ligne** : le cycle courant doit avoir franchi le
   *    probe et l'habilitation (`allowsMediaStep`) ;
   *  - **plafonnée** : `MEDIA_SYNC_MAX_ITEMS` items par cycle ;
   *  - **jamais bloquante** : toute défaillance devient un simple
   *    `log.warn` — le cycle de synchronisation est retourné tel quel, et le
   *    cœur (`runner-core.ts`) n'est pas modifié.
   */
  async function runMediaStep(result: SyncCycleResult): Promise<void> {
    if (stopped || !allowsMediaStep(result)) return
    const clinicId = deps.clinicId
    const stored = deps.token.read()
    if (baseUrl === undefined || clinicId === null || stored === null) return
    const expiresAt = Date.parse(stored.expiresAt)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return

    try {
      // `syncMediaOnce` ne rejette jamais : ce `catch` est un filet de sécurité.
      await syncMediaOnce(
        createMediaSyncDeps(baseUrl, clinicId, stored.token),
        { maxItems: MEDIA_SYNC_MAX_ITEMS, timeoutMs: MEDIA_REQUEST_TIMEOUT_MS },
      )
    } catch (error) {
      log.warn(`[sync] étape média ignorée (cycle inchangé) : ${redactSecrets(messageOf(error))}`)
    }
  }

  async function runOnce(): Promise<SyncCycleResult> {
    const result = await runSyncCycle(deps)
    applyStatus(result)
    // Tâche 8.1 : étape média best-effort APRÈS push/pull, hors cœur — voir
    // `runMediaStep` (seulement en ligne, plafonnée, jamais bloquante).
    await runMediaStep(result)
    return result
  }

  function schedule(delayMs: number): void {
    timer = setTimeout(() => {
      void tick()
    }, delayMs)
  }

  async function tick(): Promise<void> {
    if (stopped) return
    try {
      await runOnce()
    } catch (error) {
      // `runSyncCycle` ne rejette jamais : filet de sécurité, sans cycle perdu.
      lastError = 'cycle imprévu'
      log.error(`[sync] cycle imprévu : ${redactSecrets(messageOf(error))}`)
    } finally {
      // Jamais de timer orphelin : replanification conditionnée à `stopped`.
      if (!stopped) {
        schedule(tickMs)
      }
    }
  }

  const handle: SyncRunnerHandle = {
    stop() {
      if (stopped) return
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (currentRunner === handle) {
        currentRunner = null
      }
      log.info('[sync] runner arrêté (aucun timer résiduel)')
    },
    triggerNow: async () => {
      if (stopped) {
        return { status: 'noop', reason: 'runner-stopped' }
      }
      return runOnce()
    },
    getStatus: async () => ({
      state: deps.scheduler.state,
      lastSyncAt,
      pendingCount: await readPendingCount(db),
      lastError,
    }),
    setActiveClinicId: (clinicId) => {
      deps.clinicId = clinicId
    },
  }

  log.info(
    baseUrl === undefined
      ? `[sync] runner démarré : SYNC_BASE_URL absente — cycles idle-no-base-url (aucune requête réseau), tick ${tickMs} ms`
      : `[sync] runner démarré : central ${describeOrigin(baseUrl)}, tick ${tickMs} ms`,
  )
  currentRunner = handle
  schedule(FIRST_TICK_DELAY_MS)
  return handle
}
