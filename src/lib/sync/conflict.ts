/**
 * Tâche 6.2 — JOURNAL LOCAL DES CONFLITS remontés par le push (décision D-4).
 *
 * Le serveur central arbitre (LWW / règles de montants protégés) et renvoie
 * `PushResponse.conflicts[]` : jusqu'ici l'orchestrateur ne faisait que les
 * **compter**. Ce module les **persiste** dans `sync_conflict` (migration 0020)
 * pour que l'UI de revue humaine puisse montrer « quelle ligne, arbitré
 * comment, par quel poste ».
 *
 * Conception (même style que `outbox.ts` / `device-trust.ts`) :
 *  - logique pure + **repo injecté** (`ConflictRepo`) : tests hermétiques,
 *    repo mémoire en test, Drizzle en production (`createConflictsDbRepo`) ;
 *  - validation Zod de **chaque** entrée avant toute écriture — une entrée
 *    malformée est écartée, jamais journalisée ;
 *  - **aucune écriture brute** : `winning` / `losing` passent par
 *    `serializeRow` (liste blanche du registre) si la table est répliquée, et
 *    les chaînes sont passées au filtre `redactSecretText` — un payload
 *    serveur **compromis** ne peut pas écrire de secret dans le journal local ;
 *  - zéro `console` : ce module ne journalise pas, l'appelant s'en charge.
 *
 * ## Idempotence (choix expliqué)
 *
 * `sync_conflict` ne porte **aucune** contrainte d'unicité (seul un index
 * `(table_name, row_id)` accélère les lectures) : l'idempotence est donc
 * **raisonnable**, pas absolue. Clé de dédoublonnage retenue :
 *
 *     (table, row_id, device_id, bucket de `decided_at` à la minute)
 *
 *  - `findRecent(table, rowId)` s'appuie sur `idx_sync_conflict_table_row`
 *    (pas de scan de table) ;
 *  - la **fenêtre d'une minute** absorbe les rejeux réseau : une réponse de
 *    push rejouée rejoue aussi ses conflits, et le cycle est mutex (aucune
 *    écriture concurrente côté poste) ;
 *  - le `reason` **n'entre pas** dans la clé : une même ligne ne peut être
 *    arbitrée qu'une fois par fenêtre, une seconde raison serait redondante
 *    pour la revue (et multiplierait les lignes à relire) ;
 *  - au-delà de la fenêtre, une nouvelle occurrence est un **nouvel
 *    arbitrage** : elle est journalisée (l'historique compte).
 *
 * ## Sécurité
 *
 *  - Aucun jeton, aucune URL d'origine : `reason` passe par
 *    `redactError` + `redactSecretText` (borné à 500 car.) ;
 *  - Aucune valeur hors liste blanche : projection `serializeRow` puis
 *    bavardage résiduel des chaînes (`token=…`, `Bearer …`,
 *    `scheme://user:pass@…`) remplacé ;
 *  - `DATABASE_URL` ne figure jamais dans le journal.
 */

import { z } from "zod";
import { and, desc, eq, isNull, like, type SQL } from "drizzle-orm";
import { syncConflicts } from "@/lib/db/schema";
import type { DesktopDb } from "@/lib/db/desktop-db";
import { redactError } from "./outbox";
import { getReplicatedTable, serializeRow } from "./protocol";

/* -------------------------------------------------------------------------- */
/* 1. Constantes                                                              */
/* -------------------------------------------------------------------------- */

/** Fenêtre de dédoublonnage : `decided_at` tronqué à la minute (voir en-tête). */
export const CONFLICT_DEDUPE_WINDOW_MS = 60_000;

/** Lignes relues par `findRecent` pour le dédoublonnage (borne indexée). */
export const CONFLICT_MATCH_SCAN_LIMIT = 50;

/** Taille par défaut des listes de revue. */
export const CONFLICT_LIST_DEFAULT_LIMIT = 200;

/** Profondeur maximale parcourue dans un payload (au-delà : valeur non stockée). */
const MAX_PAYLOAD_DEPTH = 6;

/* -------------------------------------------------------------------------- */
/* 2. Types                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Conflit à journaliser. `winning` / `losing` sont **bruts** (ils viennent du
 * réseau ou d'une décision locale) : ils seront projetés avant écriture.
 */
export interface ConflictEntry {
  table: string;
  rowId: string;
  deviceId?: string;
  reason: string;
  winning?: unknown;
  losing?: unknown;
}

