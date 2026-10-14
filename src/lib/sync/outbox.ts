/**
 * Tâche 5.1 — FILE D'ATTENTE LOCALE des mutations (`sync_outbox`).
 *
 * Chaque écriture métier effectuée hors-ligne (ou non) sur un poste est
 * **journalisée ici, dans la MÊME transaction** que la mutation réelle, puis
 * poussée au serveur central en ordre `seq` par l'orchestrateur (étape 6).
 *
 * Conception (même style que `src/lib/offline/device-trust.ts`) :
 * - Toute la logique (allocation de `seq`, projection du payload, bornage des
 *   erreurs, curseur) vit ici, en **TypeScript pur**, testable hermétiquement.
 * - L'accès SQL passe par `OutboxRepo`, **injecté** : les tests utilisent un
 *   repo en mémoire, sans base (voir `outbox.test.ts`).
 * - Aucune journalisation ici (`console`/`electron-log` interdits) : le
 *   journal viendra de l'appelant (orchestrateur).
 *
 * ## Atomicité — le contrat le plus sensible du fichier
 *
 * **La mutation métier ET sa ligne d'outbox doivent être écrites dans la même
 * transaction Drizzle.** Sinon, une coupure de courant laisse soit une
 * mutation non journalisée (jamais rejouée : donnée perdue au push suivant),
 * soit un journal sans mutation (rejeu d'une opération fantôme). Utiliser
 * `enqueueInTransaction` : elle enchaîne journal → mutation → commit, et
 * rollback intégral sur la moindre erreur. Le repo passé au callback DOIT être
 * bindé à la transaction en cours (voir `createOutboxRepo` côté DB, étape 7.5).
 */

import { z } from "zod";
import {
  MAX_PUSH_OPS,
  cursorSchema,
  serializeRow,
  type ChangeOp,
  type Cursor,
} from "./protocol";

/* -------------------------------------------------------------------------- */
/* Clés de `sync_state`                                                        */
/* -------------------------------------------------------------------------- */

/** Compteur de `seq` alloué **par poste** (incrémenté dans la transaction). */
export const OUTBOX_SEQ_KEY = "outbox_seq";
/** Curseur de pull courant `(updatedAt, id)`, format `Cursor`. */
export const PULL_CURSOR_KEY = "last_pull_cursor";

/** `lastError` borné : au-delà, l'information utile est déjà noyée. */
export const MAX_LAST_ERROR_LENGTH = 500;
/** Après ce nombre d'échecs, la ligne passe `failed` et devient visible en UI (plan §4.2). */
export const MAX_SEND_ATTEMPTS = 10;

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

export type OutboxOp = "insert" | "update" | "delete";
export type OutboxStatus = "pending" | "sent" | "failed";

