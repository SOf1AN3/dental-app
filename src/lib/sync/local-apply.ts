/**
 * Tâche 5.4 — application **LOCALE** des changements tirés du central (pull).
 *
 * L'orchestrateur du main (étape 5.5) récupère un lot via `POST /api/sync/pull`
 * et le confie ici : chaque `ChangeOp` est **réappliquée dans la base locale**
 * du poste, sans jamais écraser le travail en cours de l'utilisateur.
 * Contrepartie locale de `src/lib/sync/central-store.ts` (qui, elle, arbitre
 * côté serveur) : même style — **TypeScript pur + frontière SQL injectée**.
 *
 * ## Design
 *
 *  - Toute la logique (validation Zod, registre, filtres, projection, plan
 *    d'écriture, isolement des erreurs) est du **TypeScript pur**.
 *  - L'accès SQL passe par `LocalApplyRepo`, **injecté** : les tests
 *    hermétiques (`local-apply.test.ts`) fournissent un repo mémoire, sans
 *    base. Le chemin de production est `createLocalApplyRepo(desktopDb)` avec
 *    l'instance de `src/lib/db/desktop-db.ts` (**jamais** `db.ts`, qui plante
 *    au top-level dans le main Electron).
 *  - Aucune écriture n'est **ré-journalisée** : voir « A5 » plus bas.
 *
 * ## Invariants (NON NÉGOCIABLES)
 *
 *  - **A1 — ne jamais écraser le travail local.** Si la ligne possède des
 *    entrées **`pending`** dans `sync_outbox`, elle est **ignorée**
 *    (`skippedPending`) : le poste pousse d'abord la sienne, l'arbitrage
 *    définitif étant LWW côté central (étape 4). C'est LA règle de ce module.
 *    Le contrôle est **injecté** (`isRowLocallyPending`) : l'appelant décide
 *    de la requête (index `idx_sync_outbox_status_seq`, statut `pending`).
 *  - **A2 — projection.** Chaque payload passe par `serializeRow` (liste
 *    blanche du registre) **avant** toute écriture : un serveur compromis ne
 *    peut pas injecter `password_hash`.
 *  - **A3 — upsert whitelisté.** `INSERT … ON CONFLICT (id) DO UPDATE` :
 *    seules les colonnes du registre sont écrites, **plus** `rev`,
 *    `updated_at`, `device_id`, `deleted_at` reçus du serveur (tables du
 *    Groupe A, `entry.cursor`). `created_at` est **copié** depuis la source à
 *    l'insertion et **jamais** réécrit à la mise à jour (exclu du `SET` — il
 *    conserve donc sa valeur d'origine, jamais `now()`).
 *  - **A4 — tombstones.** `op = "delete"` → `deleted_at` posé (soft delete via
 *    l'upsert), **aucun** `DELETE` physique. Le repo injecté n'expose d'ailleurs
 *    aucune méthode de suppression.
 *  - **A5 — aucune boucle push ↔ pull.** Voir section dédiée ci-dessous.
 *  - **A6 — erreurs isolées.** Chaque opération tourne dans **sa propre
 *    transaction** ; une ligne en échec (contrainte, type, callback) est
 *    collectée dans `errors` (motif **rédigé/tronqué** par `redactError`) et le
 *    lot continue.
 *  - **A7 — tables.** Table inconnue ou `push-only` (ex. `audit_log`) →
 *    `skippedUnknown`, jamais d'exception. `pull-only` (ex. `notification`) est
 *    appliqué : c'est le sens du tirage.
 *  - **A8 — enfants.** Les tables du Groupe B (`invoice_item`, …) sont traitées
 *    comme des ops à part entière, **dans l'ordre reçu**, sans colonnes de
 *    curseur (`cursor: false`).
 *
 * ## A5 en détail — pourquoi tirer une ligne ne ré-alimente **jamais** l'outbox
 *
 * Une boucle se produirait si : `appliquer une ligne tirée → nouvelle entrée
 * `pending` dans `sync_outbox` → re-poussée → re-tirée → …`. Elle est brisée
 * **structurellement**, pas par un simple drapeau :
 *
 *  1. Ce module n'a **aucune écriture possible** dans `sync_outbox` : la seule
 *     opération exposée par `LocalApplyRepo` est `transaction` → `upsertRow`
 *     sur une **table du registre**. Aucun import de la file (`enqueue` et sa
 *     variante transactionnelle ne sont pas référencés ici — le test le
 *     vérifie par scan de source), et aucune écriture de `sync_state` (le
 *     curseur de pull est avancé **par l'appelant**, étape 5.5) ;
 *  2. l'alimentation de l'outbox est **explicite** : elle est faite par les
 *     actions métier via `enqueueInTransaction`, **au moment de la mutation
 *     utilisateur** — il n'existe aucun trigger PostgreSQL qui journalise une
 *     écriture automatiquement. Une ligne tirée n'est donc jamais « vue » par
 *     ce chemin ;
 *  3. **écho d'une ligne que nous avons nous-mêmes poussée** : elle revient au
 *     tirage avec `device_id` égal au nôtre (mais `status` de notre entrée est
 *     alors `sent`, plus `pending` → A1 ne l'exclut pas, l'application est donc
 *     voulue : elle synchronise `rev`). Elle est réappliquée par l'upsert, sans
 *     être re-journalisée → pas de rebouclage. Comparer `device_id` au nôtre ou
 *     poser un drapeau « déjà tiré » serait donc **inutile** : l'absence
 *     d'écriture d'outbox suffit, et c'est ce que garantit le test
 *     « aucune écriture dans sync_outbox ».
 *
 * ## Race connue et acceptée (A1)
 *
 * `isRowLocallyPending` est interrogé **avant** la transaction d'écriture : une
 * mutation locale journalisée entre les deux n'est pas vue. Le risque est
 * borné — l'écriture tirée est réappliquée par le prochain cycle, l'arbitrage
 * final étant LWW central (étape 4), et l'appelant doit enchaîner
 * **push puis pull** dans le même cycle pour réduire encore la fenêtre.
 */