/** Ligne `sync_conflict` telle que lue (miroir exact des colonnes). */
export interface ConflictRow {
  id: string;
  table: string;
  rowId: string;
  deviceId: string | null;
  winning: Record<string, unknown> | null;
  losing: Record<string, unknown> | null;
  reason: string | null;
  decidedAt: Date;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

/** Ligne à écrire — `id` facultatif (UUID `crypto.randomUUID()` côté repo). */
export interface NewConflictRow {
  id?: string;
  table: string;
  rowId: string;
  deviceId: string | null;
  winning: Record<string, unknown> | null;
  losing: Record<string, unknown> | null;
  reason: string;
  decidedAt: Date;
}

export interface ConflictFilter {
  /** Nom SQL de la table. */
  table?: string;
  rowId?: string;
  deviceId?: string;
  /** `true` → uniquement les entrées encore à relire (`resolved_at IS NULL`). */
  unresolvedOnly?: boolean;
  /** Préfixe de motif (ex. `merge-review:`) — utilisé par `listPendingMerges`. */
  reasonPrefix?: string;
  /** Bornage, défaut `CONFLICT_LIST_DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * Sous-ensemble du repo nécessaire au **dédoublonnage + insertion**.
 * Exposé séparément pour que `merge.ts` (revue D-5) réutilise `journalConflict`
 * sans dépendre des parties lecture/résolution du journal.
 */
export interface ConflictJournal {
  /** Dernières lignes d'une `(table, rowId)` — index `idx_sync_conflict_table_row`. */
  findRecent(table: string, rowId: string, limit?: number): Promise<ConflictRow[]>;
  insert(row: NewConflictRow): Promise<void>;
}

/** Accès complet à `sync_conflict` (journal + revue humaine). */
export interface ConflictRepo extends ConflictJournal {
  list(filter: ConflictFilter): Promise<ConflictRow[]>;
  /** Marque une entrée résolue (no-op si déjà résolue : le premier arbitrage gagne). */
  resolve(id: string, resolvedBy: string, at: Date): Promise<void>;
}

/** Mode de dédoublonnage de `journalConflict`. */
export type ConflictDedupeMode =
  /** Fenêtre glissante d'une minute (`decided_at` tronqué) — push. */
  | "window"
  /** Une entrée **non résolue** suffit : la file de revue ne se sature pas — fusion D-5. */
  | "unresolved";

export interface JournalOptions {
  mode?: ConflictDedupeMode;
  /** UUID imposé (permet de renvoyer l'identifiant de l'entrée de revue). */
  id?: string;
}

/** Résultat d'une journalisation : `id` = ligne insérée **ou déjà présente**. */
export interface JournalOutcome {
  inserted: boolean;
  id: string;
}

/* -------------------------------------------------------------------------- */
/* 3. Validation Zod                                                           */
/* -------------------------------------------------------------------------- */

/** Longueurs bornées : une entrée hors gabarit n'est jamais écrite. */
export const conflictEntrySchema = z.object({
  table: z.string().min(1).max(64),
  rowId: z.string().min(1).max(256),
  deviceId: z.string().min(1).max(256).optional(),
  reason: z.string().min(1).max(4_000),
  winning: z.unknown().optional(),
  losing: z.unknown().optional(),
});

export const conflictFilterSchema = z.object({
  table: z.string().min(1).max(64).optional(),
  rowId: z.string().min(1).max(256).optional(),
  deviceId: z.string().min(1).max(256).optional(),
  unresolvedOnly: z.boolean().optional(),
  reasonPrefix: z.string().min(1).max(256).optional(),
  limit: z.number().int().positive().max(1_000).optional(),
});

export const resolveConflictParamsSchema = z.object({
  id: z.string().min(1),
  resolvedBy: z.string().min(1).max(256),
  /** Horloge de résolution ; défaut `new Date()` (l'appelant peut la figer en test). */
  resolvedAt: z.date().optional(),
});

export interface ResolveConflictParams {
  id: string;
  resolvedBy: string;
  resolvedAt?: Date;
}

/* -------------------------------------------------------------------------- */
/* 4. Filtrage des secrets                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Retire d'une **chaîne** les fragments sensibles **sans la tronquer** (le
 * millésime s'applique aux valeurs de payload, la raison est tronquée ensuite
 * par `redactError`) : `Bearer …`, `password=`/`token=`/`secret=`/`key=`/
 * `database_url=`, et toute URL portant des identifiants `scheme://user:pass@`.
 */
function redactSecretText(raw: string): string {
  return raw
    .replace(/bearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|passwd|token|secret|authorization|api[-_]?key|key|database_url|db_url)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]+:[^\s/@]+@/gi, "$1://[redacted]@");
}

