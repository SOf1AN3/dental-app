/**
 * Tâche 5.2b — **CŒUR SERVEUR** de la synchronisation : application des
 * opérations de push (`applyOps`) et tirage paginé de pull (`fetchChanges`).
 *
 * Ce module vit côté **serveur central** (Vercel) et est consommé par les
 * routes `POST /api/sync/push` et `GET /api/sync/pull` (étape 5.2c). Il est la
 * contrepartie centrale de `src/lib/sync/outbox.ts` (qui, elle, vit sur le
 * poste local) : même format (`protocol.ts`), autorité opposée — le central
 * **arbitre**, le poste **propose**.
 *
 * ## Design (même style que `central-auth.ts`)
 *
 *  - Toute la logique (idempotence, direction, portée, LWW, verrou montants,
 *    curseur composite, cascadé des enfants) est du **TypeScript pur**.
 *  - L'accès SQL passe par `CentralStoreRepo`, **injecté** : les tests
 *    hermétiques (`central-store.test.ts`) fournissent un repo mémoire, sans
 *    base ni réseau. Le chemin de production est `createCentralStoreDbRepo()`.
 *  - **L'horloge vient TOUJOURS du serveur** (`now`, passé par la route) :
 *    aucun horodatage ni `rev` client n'arbitre jamais un conflit.
 *
 * ## Invariants de sécurité (NON NÉGOCIABLES)
 *
 *  1. **Idempotence (A1)** — chaque `op.opId` n'est appliqué qu'une fois : la
 *     ligne `sync_applied` (PK `op_id`) est écrite **dans la même transaction**
 *     que la donnée. Un push interrompu ne peut donc jamais laisser une op
 *     « appliquée mais non journalisée » (ni l'inverse : un rollback annule les
 *     deux). Le `INSERT … ON CONFLICT DO NOTHING … RETURNING` rend la course
 *     entre deux pushes concurrents non-problématique : le second voit
 *     `markApplied() === false`, n'écrit rien et répond `accepted`.
 *  2. **Anti-injection de cabinet (A3)** — le `clinicId` du payload n'est
 *     **JAMAIS** cru : il est re-vérifié contre `ctx.clinicIds` (liste issue du
 *     jeton d'appareil, elle-même dérivée de `clinic_membership` actif). Tables
 *     sans `clinic_id` : `clinic` → `id ∈ ctx.clinicIds` ; `user` → membre
 *     d'**au moins un** cabinet du device ; enfant → `clinic_id` de son
 *     **parent rechargé** (parent absent → rejet `parent-missing` : op hors
 *     ordre, rejouée au push suivant).
 *  3. **Anti-IDOR (B2)** — le tirage est filtré sur `ctx.clinicIds` **deux
 *     fois** : dans la requête SQL (performance) **et** dans la couche pure
 *     (défense en profondeur — une ligne d'un autre cabinet est jetée même si
 *     le repo la renvoyait). Aucune donnée d'un cabinet étranger ne sort
 *     jamais.
 *  4. **Aucun secret dans un payload (A5/B6)** — `serializeRow` (liste blanche
 *     du registre) est rappelé sur **chaque** payload, en entrée comme en
 *     sortie : `user.password_hash` ne peut figurer ni dans un push appliqué,
 *     ni dans un pull. **Seule exception, explicite et bornée** : l'option
 *     `FetchChangesOptions.includeAuthBootstrap` (tâche 7.1b, variante
 *     « bootstrap » du pull, serveur → poste uniquement) — voir la
 *     documentation détaillée de `FetchChangesOptions` en section 6.
 *
 * ## Arbitrage des conflits (décision D-4)
 *
 *  - Ligne inexistante → **insert**, `rev = 1`.
 *  - `op.rev === existing.rev` (baseRev) → mise à jour, `rev = existing.rev + 1`.
 *  - **BaseRev divergent** (ou absent) → la **dernière écriture reçue gagne**
 *    (écriture quand même : la sync n'est jamais bloquée, D-6) **et** une ligne
 *    `sync_conflict` est journalisée (`reason = base-rev-mismatch`,
 *    `winning_payload` = état appliqué, `losing_payload` = état serveur
 *    préalable) pour la revue humaine.
 *  - **Verrou montants** — sur `invoice` / `quote` dont le `status` serveur est
 *    **au-delà de `draft`**, les colonnes montants sont **jamais** écrasées par
 *    le payload client : seules sont appliquées les parties non protégées.
 *    Voir `PROTECTED_AMOUNT_FIELDS` pour les noms exacts (colonnes réelles de
 *    `src/lib/db/schema/financial.ts`).
 *  - `rev` est **toujours** attribué par le serveur (`existing.rev + 1`) : la
 *    valeur `op.rev` n'est acceptée que comme **baseRev** de comparaison, jamais
 *    comme version finale.
 *  - `updatedAt` / `deleted_at` sont ceux du **serveur** (`now`) : le curseur
 *    central n'avance que sur l'horloge centrale.
 */

import { and, eq, exists, getTableColumns, inArray, isNotNull, isNull, sql, asc } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { db } from "@/lib/db/db";
import { clinicMemberships, syncApplied, syncConflicts } from "@/lib/db/schema";
import type { DeviceTokenContext } from "./central-auth";
import {
  DEFAULT_PULL_LIMIT,
  MAX_PULL_LIMIT,
  MAX_PUSH_OPS,
  pullCursorTables,
  serializeRow,
  TABLE_REGISTRY,
  type ChangeOp,
  type Cursor,
  type PullRequest,
  type PullResponse,
  type PushResponse,
} from "./protocol";

/* -------------------------------------------------------------------------- */
/* 1. Constantes de domaine                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Raisons de rejet d'une opération de push (contraintes de la table
 * `PushResponse.rejected[].reason`). Stables : l'UI et les tests s'y
 * référencent.
 */
export const REJECT = {
  /** Table absente de `TABLE_REGISTRY` — pas de réplication sauvage. */
  unknownTable: "unknown-table",
  /** Table `pull-only` (ex. `notification`) poussée par un poste. */
  wrongDirection: "wrong-direction",
  /** `clinicId` hors `ctx.clinicIds` (ou absent, ou incohérent). */
  clinicMismatch: "clinic-mismatch",
  /** Enfant dont le parent est introuvable : op reçue hors ordre. */
  parentMissing: "parent-missing",
  /** Enfant (`Groupe B`) reçu en `delete` : pas de tombstone sur ces tables. */
  childDeleteUnsupported: "child-delete-unsupported",
  /** Enfant de `invoice`/`quote` dont le parent est au-delà de `draft`. */
  protectedDocument: "protected-document",
  /** Échec d'écriture imprévu : op annulée (rollback) et rejetée. */
  applyError: "apply-error",
} as const;