import { getTableColumns } from "drizzle-orm";
import type { IndexColumn } from "drizzle-orm/pg-core";
import type { DesktopDb } from "../db/desktop-db";
import { redactError } from "./outbox";
import {
  changeOpSchema,
  getReplicatedTable,
  serializeRow,
  type ChangeOp,
  type ReplicatedTable,
} from "./protocol";

/* -------------------------------------------------------------------------- */
/* 1. Types                                                                    */
/* -------------------------------------------------------------------------- */

/** Ligne métier (colonnes Drizzle, valeurs telles que préparées par la couche pure). */
export type Row = Record<string, unknown>;

export interface ApplyError {
  rowId: string;
  table: string;
  /** Motif **rédigé et borné** (jamais de détail interne cru). */
  reason: string;
}

export interface ApplyResult {
  applied: number;
  skippedPending: number;
  skippedUnknown: number;
  errors: ApplyError[];
}

export interface ApplyOptions {
  /**
   * Filtre optionnel de portée (jeton d'appareil) : `false` → la ligne est
   * écartée (`skippedUnknown`), jamais écrite. L'appelant est responsable du
   * rattachement **enfant → parent** (une table du Groupe B n'a pas de
   * `clinic_id` : c'est le clinic de son parent qui doit être vérifié).
   */
  deviceTokenRowFilter?: (table: string, rowId: string) => Promise<boolean>;
  /**
   * **A1** — la ligne a-t-elle des entrées `pending` dans `sync_outbox` ?
   * Obligatoire : c'est le garde-fou qui protège le travail local.
   */
  isRowLocallyPending: (table: string, rowId: string) => Promise<boolean>;
  /**
   * Horloge fournie par l'appelant — dernier recours des tombstones.
   * `updated_at` / `rev` appliqués sont toujours **ceux du serveur**.
   */
  now: Date;
}

/**
 * Transaction locale : **seule** capacité d'écriture du module.
 * Aucune méthode d'outbox / de curseur — c'est le socle de A5.
 */
export interface LocalApplyTx {
  /**
   * `INSERT … ON CONFLICT (id) DO UPDATE` :
   * - `insert` — valeurs si la ligne est **absente** (couvre aussi la
   *   réception d'un tombstone pour une ligne inconnue) ;
   * - `update` — **patch** si la ligne existe (`created_at` et `id` en sont
   *   exclus : la date de création est conservée telle quelle).
   */
  upsertRow(table: string, rowId: string, insert: Row, update: Row): Promise<void>;
}

