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
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { DesktopDb } from '@/lib/db/desktop-db'
import { getDesktopDb } from '@/lib/db/desktop-db'
import { syncOutbox, syncState } from '@/lib/db/schema'
import { applyPulledChanges, createLocalApplyRepo } from '@/lib/sync/local-apply'
import { createConflictsDbRepo, recordPushConflicts } from '@/lib/sync/conflict'
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

  async function runOnce(): Promise<SyncCycleResult> {
    const result = await runSyncCycle(deps)
    applyStatus(result)
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
