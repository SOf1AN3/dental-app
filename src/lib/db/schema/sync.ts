import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Tables du MOTEUR DE SYNCHRONISATION (tâche 4.2) — à ne pas confondre avec les
 * colonnes de curseur ajoutées aux tables métier par la tâche 4.1.
 *
 * Rôle de chacune :
 *
 *  - `sync_outbox`   — FILE D'ATTENTE des mutations : chaque écriture locale est
 *                      journalisée ici (même transaction) puis poussée au
 *                      central, en ordre `seq`, avec retry (`attempts`).
 *  - `sync_state`    — CURSEURS & COMPTEURS clé→valeur : `last_pull_cursor`,
 *                      `last_push_at`, compteur `seq` du poste, etc.
 *  - `sync_conflict` — JOURNAL DES CONFLITS : chaque arbitrage (LWW / règle D-4)
 *                      y dépose les deux payloads pour la revue humaine (UI).
 *  - `sync_merge`    — FUSIONS DE DOUBLONS (D-5) : trace « ce doublon a été
 *                      rattaché à ce canonique », purge après D jours.
 *  - `sync_applied`  — ADMISSIONS DU PUSH côté central : chaque `op_id` n'est
 *                      appliqué qu'une seule fois (idempotence du retry réseau).
 *
 * Localisation (indiquée aussi sur chaque table) :
 *  - `sync_outbox`, `sync_state`, `sync_conflict`, `sync_merge` vivent sur le
 *    POSTE LOCAL (PostgreSQL embarqué Electron).
 *  - `sync_applied` vit uniquement sur le SERVEUR CENTRAL (Vercel).
 *
 * ⚠️ Aucune clé étrangère vers les tables métier : ces journaux doivent survivre
 * aux purges, aux réinitialisations et aux suppressions de lignes (sinon on ne
 * pourrait plus expliquer/rejouer une opération dont la donnée d'origine a
 * disparu). Identifiants en `text` (uuid générés côté app), payloads en `jsonb`.
 *
 * Note type : la spec évoquait `timestamptz`, mais **toutes** les colonnes de
 * temps du projet (`created_at` / `updated_at` / `deleted_at`, 0019 et avant)
 * sont en `timestamp` (sans fuseau). La 0020 est la 1ère migration jamais
 * appliquée : on aligne donc ces colonnes sur la convention existante plutôt
 * que d'introduire un second type de temps dans le schéma.
 */

// POSTE LOCAL — file d'attente des mutations à pousser au central.
export const syncOutbox = pgTable(
  "sync_outbox",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    op: text("op").$type<"insert" | "update" | "delete">().notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    deviceId: text("device_id"),
    // Croissant par poste : impose l'ordre parent→enfant au push.
    seq: bigint("seq", { mode: "number" }).default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
    status: text("status").$type<"pending" | "sent" | "failed">().default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    clinicId: text("clinic_id"),
  },
  (table) => [
    index("idx_sync_outbox_status_seq").on(table.status, table.seq),
    index("idx_sync_outbox_clinic_status").on(table.clinicId, table.status),
  ],
);

// POSTE LOCAL — curseurs et compteurs partagés (last_pull_cursor, last_push_at…).
export const syncState = pgTable("sync_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow().notNull(),
});

// POSTE LOCAL — journal des conflits, visible dans l'UI de revue (D-4).
export const syncConflicts = pgTable(
  "sync_conflict",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tableName: text("table_name").notNull(),
    rowId: text("row_id").notNull(),
    deviceId: text("device_id"),
    winningPayload: jsonb("winning_payload").$type<Record<string, unknown>>(),
    losingPayload: jsonb("losing_payload").$type<Record<string, unknown>>(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { mode: "date" }).defaultNow().notNull(),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { mode: "date" }),
  },
  (table) => [
    index("idx_sync_conflict_table_row").on(table.tableName, table.rowId),
    index("idx_sync_conflict_decided_at").on(table.decidedAt),
  ],
);

// POSTE LOCAL — doublons patients fusionnés (D-5) : un doublon ne peut être
// rattaché qu'une fois à un canonique (index unique).
export const syncMerges = pgTable(
  "sync_merge",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tableName: text("table_name").notNull(),
    canonicalId: text("canonical_id").notNull(),
    duplicateId: text("duplicate_id").notNull(),
    reason: text("reason"),
    mergedAt: timestamp("merged_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("uq_sync_merge_duplicate_id").on(table.duplicateId)],
);

// SERVEUR CENTRAL UNIQUEMENT — idempotence du push : une `op_id` n'est appliquée
// qu'une seule fois, quel que soit le nombre de rejeux réseau.
export const syncApplied = pgTable(
  "sync_applied",
  {
    opId: text("op_id").primaryKey(),
    deviceId: text("device_id"),
    appliedAt: timestamp("applied_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [index("idx_sync_applied_device_applied_at").on(table.deviceId, table.appliedAt)],
);