/** Motif de conflit rédigé et **borné** (`redactError` : 500 car.). */
export function sanitizeConflictReason(raw: string): string {
  return redactError(redactSecretText(raw));
}

/** Applique `redactSecretText` en profondeur (objets/tableaux JSON, cycle-safe). */
function scrubDeep(value: unknown, seen: Set<object>, depth: number): unknown {
  if (typeof value === "string") return redactSecretText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth <= 0 || seen.has(value)) {
    // Fail-closed : au-delà de la profondeur bornée, la valeur n'est pas stockée.
    return null;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, seen, depth - 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = scrubDeep(item, seen, depth - 1);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 5. Projection des payloads                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Projette un payload sur la liste blanche de `TABLE_REGISTRY[table]` puis
 * nettoie les chaînes. Renvoie `null` (stockage interdit) lorsque :
 *  - la table n'est **pas** au registre (payload non maîtrisé → jamais écrit) ;
 *  - la valeur n'est pas un objet simple.
 */
function projectPayload(table: string, payload: unknown): Record<string, unknown> | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!getReplicatedTable(table)) return null;
  let projected: Record<string, unknown>;
  try {
    projected = serializeRow(table, payload as Record<string, unknown>);
  } catch {
    // `serializeRow` refuse (table inconnue côté registre, forme invalide) :
    // défense en profondeur, on n'écrit rien plutôt que du brut.
    return null;
  }
  return scrubDeep(projected, new Set<object>(), MAX_PAYLOAD_DEPTH) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* 6. Écriture idempotente                                                     */
/* -------------------------------------------------------------------------- */

function sameDevice(a: string | null, b: string | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function windowOf(at: Date): number {
  return Math.floor(at.getTime() / CONFLICT_DEDUPE_WINDOW_MS);
}

/**
 * Journalise **UNE** entrée de manière idempotente et renvoie l'identifiant de
 * la ligne (insérée ou déjà présente).
 *
 * Entrée malformée (Zod) → `inserted: false` sans écriture. Le dédoublonnage
 * suit le `mode` : `window` (push, voir en-tête) ou `unresolved` (la file de
 * revue ne doit jamais porter deux fois la même paire non tranchée).
 */
export async function journalConflict(
  journal: ConflictJournal,
  entry: ConflictEntry,
  now: Date,
  options: JournalOptions = {},
): Promise<JournalOutcome> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("sync/conflict : horloge `now` caduque (Date invalide).");
  }
  const parsed = conflictEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return { inserted: false, id: "" };
  }
  const { table, rowId, deviceId, reason } = parsed.data;

  const recent = await journal.findRecent(table, rowId, CONFLICT_MATCH_SCAN_LIMIT);
  const mode = options.mode ?? "window";
  const bucket = windowOf(now);
  const existing = recent.find((row) => {
    if (!sameDevice(row.deviceId, deviceId)) return false;
    if (mode === "unresolved") return row.resolvedAt === null;
    return windowOf(row.decidedAt) === bucket;
  });
  if (existing) {
    return { inserted: false, id: existing.id };
  }

  const id = options.id ?? crypto.randomUUID();
  await journal.insert({
    id,
    table,
    rowId,
    deviceId: deviceId ?? null,
    winning: projectPayload(table, parsed.data.winning),
    losing: projectPayload(table, parsed.data.losing),
    reason: sanitizeConflictReason(reason),
    decidedAt: now,
  });
  return { inserted: true, id };
}

/**
 * Journalise la liste `conflicts[]` d'une réponse de push (D-4).
 *
 * @returns le nombre de lignes **réellement insérées** (les doublons et les
 * entrées malformées sont écartés sans erreur).
 * @throws si `now` est caduque (défaut du contrat « horloge injectée »).
 */
export async function recordPushConflicts(
  repo: ConflictRepo,
  entries: readonly ConflictEntry[],
  now: Date,
): Promise<number> {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("sync/conflict : horloge `now` caduque (Date invalide).");
  }
  let inserted = 0;
  for (const entry of entries) {
    const outcome = await journalConflict(repo, entry, now, { mode: "window" });
    if (outcome.inserted) inserted += 1;
  }
  return inserted;
}

/* -------------------------------------------------------------------------- */
/* 7. Lecture et résolution                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Liste du journal (revue humaine D-4). Filtres optionnels combinés en `AND`,
 * ordre `decided_at` DESC, taille bornée.
 */