/** Ligne de `sync_outbox` telle que lue/écrite par le repo. */
export interface OutboxRow {
  opId: string;
  table: string;
  rowId: string;
  op: OutboxOp;
  /** **Projection** `serializeRow` — jamais la ligne brute. */
  payload: Record<string, unknown>;
  clinicId: string | null;
  deviceId: string | null;
  seq: number;
  createdAt: Date;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

/** Nouvelle ligne d'outbox : état initial imposé par `enqueue`. */
export type NewOutboxRow = Omit<OutboxRow, "status" | "attempts" | "lastError">;

/**
 * Accès à `sync_outbox` / `sync_state`. Injecté pour que cette couche reste
 * testable sans base. L'implémentation SQL (Drizzle) sera branchée par
 * l'orchestrateur (étape 7.5) et DOIT être liée à la transaction courante
 * lorsqu'elle est utilisée avec `enqueueInTransaction`.
 */
export interface OutboxRepo {
  /**
   * Insère une ligne `pending`. **Atomique avec `nextSeq`** lorsque les deux
   * sont appelés dans la même transaction.
   */
  insertOutbox(row: NewOutboxRow): Promise<void>;
  /**
   * Incrémente le compteur `outbox_seq` (table `sync_state`) et renvoie la
   * **nouvelle** valeur. Doit être atomique (`UPDATE … RETURNING` ou équivalent)
   * et s'exécuter **dans la transaction** : un `SELECT max(seq)` non verrouillé
   * attribuerait le même `seq` à deux mutations concurrentes et casserait
   * l'ordre parent→enfant du push.
   */
  nextSeq(): Promise<number>;
  /** Lignes `pending`, ordre `seq` ASC, bornées à `limit`. */
  listPending(limit: number): Promise<OutboxRow[]>;
  /** Lit une ligne d'outbox, `null` si inconnue. */
  getOutbox(opId: string): Promise<OutboxRow | null>;
  /** Marque des opIds comme `sent` (idempotent ; un opId inconnu est ignoré). */
  markSent(opIds: string[]): Promise<void>;
  /** Met à jour `status` / `attempts` / `lastError` d'une ligne. */
  updateOutbox(
    opId: string,
    patch: { status?: OutboxStatus; attempts?: number; lastError?: string | null },
  ): Promise<void>;
  /** Supprime les lignes `sent` antérieures à `olderThan` ; renvoie le nombre purgé. */
  purgeSent(olderThan: Date): Promise<number>;
  /** Écrit une valeur dans `sync_state` (écrase). */
  setState(key: string, value: unknown): Promise<void>;
  /** Lit une valeur de `sync_state` ; `null` si la clé est absente. */
  getState(key: string): Promise<unknown>;
}

/** Transaction localiste : le repo du callback DOIT écrire dans cette transaction. */
export interface OutboxTransaction<TRepo extends OutboxRepo = OutboxRepo> {
  readonly repo: TRepo;
  /** Annule la transaction entière (mutation métier ET outbox). */
  rollback(): Promise<void>;
  /** Committe la transaction entière. */
  commit(): Promise<void>;
}

/**
 * Fabrique de transactions (adaptateur Drizzle côté app, jamais importé ici).
 * Générique sur le repo : `enqueueInTransaction` l'utilise pour typer le repo
 * passé au callback `mutate` (écritures métier **via la transaction**).
 */
export interface OutboxDatabase<TRepo extends OutboxRepo = OutboxRepo> {
  begin(): Promise<OutboxTransaction<TRepo>>;
}

export interface EnqueueParams {
  table: string;
  rowId: string;
  op: OutboxOp;
  /** Ligne **brute** : sera projetée sur la liste blanche par `serializeRow`. */
  payload: Record<string, unknown>;
  clinicId: string | null;
  deviceId: string;
  at: Date;
}

export const enqueueParamsSchema = z.object({
  table: z.string().min(1),
  rowId: z.string().min(1),
  op: z.enum(["insert", "update", "delete"]),
  payload: z.record(z.string(), z.unknown()),
  clinicId: z.string().nullable(),
  deviceId: z.string().min(1),
  at: z.date(),
});

/* -------------------------------------------------------------------------- */
/* Erreurs bornées et redigées                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Nettoie une erreur avant journalisation : retire les fragments sensibles
 * (jetons `Bearer`, `password=`/`token=`/`secret=`, clés de type `key=`) puis
 * **tranche** à `MAX_LAST_ERROR_LENGTH`. `lastError` est lu par l'UI de revue :
 * il ne doit jamais devenir un canal de fuite.
 */
export function redactError(raw: string): string {
  return raw
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|token|secret|authorization|api[-_]?key|key)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .slice(0, MAX_LAST_ERROR_LENGTH);
}

/* -------------------------------------------------------------------------- */
/* enqueue                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Journalise une mutation dans l'outbox.
 *
 * - Le `payload` reçu est la ligne **brute** : il est projeté sur la liste
 *   blanche du registre via `serializeRow` (aucun secret ne peut partir).
 * - `seq` est alloué **atomiquement** par le repo (compteur `sync_state`), pas
 *   par un `max(seq)` verrouillé.
 * - `repo` DOIT être bindé à la même transaction que la mutation métier —
 *   sinon une coupure laisse un déséquilibre (voir en-tête). En pratique,
 *   passez par `enqueueInTransaction`.
 */
export async function enqueue(
  repo: OutboxRepo,
  params: EnqueueParams,
): Promise<{ opId: string; seq: number }> {
  const { table, rowId, op, payload, clinicId, deviceId, at } =
    enqueueParamsSchema.parse(params);
  // Garde-fou sécurité : la ligne brute n'est JAMAIS stockée telle quelle.
  const projected = serializeRow(table, payload);
  const seq = await repo.nextSeq();
  const opId = crypto.randomUUID();
  await repo.insertOutbox({
    opId,
    table,
    rowId,
    op,
    payload: projected,
    clinicId,
    deviceId,
    seq,
    createdAt: at,
  });
  return { opId, seq };
}

/**
 * Journalise une mutation **atomiquement avec la mutation métier**.
 *
 * Ordre : 1) journal (`enqueue`), 2) mutation métier (`mutate`), 3) commit.
 * Toute erreur — y compris dans `mutate` **après** l'insertion du journal —
 * déclenche un `rollback` intégral : ni la mutation, ni la ligne d'outbox ne
 * persistent. C'est ce qui garantit « aucune mutation sans journal, aucun
 * journal sans mutation » (plan §4.2, T-7).
 *
 * `TRepo` est le **type réel** du repo de transaction : `mutate` doit y écrire
 * les mutations métier **via ce repo** (bindé à la transaction), jamais via le
 * `db` global — sinon le rollback devient illusoire (la mutation survivrait à
 * l'annulation de la transaction).
 *
 * @param db     fabrique de transaction (adaptateur Drizzle injecté par l'appelant)
 * @param params journalisé (ligne brute, projetée par `enqueue`)
 * @param mutate mutation métier, exécutée avec `tx.repo` — **même transaction**
 */