/**
 * **VERRO MONTANTS (D-4)** — colonnes protégées sur les documents financiers
 * **au-delà de `draft`** : jamais écrasées par le payload client.
 *
 * Noms exacts relevés dans `src/lib/db/schema/financial.ts` :
 * `invoice` et `quote` portent les mêmes colonnes monétaires
 * (`numeric(12,2)`) — `subtotal`, `taxTotal`, `discountTotal`, `total`.
 * Les autres noms évoqués dans la spec (`tax`, `totalAmount`, `taxAmount`,
 * `subtotalAmount`, `lines`, `items`) **n'existent pas** sur `invoice` /
 * `quote` : `totalAmount` appartient à `treatment_plan` / `clinical_session`
 * (hors verrou), et les lignes sont des tables **enfants**
 * (`invoice_item`, `quote_item`) traitées à part (voir
 * `PROTECTED_PARENT_TABLES` : un enfant d'un document soldé est rejeté).
 *
 * `status` est protégé **indirectement** : un payload qui tenterait de
 * **revenir à `draft`** sur un document émis est ignoré (sinon le verrou
 * serait contournable en deux ops : rétrograder puis réécrire les montants).
 */
export const PROTECTED_AMOUNT_FIELDS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    invoice: ["subtotal", "taxTotal", "discountTotal", "total"],
    quote: ["subtotal", "taxTotal", "discountTotal", "total"],
  });

/** Tables financières soumises au verrou montants. */
export const PROTECTED_PARENT_TABLES: ReadonlySet<string> = new Set([
  "invoice",
  "quote",
]);

/**
 * Lien **enfant → parent** (colonnes Drizzle) des tables du Groupe B.
 *
 * `TABLE_REGISTRY` déclare les enfants côté parent (`children: [...]`) mais pas
 * la clé étrangère : cette table statique la documente. Un test de cohérence
 * (`central-store.test.ts`) garantit qu'elle couvre exactement les `children`
 * du registre — toute nouvelle table enfant sans entrée ici casse les tests.
 */
export const CHILD_PARENT_REFS: Readonly<
  Record<string, { parentTable: string; parentKey: string }>
> = Object.freeze({
  invoice_item: { parentTable: "invoice", parentKey: "invoiceId" },
  quote_item: { parentTable: "quote", parentKey: "quoteId" },
  prescription_item: { parentTable: "prescription", parentKey: "prescriptionId" },
  clinical_session_item: { parentTable: "clinical_session", parentKey: "sessionId" },
  treatment_plan_item: { parentTable: "treatment_plan", parentKey: "planId" },
  stock_transaction: { parentTable: "stock_item", parentKey: "itemId" },
});

/**
 * Curseur « avant tout » : renvoyé au client lorsque le premier pull ne
 * rencontre aucune ligne. `(1970-01-01, "0")` précède lexicalement toute ligne
 * réelle (identifiants uuid minuscules, horodatages postérieurs à l'époque) et
 * satisfait `cursorSchema` (`id` non vide).
 */
export const MIN_PULL_CURSOR: Cursor = Object.freeze({
  updatedAt: "1970-01-01T00:00:00.000Z",
  id: "0",
});

/* -------------------------------------------------------------------------- */
/* 2. Erreurs                                                                  */
/* -------------------------------------------------------------------------- */

/** Opération refusée par une règle métier (rejet **contractuel**, pas un bug). */
export class RejectedOpError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`sync/central-store : opération refusée (${reason}).`);
    this.name = "RejectedOpError";
    this.reason = reason;
  }
}

/**
 * `sync_applied` contenait déjà l'`opId` **au moment du INSERT** : course avec
 * un push concurrent qui a gagné. Le `ON CONFLICT DO NOTHING` du repo a donc
 * refusé l'insertion ; la transaction est annulée (rien d'autre n'a été écrit)
 * et l'op est comptée comme `accepted` (elle est déjà appliquée).
 */
export class AlreadyAppliedError extends Error {
  constructor() {
    super("sync/central-store : opId déjà admis par un push concurrent.");
    this.name = "AlreadyAppliedError";
  }
}

/**
 * Tirage hors portée : `PullRequest.clinicId` absent de `ctx.clinicIds`.
 * La route `/api/sync/pull` la traduit en **403** (elle n'est jamais renvoyée
 * au client telle quelle).
 */