export async function listConflicts(
  repo: ConflictRepo,
  filter: ConflictFilter = {},
): Promise<ConflictRow[]> {
  const parsed = conflictFilterSchema.parse(filter);
  return repo.list(parsed);
}

/**
 * Marque une entrée comme résolue par un humain. **Idempotent** : une entrée
 * déjà tranchée conserve son premier résolveur (le repo filtre
 * `resolved_at IS NULL`). Une entrée inconnue est un no-op silencieux —
 * résoler deux fois ou résoudre un identifiant périmé ne doit jamais planter
 * l'UI.
 */
export async function resolveConflict(
  repo: ConflictRepo,
  params: ResolveConflictParams,
): Promise<void> {
  const parsed = resolveConflictParamsSchema.parse(params);
  await repo.resolve(parsed.id, parsed.resolvedBy, parsed.resolvedAt ?? new Date());
}

/* -------------------------------------------------------------------------- */
/* 8. Implémentation SQL (Drizzle) — chemin de production                      */
/* -------------------------------------------------------------------------- */

/**
 * Surface SQL du repo : l'instance du poste **ou** une transaction Drizzle
 * (le journal doit pouvoir s'écrire dans la transaction d'une fusion — D-5).
 * `select` / `insert` / `update` sont les seules opérations utilisées.
 */
export type ConflictSqlDb = Pick<DesktopDb, "select" | "insert" | "update">;

/** Ligne `sync_conflict` → `ConflictRow` (`table_name` ↔ `table`). */
function toConflictRow(row: typeof syncConflicts.$inferSelect): ConflictRow {
  return {
    id: row.id,
    table: row.tableName,
    rowId: row.rowId,
    deviceId: row.deviceId,
    winning: row.winningPayload,
    losing: row.losingPayload,
    reason: row.reason,
    decidedAt: row.decidedAt,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt,
  };
}

/** Échappe les métacaractères `LIKE` (le préfixe vient du code, jamais du réseau). */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Repo Drizzle sur la base **locale du poste** : `sync_conflict` vit côté
 * client (le journal de la même table côté central est alimenté par
 * `central-store.ts`, serveur). Branché par `electron/sync/runner.ts` via
 * `createConflictsDbRepo(getDesktopDb())`.
 *
 * Non couvert par les tests hermétiques (repo mémoire en test) : validé par la
 * suite d'intégration / E2E, comme `local-apply.ts` et `central-store.ts`.
 */
export function createConflictsDbRepo(database: ConflictSqlDb): ConflictRepo {
  return {
    async findRecent(table, rowId, limit = CONFLICT_MATCH_SCAN_LIMIT) {
      const rows = await database
        .select()
        .from(syncConflicts)
        .where(and(eq(syncConflicts.tableName, table), eq(syncConflicts.rowId, rowId)))
        .orderBy(desc(syncConflicts.decidedAt))
        .limit(limit);
      return rows.map(toConflictRow);
    },

    async insert(row) {
      await database.insert(syncConflicts).values({
        id: row.id,
        tableName: row.table,
        rowId: row.rowId,
        deviceId: row.deviceId,
        winningPayload: row.winning,
        losingPayload: row.losing,
        reason: row.reason,
        decidedAt: row.decidedAt,
      });
    },

    async list(filter) {
      const predicates: SQL[] = [];
      if (filter.table !== undefined) predicates.push(eq(syncConflicts.tableName, filter.table));
      if (filter.rowId !== undefined) predicates.push(eq(syncConflicts.rowId, filter.rowId));
      if (filter.deviceId !== undefined) predicates.push(eq(syncConflicts.deviceId, filter.deviceId));
      if (filter.unresolvedOnly === true) predicates.push(isNull(syncConflicts.resolvedAt));
      if (filter.reasonPrefix !== undefined) {
        predicates.push(like(syncConflicts.reason, `${escapeLike(filter.reasonPrefix)}%`));
      }
      const rows = await database
        .select()
        .from(syncConflicts)
        .where(predicates.length > 0 ? and(...predicates) : undefined)
        .orderBy(desc(syncConflicts.decidedAt))
        .limit(filter.limit ?? CONFLICT_LIST_DEFAULT_LIMIT);
      return rows.map(toConflictRow);
    },

    async resolve(id, resolvedBy, at) {
      await database
        .update(syncConflicts)
        .set({ resolvedBy, resolvedAt: at })
        .where(and(eq(syncConflicts.id, id), isNull(syncConflicts.resolvedAt)));
    },
  };
}