export async function enqueueInTransaction<TRepo extends OutboxRepo>(
  db: OutboxDatabase<TRepo>,
  params: EnqueueParams,
  mutate: (repo: TRepo) => Promise<void>,
): Promise<{ opId: string; seq: number }> {
  const tx = await db.begin();
  try {
    const result = await enqueue(tx.repo, params);
    await mutate(tx.repo);
    await tx.commit();
    return result;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Lecture du lot à pousser                                                    */
/* -------------------------------------------------------------------------- */

/** Ligne d'outbox → opération du protocole (`ChangeOp`). */
export function toChangeOp(row: OutboxRow): ChangeOp {
  return {
    opId: row.opId,
    table: row.table,
    rowId: row.rowId,
    op: row.op,
    payload: row.payload,
    clinicId: row.clinicId,
    // `rev` est absent volontairement : la version monotone est attribuée côté
    // serveur central, jamais par l'horloge/poste client.
    updatedAt: row.createdAt.toISOString(),
    ...(row.deviceId !== null ? { deviceId: row.deviceId } : {}),
  };
}

/**
 * Prochain lot à pousser, ordre `seq` ASC (parent avant enfant), borné à
 * `limit`. Seules les lignes `pending` sont retournées (`sent` et `failed`
 * sont exclus).
 *
 * `limit` est **coupé à `MAX_PUSH_OPS`** : un lot plus grand serait rejeté en
 * bloc par `pushRequestSchema` (`.max(MAX_PUSH_OPS)`) à chaque tentative,
 * bloquant définitivement la boucle de retry. Un appeler qui demande plus est
 * donc servi par tranches successives.
 */
export async function pendingBatch(
  repo: OutboxRepo,
  limit: number,
): Promise<ChangeOp[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `sync/outbox : limit de lot invalide (${limit}) — entier positif attendu.`,
    );
  }
  const rows = await repo.listPending(Math.min(limit, MAX_PUSH_OPS));
  return rows.map(toChangeOp);
}

/* -------------------------------------------------------------------------- */
/* Statuts                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Marque des opérations comme envoyées (`sent`). Idempotent : re-marquer une
 * ligne déjà `sent` est un no-op. Un tableau vide est accepté (aucun appel).
 */
export async function markSent(repo: OutboxRepo, opIds: string[]): Promise<void> {
  if (opIds.length === 0) return;
  await repo.markSent(opIds);
}

/**
 * Enregistre un échec d'envoi : `attempts` + 1, `lastError` redigé puis tronqué.
 *
 * La ligne reste `pending` (rejouée au prochain lot) tant que
 * `attempts < MAX_SEND_ATTEMPTS` ; au-delà elle passe `failed` et devient
 * visible dans l'UI de revue (plan §4.2).
 *
 * **No-op total** si la ligne est déjà `sent` **ou** `failed` : jamais
 * d'incrément au-delà de `MAX_SEND_ATTEMPTS` (une ligne `failed` ne peut plus
 * remonter dans le lot, compter ses échecs ultérieurs ne ferait que noyer le
 * premier diagnostic), et jamais de rétrogradation d'une ligne déjà `sent`.
 */
export async function markFailed(
  repo: OutboxRepo,
  opId: string,
  error: string,
): Promise<void> {
  const row = await repo.getOutbox(opId);
  if (!row || row.status === "sent" || row.status === "failed") {
    return;
  }
  const attempts = row.attempts + 1;
  await repo.updateOutbox(opId, {
    attempts,
    lastError: redactError(error),
    status: attempts >= MAX_SEND_ATTEMPTS ? "failed" : "pending",
  });
}

/**
 * Purge les lignes `sent` plus vieilles que `olderThan` ; renvoie le nombre de
 * lignes supprimées. Seules les lignes `sent` sont éligibles : un `pending`
 * (à rejouer) ou un `failed` (à rejouer manuellement) ne doit jamais être
 * purgé, sinon l'opération serait perdue sans trace.
 */
export async function purgeSent(
  repo: OutboxRepo,
  olderThan: Date,
): Promise<number> {
  return repo.purgeSent(olderThan);
}

/* -------------------------------------------------------------------------- */
/* Curseur de pull                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Lit le curseur de pull (`sync_state.last_pull_cursor`). `null` si la clé est
 * absente **ou malformée** (une valeur corrompue ne doit pas planter
 * l'orchestrateur : on repart d'un pull complet, sûr mais coûteux).
 */
export async function readCursor(repo: OutboxRepo): Promise<Cursor | null> {
  const raw = await repo.getState(PULL_CURSOR_KEY);
  const parsed = cursorSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Écrit le curseur de pull (idempotent : réécriture à l'identique sans effet).
 * Le curseur est validé par le schéma du protocole — une valeur invalide lève
 * et n'est jamais persistée.
 */
export async function writeCursor(repo: OutboxRepo, cursor: Cursor): Promise<void> {
  const parsed = cursorSchema.parse(cursor);
  await repo.setState(PULL_CURSOR_KEY, parsed);
}