export class SyncScopeError extends Error {
  constructor() {
    super("sync/central-store : cabinet demandé hors de la portée du jeton.");
    this.name = "SyncScopeError";
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Repo injecté (frontière I/O)                                             */
/* -------------------------------------------------------------------------- */

/** Ligne métier brute (colonnes Drizzle, valeurs déjà converties par le driver). */
export type Row = Record<string, unknown>;

/**
 * Portée d'une table de curseur pendant le tirage — calculée par la couche
 * pure à partir du registre, **exécutée** par le repo (index
 * `*_clinic_updated_id`).
 */
export type PullScope =
  /** Table à `clinic_id` : `clinic_id ∈ clinicIds`. */
  | { kind: "clinic-column"; column: string; clinicIds: string[] }
  /** Table `clinic` : `id ∈ ids`. */
  | { kind: "clinic-ids"; ids: string[] }
  /** Table `user` : membres actifs d'au moins un des `clinicIds`. */
  | { kind: "user-membership"; clinicIds: string[] };

export interface ChangedRowsQuery {
  /** Nom SQL d'une table du registre, `cursor: true`. */
  table: string;
  scope: PullScope;
  /** Curseur composite strictement dépassé. */
  cursor: { updatedAt: Date; id: string };
  /** Nombre maximal de lignes (la couche pure demande `limit + 1`). */
  limit: number;
}

export interface ChildRowsQuery {
  /** Nom SQL d'une table enfant (Groupe B). */
  childTable: string;
  parentRowIds: string[];
}

/** Journal des conflits — lignes de `sync_conflict`. */
export interface NewConflictRow {
  tableName: string;
  rowId: string;
  deviceId: string | null;
  winningPayload: Record<string, unknown>;
  losingPayload: Record<string, unknown>;
  reason: string;
  decidedAt: Date;
}

/**
 * Transaction d'application d'**une** opération. `markApplied` et `writeRow`
 * s'exécutent dans la même transaction : c'est le cœur de l'invariant A1.
 */
export interface CentralStoreTx {
  findRow(table: string, rowId: string): Promise<Row | null>;
  /**
   * Écrit la ligne. `insert` insère telle quelle (la couche pure a déjà posé
   * `id` / `rev` / `updated_at` / `device_id` / `deleted_at`) ; `update`
   * applique un **patch** (colonnes fournies uniquement) sur `rowId`.
   */
  writeRow(
    table: string,
    rowId: string,
    values: Row,
    mode: "insert" | "update",
  ): Promise<void>;
  /**
   * Journalise l'admission dans `sync_applied` (`ON CONFLICT DO NOTHING`).
   * Renvoie `false` si l'`opId` était **déjà** journalisé (course entre deux
   * pushes) : l'appelant n'écrit alors **rien** d'autre.
   */
  markApplied(opId: string, deviceId: string, appliedAt: Date): Promise<boolean>;
  insertConflict(conflict: NewConflictRow): Promise<void>;
}

export interface CentralStoreRepo {
  /** `opId` déjà appliqués parmi `opIds` (chemin rapide avant transaction). */
  findApplied(opIds: string[]): Promise<Set<string>>;
  /** User ids membres **actifs** (`joined_at` posé, non supprimé) de `clinicIds`. */
  listUserIdsInClinicScope(clinicIds: string[]): Promise<Set<string>>;
  /** Transaction atomique : rollback intégral si `fn` lève. */
  transaction<T>(fn: (tx: CentralStoreTx) => Promise<T>): Promise<T>;
  /** Lignes d'une table de curseur après `(updated_at, id)`, ordre curseur. */
  listChangedRows(query: ChangedRowsQuery): Promise<Row[]>;
  /** Lignes enfant rattachées à `parentRowIds` (transport en cascadé). */
  listChildRows(query: ChildRowsQuery): Promise<Row[]>;
}

/* -------------------------------------------------------------------------- */
/* 4. Helpers purs                                                             */
/* -------------------------------------------------------------------------- */

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Instant d'une colonne `updated_at` (Date drizzle ou ISO brut) en ms. */
function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** ISO d'une colonne de temps, pour l'habillage d'un `ChangeOp`. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return new Date(0).toISOString();
}

/** Déterministe : `updated_at` croissant, tie-break lexicographic sur `id`. */
function compareCursorOrder(a: Row, b: Row): number {
  const ta = toTime(a.updatedAt);
  const tb = toTime(b.updatedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  const ia = String(a.id);
  const ib = String(b.id);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Table financière au-delà de `draft` ? (`status` absent/`draft` → non). */
function isBeyondDraft(status: unknown): boolean {
  return typeof status === "string" && status.length > 0 && status !== "draft";
}

/**
 * Portée d'une table pendant le tirage, dérivée du registre. `null` = table
 * jamais tirée (audit_log est `push-only`, hors `pullCursorTables()`).
 */
export function pullScopeOf(
  tableName: string,
  clinicIds: string[],
): PullScope | null {
  const entry = TABLE_REGISTRY[tableName];
  if (!entry) return null;
  if (entry.name === "clinic") return { kind: "clinic-ids", ids: clinicIds };
  if (entry.name === "user") return { kind: "user-membership", clinicIds };
  if (entry.clinicIdColumn) {
    return { kind: "clinic-column", column: entry.clinicIdColumn, clinicIds };
  }
  return null;
}

/**
 * **Défense en profondeur anti-IDOR** : re-vérifie qu'une ligne tirée
 * appartient bien à la portée du jeton, même si le repo l'a déjà filtrée en
 * SQL. Toute ligne hors portée est jetée (jamais renvoyée au client).
 */
export function rowWithinScope(
  tableName: string,
  row: Row,
  scope: PullScope,
  memberUserIds: ReadonlySet<string>,
): boolean {
  if (tableName === "clinic") return scope.kind === "clinic-ids" && scope.ids.includes(String(row.id));
  if (tableName === "user") {
    return scope.kind === "user-membership" && memberUserIds.has(String(row.id));
  }
  if (scope.kind === "clinic-column") {
    const clinicId = asNonEmptyString(row[scope.column]);
    return clinicId !== null && scope.clinicIds.includes(clinicId);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* 5. applyOps — application d'un push                                         */
/* -------------------------------------------------------------------------- */

/**
 * Applique un lot d'opérations de push.
 *
 * - Chaque opération est appliquée dans **sa propre transaction** : un lot
 *   partiellement appliqué est sans danger (le rejeu réseau est absorbé par
 *   `sync_applied`), et l'échec d'une op n'annule pas ses aînées.
 * - Les opérations **rejetées** ne sont pas journalisées dans `sync_applied` :
 *   le client DOIT les abandonner (les rejouer re-déclenche le même rejet).
 * - `ops` doit avoir été validé par `pushRequestSchema` côté route ; les
 *   gardes ci-dessous sont défensives (échec fermé).
 *
 * @param now horloge **serveur** — seule autorité d'arbitrage et de curseur.
 */
export async function applyOps(
  ctx: DeviceTokenContext,
  ops: ChangeOp[],
  now: Date,
  repo: CentralStoreRepo = getDefaultRepo(),
): Promise<PushResponse> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("sync/central-store : horloge serveur caduque (now invalide).");
  }
  if (ops.length > MAX_PUSH_OPS) {
    throw new Error(
      `sync/central-store : lot de ${ops.length} opérations (max ${MAX_PUSH_OPS}).`,
    );
  }

  const accepted: string[] = [];
  const rejected: PushResponse["rejected"] = [];
  const conflicts: PushResponse["conflicts"] = [];
  if (ops.length === 0) {
    return { accepted, rejected, conflicts };
  }

  // (a) Chemin rapide A1 : quels opId sont déjà admis ?
  const applied = await repo.findApplied(ops.map((op) => op.opId));

  // (b) Portée `user` : calculée UNE fois, paresseusement (max 1 requête).
  let memberCache: Set<string> | null = null;
  const memberUserIds = async (): Promise<Set<string>> => {
    if (!memberCache) {
      memberCache = await repo.listUserIdsInClinicScope(ctx.clinicIds);
    }
    return memberCache;
  };

  for (const op of ops) {
    if (applied.has(op.opId)) {
      // Rejeu réseau : admis sans ré-appliquer (A1).
      accepted.push(op.opId);
      continue;
    }
    try {
      const opConflicts = await repo.transaction((tx) =>
        applyOneOp(ctx, op, now, tx, memberUserIds),
      );
      accepted.push(op.opId);
      conflicts.push(...opConflicts);
    } catch (error) {
      if (error instanceof AlreadyAppliedError) {
        // Course avec un push concurrent ayant gagné : l'op EST appliquée.
        accepted.push(op.opId);
      } else if (error instanceof RejectedOpError) {
        rejected.push({ opId: op.opId, reason: error.reason });
      } else {
        // Échec imprévu (contrainte DB…) : rollback de l'op, raison générique
        // — aucun détail interne n'est renvoyé au client.
        rejected.push({ opId: op.opId, reason: REJECT.applyError });
      }
    }
  }

  return { accepted, rejected, conflicts };
}

/**
 * Applique UNE opération dans la transaction `tx`.
 *
 * Ordre (contraignant) :
 *  1. registry + direction  → rejet contractuel ;
 *  2. `serializeRow`        → défense en profondeur (aucun secret) ;
 *  3. portée `clinicId`     → re-vérifiée, jamais cruée ;
 *  4. lecture de la ligne   → insert / update / tombstone ;
 *  5. `markApplied`         → AVANT l'écriture, même transaction ;
 *  6. écriture + conflits.
 */
async function applyOneOp(
  ctx: DeviceTokenContext,
  op: ChangeOp,
  now: Date,
  tx: CentralStoreTx,
  memberUserIds: () => Promise<Set<string>>,
): Promise<PushResponse["conflicts"]> {
  const entry = TABLE_REGISTRY[op.table];
  if (!entry) {
    throw new RejectedOpError(REJECT.unknownTable);
  }
  if (entry.direction === "pull-only") {
    // A2 — `notification` (et toute table centrale) n'est jamais poussée.
    throw new RejectedOpError(REJECT.wrongDirection);
  }

  // A5 — projection sur la liste blanche AVANT toute écriture.
  let payload: Row;
  try {
    payload = serializeRow(op.table, op.payload);
  } catch {
    throw new RejectedOpError(REJECT.unknownTable);
  }

  const rowId = op.rowId;

  /* ---------------------- Portée (A3) — jamais le payload ------------------ */

  let scopeClinicId: string | null = null;
  const childRef = CHILD_PARENT_REFS[op.table];

  if (entry.name === "clinic") {
    if (!ctx.clinicIds.includes(rowId)) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
    scopeClinicId = rowId;
  } else if (entry.name === "user") {
    // Portée dérivée : le user doit appartenir à au moins un cabinet du device.
    if (!(await memberUserIds()).has(rowId)) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
  } else if (childRef) {
    // Enfant : portée = clinic_id du PARENT rechargé (jamais le payload).
    if (op.op === "delete") {
      // A6 vaut pour les tables à tombstone ; les enfants n'en ont pas.
      throw new RejectedOpError(REJECT.childDeleteUnsupported);
    }
    const parentRowId = asNonEmptyString(payload[childRef.parentKey]);
    if (!parentRowId) {
      throw new RejectedOpError(REJECT.parentMissing);
    }
    const parent = await tx.findRow(childRef.parentTable, parentRowId);
    if (!parent) {
      throw new RejectedOpError(REJECT.parentMissing);
    }
    const parentClinicId = asNonEmptyString(parent.clinicId);
    if (!parentClinicId || !ctx.clinicIds.includes(parentClinicId)) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
    scopeClinicId = parentClinicId;
    // Verrou D-4 côté lignes : un document émis n'accepte plus de ligne.
    if (
      PROTECTED_PARENT_TABLES.has(childRef.parentTable) &&
      isBeyondDraft(parent.status)
    ) {
      throw new RejectedOpError(REJECT.protectedDocument);
    }
  } else if (entry.clinicIdColumn) {
    // Table à clinic_id : le payload et op.clinicId doivent concorder ET
    // appartenir à la portée du jeton.
    const payloadClinicId = asNonEmptyString(payload[entry.clinicIdColumn]);
    const opClinicId = asNonEmptyString(op.clinicId);
    if (
      payloadClinicId !== null &&
      opClinicId !== null &&
      payloadClinicId !== opClinicId
    ) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
    const effective = payloadClinicId ?? opClinicId;
    if (effective === null || !ctx.clinicIds.includes(effective)) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
    scopeClinicId = effective;
  } else {
    // Table sans clinic_id non couverte ci-dessus (audit_log, `clinic_id`
    // nullable) : toute valeur fournie doit être dans la portée, le null est
    // accepté (entrée d'audit globale, jamais répliquée en tirage).
    const claimed = asNonEmptyString(payload.clinicId);
    if (claimed !== null && !ctx.clinicIds.includes(claimed)) {
      throw new RejectedOpError(REJECT.clinicMismatch);
    }
  }

  /* --------------------------- Enfants (Groupe B) -------------------------- */

  if (childRef) {
    // Pas de `rev` ni de curseur sur ces tables : écriture simple, upsert
    // logique côté client (op `insert`/`update` interchangeables).
    const existingChild = await tx.findRow(op.table, rowId);
    // A1 — journalisation AVANT l'écriture, même transaction.
    if (!(await tx.markApplied(op.opId, ctx.deviceId, now))) {
      throw new AlreadyAppliedError();
    }
    const values: Row = { ...payload, id: rowId };
    await tx.writeRow(
      op.table,
      rowId,
      values,
      existingChild ? "update" : "insert",
    );
    return [];
  }

  /* --------------------- Parents (Groupe A) — LWW + verrou ----------------- */

  const existing = await tx.findRow(op.table, rowId);
  const serverOwned = ["id", "rev", "updatedAt", "deviceId", "deletedAt"] as const;

  if (!existing) {
    // Insert (A4) : `rev = 1`, horodatage serveur, tombstone à null.
    // A1 — le INSERT dans `sync_applied` (ON CONFLICT DO NOTHING) arbitre la
    // course entre deux pushes concurrents : si l'opId existe déjà, la
    // transaction est annulée avant toute écriture de donnée.
    if (!(await tx.markApplied(op.opId, ctx.deviceId, now))) {
      throw new AlreadyAppliedError();
    }
    const values: Row = { ...payload };
    for (const key of serverOwned) delete values[key];
    if (scopeClinicId !== null && entry.clinicIdColumn) {
      values[entry.clinicIdColumn] = scopeClinicId;
    }
    values.id = rowId;
    values.rev = 1;
    values.updatedAt = now;
    values.deviceId = ctx.deviceId;
    values.deletedAt = null;
    await tx.writeRow(op.table, rowId, values, "insert");
    return [];
  }

  const existingRev = asNumber(existing.rev);
  const baseRev = op.rev;
  // BaseRev absente → divergence non vérifiable → LWW + journal (voir en-tête).
  const divergent = baseRev === undefined || baseRev !== existingRev;

  if (!(await tx.markApplied(op.opId, ctx.deviceId, now))) {
    throw new AlreadyAppliedError();
  }

  if (op.op === "delete") {
    // A6 — tombstone, jamais de DELETE physique. Le payload d'une suppression
    // est ignoré (seul le constat compte). `rev + 1` ET `updated_at = now` :
    // sinon le curseur de pull (updated_at, id) ne verrait jamais le
    // tombstone et les autres postes garderaient la ligne fantôme.
    const applied: Row = {
      rev: existingRev + 1,
      updatedAt: now,
      deviceId: ctx.deviceId,
      deletedAt: now,
    };
    await tx.writeRow(op.table, rowId, applied, "update");
    return journalConflict(tx, ctx, op, now, divergent, existing, applied, {});
  }

  // Update (ou `insert` reçu sur une ligne existante : LWW s'applique).
  const values: Row = { ...payload };
  for (const key of serverOwned) delete values[key];
  // `createdAt` n'est jamais réécrit par une mise à jour.
  delete values.createdAt;
  if (entry.clinicIdColumn && scopeClinicId !== null) {
    values[entry.clinicIdColumn] = scopeClinicId;
  }

  // VERRO MONTANTS (D-4) : document au-delà de `draft`.
  const protectedFields = PROTECTED_AMOUNT_FIELDS[op.table];
  const stripped: Row = {};
  if (protectedFields && isBeyondDraft(existing.status)) {
    for (const field of protectedFields) {
      if (field in values) {
        stripped[field] = values[field];
        delete values[field];
      }
    }
    // Rétrogradation vers `draft` interdite : sinon le verrou se contourne
    // en deux ops (rétrograder puis réécrire les montants).
    if (values.status === "draft") {
      stripped.status = values.status;
      delete values.status;
    }
  }

  values.rev = existingRev + 1;
  values.updatedAt = now;
  values.deviceId = ctx.deviceId;
  values.deletedAt = null;

  await tx.writeRow(op.table, rowId, values, "update");

  return journalConflict(tx, ctx, op, now, divergent, existing, values, stripped);
}

/**
 * Journalise les conflits d'une opération déjà écrite et renvoie les entrées à
 * reporter dans `PushResponse.conflicts` (visibles côté client).
 *
 * - `base-rev-mismatch` : état appliqué (`winning`) contre état serveur
 *   préalable (`losing`).
 * - `protected-amounts` : montants serveur conservés (`winning`) contre champs
 *   tentés par le client (`losing`) — le verrou a écarté ces champs.
 */
async function journalConflict(
  tx: CentralStoreTx,
  ctx: DeviceTokenContext,
  op: ChangeOp,
  now: Date,
  divergent: boolean,
  existing: Row,
  appliedValues: Row,
  stripped: Row,
): Promise<PushResponse["conflicts"]> {
  const out: PushResponse["conflicts"] = [];

  if (divergent) {
    await tx.insertConflict({
      tableName: op.table,
      rowId: op.rowId,
      deviceId: ctx.deviceId,
      winningPayload: { ...appliedValues },
      losingPayload: serializeRow(op.table, existing),
      reason: "base-rev-mismatch",
      decidedAt: now,
    });
    out.push({ table: op.table, rowId: op.rowId, reason: "base-rev-mismatch" });
  }

  if (Object.keys(stripped).length > 0) {
    const kept: Row = {};
    for (const field of PROTECTED_AMOUNT_FIELDS[op.table] ?? []) {
      if (field in existing) kept[field] = existing[field];
    }
    if ("status" in existing) kept.status = existing.status;
    await tx.insertConflict({
      tableName: op.table,
      rowId: op.rowId,
      deviceId: ctx.deviceId,
      winningPayload: kept,
      losingPayload: stripped,
      reason: "protected-amounts",
      decidedAt: now,
    });
    out.push({ table: op.table, rowId: op.rowId, reason: "protected-amounts" });
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* 6. fetchChanges — tirage paginé                                             */
/* -------------------------------------------------------------------------- */

/**
 * Options de tirage — **aucune n'est active par défaut** : sans `options`,
 * `fetchChanges` se comporte exactement comme avant (identité bit à bit des
 * 587 tests existants).
 *
 * ## `includeAuthBootstrap` (tâche 7.1b) — variante « bootstrap » du tirage
 *
 * ### Périmètre EXACT (trois gardes **cumulatives**, posées à l'émission)
 *
 *  1. **table `user` uniquement** — le test est `candidate.table === "user"` :
 *     aucune autre table du registre, ni aucun enfant en cascadé, n'est
 *     touchée. Un tirage bootstrap contient donc les mêmes lignes qu'un
 *     tirage normal, à la seule différence du champ `passwordHash` porté par
 *     les ops `user` ;
 *  2. **ligne vivante uniquement** — `deleted_at` nul : un tombstone (`op`
 *     `delete`) ne porte **jamais** de hash, quel que soit son état ;
 *  3. **valeur non vide** — si la colonne `passwordHash` est absente (ou une
 *     chaîne vide) sur la ligne brute, **rien** n'est ajouté au payload.
 *
 * ### Ce que l'option NE fait PAS (invariants intacts)
 *
 *  - La liste blanche (`TABLE_REGISTRY`, `FORBIDDEN_PAYLOAD_COLUMNS`) et
 *    `serializeRow` sont **inchangées** : la projection est appelée en amont
 *    et l'option ne fait qu'**ajouter** une clé au résultat **déjà projeté**.
 *    Elle ne court-circuite jamais la liste blanche pour les autres colonnes
 *    (un `email`, un `image`… passent toujours par `serializeRow`) ;
 *  - Le **push** (poste → serveur) reste strictement bloqué : `applyOps`
 *    re-projette chaque payload entrant, aucun poste ne peut rétro-verser un
 *    hash, et cette option ne s'applique jamais au push ;
 *  - Le tirage quotidien (`electron/sync/runner`, route sans `variant`) ne
 *    l'active **jamais** : seules les lignes tirées par
 *    `POST /api/sync/pull` avec `variant: "bootstrap"` (valeur fermée Zod,
 *    jeton d'appareil requis, `clinicId ∈ ctx.clinicIds`) passent par là.
 *
 * ### Pourquoi c'est acceptable (décision 7.1b)
 *
 *  - **La base locale vit sur le poste du cabinet**, déjà détentrice de
 *    TOUTES les données du cabinet (patients, dossiers, factures) et du
 *    dossier `userData` chiffré (DPAPI / chiffrement disque) : le hash y est
 *    exactement aussi exposé que sur le serveur qui l'a généré. Il est de
 *    surcroît **nécessaire** : `src/lib/auth.ts` exige `user.passwordHash`
 *    pour vérifier bcrypt — un poste amorcé sans hash ne pourrait **jamais**
 *    se connecter localement (analyse détaillée dans
 *    `src/app/api/sync/bootstrap/route.ts`, en-tête) ;
 *  - **Un central compromis ne gagne aucun droit nouveau** : il détient déjà
 *    les comptes, vérifie déjà les mots de passe et possède déjà toutes les
 *    données des cabinets ;
 *  - **Le sens poste → serveur reste bloqué** : seul le serveur → poste est
 *    ouvert, une fois, pour l'amorçage (le hash n'est ni journalisé ni
 *    renvoyé par la route de bootstrap).
 */
export interface FetchChangesOptions {
  /**
   * Émet `passwordHash` dans le payload des opérations `user` **vivantes**
   * (variante « bootstrap », serveur → poste uniquement). `undefined` ou
   * `false` : comportement strictement inchangé, aucun hash émis.
   */
  includeAuthBootstrap?: boolean;
}

/**
 * Tirage paginé des changements du central.
 *
 * - **Curseur composite** `(updated_at, id)` global à toutes les tables de
 *   curseur (B1) : jamais `updated_at` seul (deux lignes peuvent partager la
 *   même milliseconde).
 * - **Portée** (B2) : `req.clinicId` doit appartenir à `ctx.clinicIds` (sinon
 *   `SyncScopeError` → 403 côté route) ; chaque table est filtrée sur
 *   `ctx.clinicIds`, puis **re-vérifiée** dans la couche pure.
 * - **Tables de curseur uniquement** (B3) : `pullCursorTables()`. Les enfants
 *   du Groupe B sont ajoutés en **cascadé** (B4) sous chaque ligne parente
 *   vivante, sans compter dans `limit` ni avancer le curseur.
 * - **Tombstones inclus** (B5) : `deleted_at` non nul → op `delete`. `limit`
 *   est borné à `MAX_PULL_LIMIT`, `hasMore` est exact, le curseur renvoyé est
 *   la **dernière ligne** du lot (stable si le lot est vide).
 *
 * @param now horloge **serveur** (validée, échec fermé).
 * @param options **aucune par défaut** — voir {@link FetchChangesOptions}
 *   (variante « bootstrap » : `passwordHash` des lignes `user` vivantes).
 */
export async function fetchChanges(
  ctx: DeviceTokenContext,
  req: PullRequest,
  now: Date,
  repo: CentralStoreRepo = getDefaultRepo(),
  options?: FetchChangesOptions,
): Promise<PullResponse> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("sync/central-store : horloge serveur caduque (now invalide).");
  }
  // Anti-IDOR : le cabinet réclamé doit être dans la portée du jeton.
  if (!ctx.clinicIds.includes(req.clinicId)) {
    throw new SyncScopeError();
  }

  const requestedLimit = req.limit;
  const rawLimit =
    requestedLimit !== undefined && Number.isFinite(requestedLimit)
      ? Math.floor(requestedLimit)
      : DEFAULT_PULL_LIMIT;
  const limit = Math.min(Math.max(1, rawLimit), MAX_PULL_LIMIT);

  const cursor: Cursor = req.cursor ?? MIN_PULL_CURSOR;
  const cursorDate = new Date(cursor.updatedAt);
  if (!Number.isFinite(cursorDate.getTime())) {
    throw new Error("sync/central-store : curseur de tirage invalide.");
  }

  // Portée `user` : une seule requête, réutilisée pour le filtre pure.
  const memberUserIds = await repo.listUserIdsInClinicScope(ctx.clinicIds);

  // (a) Candidats : `limit + 1` par table → `hasMore` exact (si total ≤ limit,
  //     aucune troncature n'a eu lieu ; sinon ≥ limit + 1 lignes existent).
  interface Candidate {
    table: string;
    row: Row;
    scope: PullScope;
  }
  const candidates: Candidate[] = [];
  for (const entry of pullCursorTables()) {
    const scope = pullScopeOf(entry.name, ctx.clinicIds);
    if (!scope) continue; // défensif : jamais tirée.
    const rows = await repo.listChangedRows({
      table: entry.name,
      scope,
      cursor: { updatedAt: cursorDate, id: cursor.id },
      limit: limit + 1,
    });
    for (const row of rows) {
      // B2 — re-vérification pure : une ligne hors portée n'est JAMAIS émise.
      if (!rowWithinScope(entry.name, row, scope, memberUserIds)) continue;
      candidates.push({ table: entry.name, row, scope });
    }
  }

  candidates.sort((a, b) => compareCursorOrder(a.row, b.row));
  const page = candidates.slice(0, limit);
  const hasMore = candidates.length > limit;

  // (b) Cascadé des enfants (B4) : un appel par table enfant pour tout le lot.
  const childrenByParent = new Map<string, Map<string, Row[]>>();
  for (const entry of pullCursorTables()) {
    if (!entry.children?.length) continue;
    const parentIds = page
      .filter((c) => c.table === entry.name && c.row.deletedAt == null)
      .map((c) => String(c.row.id));
    if (parentIds.length === 0) continue;
    for (const childName of entry.children) {
      const rows = await repo.listChildRows({
        childTable: childName,
        parentRowIds: parentIds,
      });
      for (const row of rows) {
        const parentRowId = asNonEmptyString(
          row[CHILD_PARENT_REFS[childName]?.parentKey ?? "id"],
        );
        if (!parentRowId) continue;
        let byTable = childrenByParent.get(entry.name);
        if (!byTable) {
          byTable = new Map();
          childrenByParent.set(entry.name, byTable);
        }
        const bucketKey = `${childName}:${parentRowId}`;
        const bucket = byTable.get(bucketKey) ?? [];
        bucket.push(row);
        byTable.set(bucketKey, bucket);
      }
    }
  }

  // (c) Émission des opérations.
  const changes: ChangeOp[] = [];
  for (const candidate of page) {
    const entry = TABLE_REGISTRY[candidate.table];
    const row = candidate.row;
    const rowId = String(row.id);
    const deleted = row.deletedAt != null;
    const clinicId =
      candidate.scope.kind === "clinic-column"
        ? asNonEmptyString(row[candidate.scope.column])
        : candidate.table === "clinic"
          ? rowId
          : null;

    // B6 : projection liste blanche — `password_hash` ne sort jamais.
    // La projection est TOUJOURS appelée ; l'option ci-dessous ne fait
    // qu'ajouter une clé au résultat déjà projeté (jamais l'inverse).
    const payload = serializeRow(candidate.table, row);

    // 7.1b — variante « bootstrap » : SEULE dérogation au projet, bornée à
    // `user` + ligne vivante + valeur non vide (voir `FetchChangesOptions`).
    if (
      options?.includeAuthBootstrap === true &&
      candidate.table === "user" &&
      !deleted
    ) {
      const passwordHash = row.passwordHash;
      if (typeof passwordHash === "string" && passwordHash.length > 0) {
        payload.passwordHash = passwordHash;
      }
    }

    changes.push({
      opId: crypto.randomUUID(),
      table: candidate.table,
      rowId,
      // B5 : tombstone → `delete` ; sinon `insert` (upsert côté client).
      op: deleted ? "delete" : "insert",
      payload,
      clinicId,
      updatedAt: toIso(row.updatedAt),
      ...(typeof row.rev === "number" ? { rev: row.rev } : {}),
      ...(typeof row.deviceId === "string" ? { deviceId: row.deviceId } : {}),
    });

    // Enfants en cascadé (B4) : uniquement sous un parent VIVANT (un parent
    // supprimé n'a plus de ligne à répliquer localement).
    if (deleted || !entry.children?.length) continue;
    const byTable = childrenByParent.get(candidate.table);
    if (!byTable) continue;
    for (const childName of entry.children) {
      const childRows = byTable.get(`${childName}:${rowId}`) ?? [];
      childRows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      for (const childRow of childRows) {
        changes.push({
          opId: crypto.randomUUID(),
          table: childName,
          rowId: String(childRow.id),
          op: "insert",
          payload: serializeRow(childName, childRow),
          clinicId,
          // Pas de curseur sur les enfants : transportés avec le parent.
          updatedAt: toIso(row.updatedAt),
        });
      }
    }
  }

  // (d) Curseur retourné (B5) : dernière ligne du lot, stable sinon.
  const last = page[page.length - 1];
  const nextCursor: Cursor = last
    ? { updatedAt: toIso(last.row.updatedAt), id: String(last.row.id) }
    : (req.cursor ?? MIN_PULL_CURSOR);

  return { changes, cursor: nextCursor, hasMore };
}

/* -------------------------------------------------------------------------- */
/* 7. Implémentation SQL réelle (Drizzle) — chemin de production               */
/* -------------------------------------------------------------------------- */

/** Instance Drizzle partagée (`src/lib/db/db.ts`). */
export type CentralStoreDb = typeof db;
type CentralStoreTxDb = Parameters<Parameters<CentralStoreDb["transaction"]>[0]>[0];

/**
 * Convertit une valeur de payload vers le type attendu par le driver. Seule
 * inversion nécessaire : les ISO strings client → `Date` pour les colonnes
 * `timestamp` (drizzle appellerait `.toISOString()` sur la valeur brute).
 */
function coerceValue(col: Column, value: unknown): unknown {
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

function coerceRow(table: string, values: Row): Row {
  const entry = TABLE_REGISTRY[table];
  if (!entry) return values;
  const cols = getTableColumns(entry.table) as Record<string, Column>;
  const out: Row = {};
  for (const [key, value] of Object.entries(values)) {
    const col = cols[key];
    out[key] = col ? coerceValue(col, value) : value;
  }
  return out;
}

function createTx(tx: CentralStoreTxDb): CentralStoreTx {
  return {
    async findRow(table, rowId) {
      const entry = TABLE_REGISTRY[table];
      if (!entry) return null;
      const cols = getTableColumns(entry.table) as Record<string, Column>;
      const rows = await tx
        .select()
        .from(entry.table)
        .where(eq(cols.id, rowId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : (row as unknown as Row);
    },

    async writeRow(table, rowId, values, mode) {
      const entry = TABLE_REGISTRY[table];
      if (!entry) {
        throw new Error(`sync/central-store : table « ${table} » inconnue.`);
      }
      const cols = getTableColumns(entry.table) as Record<string, Column>;
      const coerced = coerceRow(table, values);
      if (mode === "insert") {
        await tx.insert(entry.table).values(coerced as never);
      } else {
        const { id: _id, ...patch } = coerced;
        await tx.update(entry.table).set(patch as never).where(eq(cols.id, rowId));
      }
    },

    async markApplied(opId, deviceId, appliedAt) {
      const inserted = await tx
        .insert(syncApplied)
        .values({ opId, deviceId, appliedAt })
        .onConflictDoNothing()
        .returning({ opId: syncApplied.opId });
      return inserted.length > 0;
    },

    async insertConflict(conflict) {
      await tx.insert(syncConflicts).values({
        tableName: conflict.tableName,
        rowId: conflict.rowId,
        deviceId: conflict.deviceId,
        winningPayload: conflict.winningPayload,
        losingPayload: conflict.losingPayload,
        reason: conflict.reason,
        decidedAt: conflict.decidedAt,
      });
    },
  };
}

/**
 * Construit le repo SQL. `database` est injectable (tests d'intégration) ; par
 * défaut c'est l'instance partagée.
 */
export function createCentralStoreDbRepo(
  database: CentralStoreDb = db,
): CentralStoreRepo {
  return {
    async findApplied(opIds) {
      if (opIds.length === 0) return new Set();
      const rows = await database
        .select({ opId: syncApplied.opId })
        .from(syncApplied)
        .where(inArray(syncApplied.opId, opIds));
      return new Set(rows.map((r) => r.opId));
    },

    async listUserIdsInClinicScope(clinicIds) {
      if (clinicIds.length === 0) return new Set();
      const rows = await database
        .select({ userId: clinicMemberships.userId })
        .from(clinicMemberships)
        .where(
          and(
            inArray(clinicMemberships.clinicId, clinicIds),
            isNotNull(clinicMemberships.joinedAt),
            isNull(clinicMemberships.deletedAt),
          ),
        );
      return new Set(rows.map((r) => r.userId));
    },

    async transaction(fn) {
      return database.transaction(async (tx) => fn(createTx(tx)));
    },

    async listChangedRows(query) {
      const entry = TABLE_REGISTRY[query.table];
      if (!entry || !entry.cursor) return [];
      const cols = getTableColumns(entry.table) as Record<string, Column>;
      /* ---------------------- Curseur composite (B1) ------------------------ */
      //
      // ⚠️ 1. NE JAMAIS interpoler le `Date` brut dans le template `sql` :
      // postgres.js appellerait `Buffer.byteLength(Date)` → `TypeError` →
      // `DrizzleQueryError` → **500 sur 100 % des tirages** (régression 10.3).
      // `sql.param(date, cols.updatedAt)` passe par l'encodeur de la colonne
      // (`mapToDriverValue` → `toISOString()`), exactement le chemin de
      // `eq(updatedAt, date)` — jamais de valeur brute.
      //
      // ⚠️ 2. Fuseau : `updated_at` est un `timestamp WITHOUT time zone` et
      // Postgres **ignore** le décalage du littéral `…Z` (vérifié :
      // `'…T12:34:56.789Z'::timestamp` stocke `12:34:56.789`), tandis que
      // Drizzle **relit** le champ mural en UTC (`mapFromDriverValue` ajoute
      // "+0000", parser postgres-js transparent). Écriture et lecture sont donc
      // symétriques : un curseur ISO sorti d'une ligne se recompare à l'identique.
      //
      // ⚠️ 3. PRÉCISION (piège n° 2 du tirage) : la base stocke des
      // **microsecondes** (`defaultNow()` → `now()`) alors qu'un `Date` JS n'a
      // que des millisecondes. Une comparaison `updated_at > Date` ré-émettrait
      // la ligne du curseur à chaque page (`.228051 > .228`) → **boucle
      // infinie**. Le benchmark logique du tirage est donc la milliseconde
      // tronquée :
      //     (date_trunc('millisecond', updated_at), id)
      // — l'ordre **exact** que la couche pure applique déjà (`toTime` /
      // `compareCursorOrder`) et que le repo mémoire implémente (test « deux
      // lignes dans la MÊME millisseconde »). SQL et couche pure partagent le
      // MÊME ordre : aucune ligne répétée, aucune ligne sautée, et le curseur
      // `Date` (milliseconde) est sans perte.
      //
      // `updated_at >= param` est conservé en tête comme bornage de **plage**
      // pour l'index `*_clinic_updated_id` : le tri ne porte que sur ce
      // segment, `date_trunc` n'y figurant qu'en filtre.
      //
      // ⚠️ 4. AMBIGUÏTÉ SIGNALÉE (hors périmètre de ce correctif) : le défaut
      // `defaultNow()` stocke `now()` = **heure locale de la session PG**
      // (`TimeZone = Europe/Paris` → +2 h), alors qu'une écriture Drizzle
      // (`.values({ updatedAt: date })`, `applyOps`) stocke l'**UTC** de la
      // `Date`. Les deux conventions coexistent donc dans la même colonne : le
      // tirage reste exact (la comparaison et le curseur opèrent toujours dans
      // le domaine « champ mural », voisinage et progression garantis — vérifié
      // en E2E), mais l'**ordre absolu** entre une ligne `defaultNow()` et une
      // ligne Drizzle peut être décalé de l'offset du fuseau, et une ligne
      // créée puis mise à jour dans les mêmes 2 h voit son `updated_at`
      // « reculer ». Correction définitive : aligner `defaultNow()` sur UTC
      // (session `SET timezone 'UTC'` ou colonne réécrite en UTC) — migration
      // hors du périmètre de la tâche 10.3.
      const scope = query.scope;
      let scopePredicate;
      if (scope.kind === "clinic-ids") {
        scopePredicate = inArray(cols.id, scope.ids);
      } else if (scope.kind === "user-membership") {
        // Membres actifs : correlated EXISTS sur `clinic_membership`.
        scopePredicate = exists(
          database
            .select()
            .from(clinicMemberships)
            .where(
              and(
                eq(clinicMemberships.userId, cols.id),
                inArray(clinicMemberships.clinicId, scope.clinicIds),
                isNotNull(clinicMemberships.joinedAt),
                isNull(clinicMemberships.deletedAt),
              ),
            ),
        );
      } else {
        scopePredicate = inArray(cols[scope.column], scope.clinicIds);
      }

      const cursorParam = sql.param(query.cursor.updatedAt, cols.updatedAt);
      const truncatedUpdatedAt = sql`date_trunc('millisecond', ${cols.updatedAt})`;
      const cursorPredicate = sql`(${cols.updatedAt} >= ${cursorParam}) and (${truncatedUpdatedAt}, ${cols.id}) > (${cursorParam}, ${query.cursor.id})`;
      const rows = await database
        .select()
        .from(entry.table)
        .where(and(scopePredicate, cursorPredicate))
        .orderBy(asc(truncatedUpdatedAt), asc(cols.id))
        .limit(query.limit);
      return rows as unknown as Row[];
    },

    async listChildRows(query) {
      const ref = CHILD_PARENT_REFS[query.childTable];
      const entry = TABLE_REGISTRY[query.childTable];
      if (!ref || !entry || query.parentRowIds.length === 0) return [];
      const cols = getTableColumns(entry.table) as Record<string, Column>;
      const rows = await database
        .select()
        .from(entry.table)
        .where(inArray(cols[ref.parentKey], query.parentRowIds));
      return rows as unknown as Row[];
    },
  };
}

/** Repo par défaut, construit une seule fois (chemin de production). */
let defaultRepo: CentralStoreRepo | null = null;
function getDefaultRepo(): CentralStoreRepo {
  if (!defaultRepo) {
    defaultRepo = createCentralStoreDbRepo();
  }
  return defaultRepo;
}