/** Frontière I/O injectée (repo/DB stubbée en test, Drizzle en production). */
export interface LocalApplyRepo {
  /** Transaction **propre à une opération** : rollback intégral si `fn` lève. */
  transaction<T>(fn: (tx: LocalApplyTx) => Promise<T>): Promise<T>;
}

/** Motifs stables collectés dans `ApplyResult.errors[].reason`. */
export const APPLY_REASON = {
  /** Op non conforme à `changeOpSchema` (donnée réseau malformée). */
  invalidOp: "invalid-op",
  /** `delete` reçu sur une table sans colonne tombstone (Groupe B). */
  childDelete: "delete-unsupported",
  /** `serializeRow` a refusé le payload (liste blanche / format). */
  projectionRefused: "projection-refused",
  /** L'upsert a levé (contrainte, type…) — transaction annulée. */
  writeFailed: "write-failed",
  /** Défaillance imprévue hors transaction (callback injecté, etc.). */
  applyFailed: "apply-failed",
} as const;

/**
 * Colonnes de curseur du Groupe A, écrites **uniquement** depuis le serveur
 * (`entry.cursor`), y compris pour `user` dont la liste blanche de sérialisation
 * ne les transporte pas.
 */
export const CURSOR_COLUMNS = ["rev", "updatedAt", "deviceId", "deletedAt"] as const;

/* -------------------------------------------------------------------------- */
/* 2. Helpers purs                                                             */
/* -------------------------------------------------------------------------- */

/** Instant utilisable, `null` sinon (jamais de `new Date("…")` caduc). */
function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ISO string (payload JSON) → `Date` pour les colonnes `timestamp`
 * (même conversion que `central-store` : sans elle, drizzle appellerait
 * `.toISOString()` sur la valeur brute). Aucune autre conversion : les autres
 * types (`jsonb`, `numeric`, `text`…) voyagent tels quels.
 */
function coerceValue(col: IndexColumn, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const meta = col as unknown as { dataType?: string; columnType?: string };
  if (
    meta.dataType === "date" ||
    meta.columnType === "Timestamp" ||
    meta.columnType === "TimestampString"
  ) {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return value;
}

/** Normalise les dates d'une écriture — appelée par `planUpsert` (pur) ET, par
 *  défense en profondeur, par l'adapteur Drizzle. Idempotente (`Date` → `Date`). */
function coerceRow(entry: ReplicatedTable, values: Row): Row {
  const cols = getTableColumns(entry.table) as Record<string, IndexColumn>;
  const out: Row = {};
  for (const [key, value] of Object.entries(values)) {
    const col = cols[key];
    out[key] = col ? coerceValue(col, value) : value;
  }
  return out;
}

/** Identifiants d'une op potentiellement malformée — jamais de throw. */
function errorEntry(op: ChangeOp, reason: string): ApplyError {
  const raw = op as unknown as Record<string, unknown> | null | undefined;
  const field = (key: string): string => {
    const value = raw?.[key];
    return typeof value === "string" && value.length > 0 ? value : "?";
  };
  return { rowId: field("rowId"), table: field("table"), reason };
}

interface WritePlan {
  insert: Row;
  update: Row;
}

/**
 * Plan d'écriture d'une opération — **cœur de A2/A3/A4** (aucune I/O).
 *
 * - `insert` = payload projeté + `id` + colonnes de curseur serveur ;
 * - `update` = même payload **moins** `id` et **moins** `created_at`
 *   (conservé sur une ligne existante : jamais remplacé par `now()`), plus les
 *   colonnes de curseur serveur (Groupe A uniquement) ;
 * - `delete` (Groupe A) → `deleted_at` posé : la valeur tombstone du serveur,
 *   à défaut l'horodatage de l'op, en dernier recours `now`.
 *   À l'inverse, une op **vivante** impose `deleted_at = NULL` : le central
 *   n'émet `op = "insert"` que pour une ligne dont la tombstone est nulle.
 */
function planUpsert(
  entry: ReplicatedTable,
  change: ChangeOp,
  projected: Row,
  fallbackAt: Date,
): WritePlan {
  const insert: Row = { ...projected, id: change.rowId };
  const update: Row = { ...projected };
  delete update.id;
  // A3 — `created_at` : copié à l'insertion (via `insert`), **jamais** écrit
  // dans le `SET` d'une mise à jour → la date de création source est conservée.
  delete update.createdAt;

  // A8 — enfants (Groupe B) : ni `rev`, ni `updated_at`, ni tombstone.
  if (!entry.cursor) {
    return { insert: coerceRow(entry, insert), update: coerceRow(entry, update) };
  }

  const serverAt = toValidDate(change.updatedAt) ?? fallbackAt;
  const rev =
    typeof change.rev === "number"
      ? change.rev
      : typeof projected.rev === "number"
        ? projected.rev
        : undefined;
  const deviceId =
    typeof change.deviceId === "string"
      ? change.deviceId
      : typeof projected.deviceId === "string"
        ? projected.deviceId
        : undefined;
  const deletedAt =
    change.op === "delete" ? (toValidDate(projected.deletedAt) ?? serverAt) : null;

  insert.updatedAt = serverAt;
  insert.deletedAt = deletedAt;
  update.updatedAt = serverAt;
  update.deletedAt = deletedAt;
  if (rev !== undefined) {
    insert.rev = rev;
    update.rev = rev;
  }
  // Rien reçu → la colonne n'est pas touchée (insert : défaut `NULL`).
  if (deviceId !== undefined) {
    insert.deviceId = deviceId;
    update.deviceId = deviceId;
  }
  return { insert: coerceRow(entry, insert), update: coerceRow(entry, update) };
}

/* -------------------------------------------------------------------------- */
/* 3. applyPulledChanges                                                       */
/* -------------------------------------------------------------------------- */

type OpOutcome = "applied" | "skipped-pending" | "skipped-unknown" | "error";

/**
 * Applique un lot de changements tirés dans la base **locale**.
 *
 * - Chaque opération tourne dans **sa propre transaction** : un lot partiellement
 *   appliqué est sans danger (le curseur de pull est avancé par l'appelant,
 *   les lignes en échec restant visibles dans `errors`).
 * - Les ops **ignorées** (`skippedPending` / `skippedUnknown`) ne sont pas des
 *   erreurs : le lot est poussé jusqu'au bout, sans exception levée.
 * - `ops` est re-validé **op par op** par `changeOpSchema` (défense en
 *   profondeur : une op malformée est isolée dans `errors`, elle n'interrompt
 *   pas le lot).
 *
 * @param db repo injecté (Drizzle en production, mémoire en test).
 * @param options voir `ApplyOptions` — `now` doit être une Date valide.
 */
export async function applyPulledChanges(
  db: LocalApplyRepo,
  ops: ChangeOp[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (!Number.isFinite(options.now.getTime())) {
    throw new Error("sync/local-apply : horloge `now` caduque (Date invalide).");
  }
  const result: ApplyResult = {
    applied: 0,
    skippedPending: 0,
    skippedUnknown: 0,
    errors: [],
  };

  for (const op of ops) {
    let outcome: OpOutcome;
    try {
      outcome = await applyOne(db, op, options, result);
    } catch (error) {
      // A6 — défaillance imprévue (callback injecté, repo…) : ligne isolée.
      result.errors.push(errorEntry(op, redactError(`${APPLY_REASON.applyFailed}: ${messageOf(error)}`)));
      continue;
    }
    if (outcome === "applied") result.applied += 1;
    else if (outcome === "skipped-pending") result.skippedPending += 1;
    else if (outcome === "skipped-unknown") result.skippedUnknown += 1;
    // "error" : déjà comptabilisée dans `result.errors` par `applyOne`.
  }

  return result;
}

/**
 * Applique UNE opération — l'ordre des étapes est contraignant :
 *  1. validation Zod → 2. registre / direction (A7) → 3. `delete` sur enfant
 *  (A4) → 4. filtre de portée → 5. **A1** (outbox `pending`) → 6. projection
 *  (A2) → 7. upsert dans sa propre transaction (A3/A4/A6).
 *
 * Les erreurs métier sont **poussées** dans `result.errors` (jamais levées) ;
 * seules les défaillances hors de cette fonction remontent au niveau boucle,
 * qui les isole aussi.
 */
async function applyOne(
  db: LocalApplyRepo,
  op: ChangeOp,
  options: ApplyOptions,
  result: ApplyResult,
): Promise<OpOutcome> {
  /* 1. Validation — donnée réseau : échec isolé, jamais de throw. */
  const parsed = changeOpSchema.safeParse(op);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `${issue.path.join(".") || "-"}: ${issue.message}`
      : "opération malformée";
    result.errors.push(errorEntry(op, redactError(`${APPLY_REASON.invalidOp}: ${detail}`)));
    return "error";
  }
  const change = parsed.data;

  /* 2. A7 — table inconnue ou push-only : écartée sans exception. */
  const entry = getReplicatedTable(change.table);
  if (!entry || entry.direction === "push-only") {
    return "skipped-unknown";
  }

  /* 3. A4 — `delete` sur une table sans colonne tombstone : refus explicite
        (le module n'émet JAMAIS de DELETE physique). */
  if (change.op === "delete" && !entry.cursor) {
    result.errors.push(
      errorEntry(
        change,
        `${APPLY_REASON.childDelete}: « ${change.table} » n'a pas de colonne tombstone.`,
      ),
    );
    return "error";
  }

  /* 4. Portée du jeton d'appareil (optionnel) — ligne hors périmètre. */
  if (
    options.deviceTokenRowFilter &&
    !(await options.deviceTokenRowFilter(change.table, change.rowId))
  ) {
    return "skipped-unknown";
  }

  /* 5. A1 — travail local en attente : on n'y touche PAS. */
  if (await options.isRowLocallyPending(change.table, change.rowId)) {
    return "skipped-pending";
  }

  /* 6. A2 — projection sur la liste blanche AVANT toute écriture. */
  let projected: Row;
  try {
    projected = serializeRow(change.table, change.payload);
  } catch (error) {
    result.errors.push(
      errorEntry(change, redactError(`${APPLY_REASON.projectionRefused}: ${messageOf(error)}`)),
    );
    return "error";
  }

  /* 7. A3/A4/A6 — upsert, transaction propre à l'opération. */
  const plan = planUpsert(entry, change, projected, options.now);
  try {
    await db.transaction((tx) =>
      tx.upsertRow(change.table, change.rowId, plan.insert, plan.update),
    );
  } catch (error) {
    result.errors.push(
      errorEntry(change, redactError(`${APPLY_REASON.writeFailed}: ${messageOf(error)}`)),
    );
    return "error";
  }
  return "applied";
}

/* -------------------------------------------------------------------------- */
/* 4. Implémentation SQL (Drizzle) — chemin de production                      */
/* -------------------------------------------------------------------------- */

/** Transaction Drizzle réelle, dérivée de l'instance du poste. */
export type LocalApplyTxDb = Parameters<Parameters<DesktopDb["transaction"]>[0]>[0];

function createLocalApplyTx(tx: LocalApplyTxDb): LocalApplyTx {
  return {
    async upsertRow(table, rowId, insert, update) {
      const entry = getReplicatedTable(table);
      if (!entry) {
        throw new Error(`sync/local-apply : table « ${table} » absente du registre.`);
      }
      const cols = getTableColumns(entry.table) as Record<string, IndexColumn>;
      // Les valeurs sont déjà normalisées par `planUpsert` : double conversion
      // ici (idempotente) par défense en profondeur, toute écriture passant
      // par le repo bénéficie de la même sécurité.
      const insertValues = coerceRow(entry, { ...insert, id: rowId });
      const updateSet = coerceRow(entry, update);
      // A3 — upsert : `id` en cible de conflit, `SET` = patch whitelisté
      // (`created_at` en est déjà absent, cf. `planUpsert`).
      await tx
        .insert(entry.table)
        .values(insertValues as never)
        .onConflictDoUpdate({ target: cols.id, set: updateSet as never });
    },
  };
}

/**
 * Repo Drizzle de production : `applyPulledChanges(createLocalApplyRepo(db), …)`
 * avec `db` obtenu via `getDesktopDb()` (instance `desktop-db.ts`).
 *
 * Chaque `transaction` ouvre une vraie transaction PostgreSQL (connexions
 * postgres.js dédiées) : un échec d'upsert annule intégralement l'opération.
 * Non couvert par les tests hermétiques : validé par les tests d'intégration /
 * E2E (étape 5.5 et suivantes).
 */
export function createLocalApplyRepo(database: DesktopDb): LocalApplyRepo {
  return {
    async transaction(fn) {
      return database.transaction(async (tx) => fn(createLocalApplyTx(tx)));
    },
  };
}
