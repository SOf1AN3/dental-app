/**
 * D-8 / étape 3.2 — Implémentation **SQL réelle** de `DeviceTrustRepo`
 * (Drizzle + table `device`), utilisée par `src/lib/auth.ts`.
 *
 * ⚠️ Contrat le plus sensible du fichier : `upsert` est un **MERGE**, jamais un
 * remplacement. Un upsert « remplaçant » écraserait `trust_revoked_at` à
 * `NULL` = **fail-open** (une révocation posée par le serveur central
 * disparaîtrait au moindre octroi local). Trois invariants, garantis ici
 * colonne par colonne :
 *
 * 1. `first_seen_at` : **absent de la clause `DO UPDATE SET`** → figé à la
 *    création de la ligne, aucune écriture ne peut le modifier.
 * 2. Colonne **omise** dans le `patch` : la valeur insérée serait `NULL` (ou un
 *    placeholder NOT NULL pour `name`/`os`) — chaque colonne mergeable est donc
 *    écrite sous la forme `COALESCE(excluded.col, "device".col)` : le `NULL`
 *    de l'exclusion laisse la valeur existante **intacte**.
 * 3. `trust_revoked_at` : `COALESCE` **inversé** —
 *    `COALESCE("device".trust_revoked_at, excluded.trust_revoked_at)` — la
 *    révocation existante **prime sur toute valeur ultérieure** : un upsert ne
 *    peut que **poser** une révocation (quand la colonne est encore nulle, cas
 *    de `revokeTrustLocally`), jamais la lever ni la dater autrement. Seul le
 *    serveur central lèvera la coupure (sync étape 5).
 *
 * Note `name`/`os` (NOT NULL sans défaut DB) : le `INSERT` utilise des
 * placeholders (`unknown-host`/`unknown`, idem repo mémoire des tests) — un
 * `COALESCE(excluded.name, …)` écraserait le vrai nom d'hôte avec le
 * placeholder, ces deux colonnes ne sont donc mises à jour **que si le patch
 * les fournit** (`SET name = excluded.name` conditionnel). C'est la même
 * sémantique « omis → jamais effacé », adaptée à une colonne non nullable.
 *
 * `rev`, `created_at` et `last_sync_at` ne sont **jamais** touchés ici (`rev`
 * est attribué côté serveur central, `last_sync_at` relève de l'étape 5).
 */

import { eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { db } from "@/lib/db/db";
import { devices } from "@/lib/db/schema";
import type {
  DeviceTrustPatch,
  DeviceTrustRecord,
  DeviceTrustRepo,
} from "./device-trust";

/** Instance Drizzle partagée (`src/lib/db/db.ts`) — injectable pour les tests. */
export type DeviceTrustDb = typeof db;

/** Placeholders d'insertion pour `name`/`os` (colonnes NOT NULL sans défaut). */
const UNKNOWN_HOST = "unknown-host";
const UNKNOWN_OS = "unknown";

/** Ligne SQL → record du domaine (miroir exact de `DeviceTrustRecord`). */
function toRecord(row: typeof devices.$inferSelect): DeviceTrustRecord {
  return {
    id: row.id,
    userId: row.userId,
    clinicId: row.clinicId,
    name: row.name,
    os: row.os,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    trustExpiresAt: row.trustExpiresAt,
    trustRevokedAt: row.trustRevokedAt,
  };
}

/**
 * Construit le repo SQL. `database` est injectable (tests d'intégration) ;
 * par défaut c'est l'instance partagée consommée par `src/lib/auth.ts`.
 */
export function createDeviceTrustRepo(
  database: DeviceTrustDb = db,
): DeviceTrustRepo {
  return {
    async get(deviceId: string): Promise<DeviceTrustRecord | null> {
      const rows = await database
        .select()
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toRecord(row);
    },

    async upsert(
      deviceId: string,
      patch: DeviceTrustPatch,
    ): Promise<DeviceTrustRecord> {
      const now = new Date();
      // Horodatage d'insertion : `lastSeenAt` du patch s'il est fourni, sinon
      // `now` (le repo mémoire des tests fait pareil).
      const seenAt = patch.lastSeenAt ?? now;

      const values: typeof devices.$inferInsert = {
        id: deviceId,
        name: patch.name ?? UNKNOWN_HOST,
        os: patch.os ?? UNKNOWN_OS,
        firstSeenAt: seenAt,
        lastSeenAt: seenAt,
      };
      if (patch.userId !== undefined) values.userId = patch.userId;
      if (patch.clinicId !== undefined) values.clinicId = patch.clinicId;
      if (patch.trustExpiresAt !== undefined) {
        values.trustExpiresAt = patch.trustExpiresAt;
      }
      if (patch.trustRevokedAt !== undefined) {
        values.trustRevokedAt = patch.trustRevokedAt;
      }

      // MERGE colonne par colonne — voir l'en-tête du fichier.
      // `excluded.x` = valeur qui aurait été insérée (NULL si le patch l'omet).
      const set: PgUpdateSetSource<typeof devices> = {
        updatedAt: now,
        lastSeenAt: sql`coalesce(excluded.last_seen_at, ${devices.lastSeenAt})`,
        userId: sql`coalesce(excluded.user_id, ${devices.userId})`,
        clinicId: sql`coalesce(excluded.clinic_id, ${devices.clinicId})`,
        trustExpiresAt: sql`coalesce(excluded.trust_expires_at, ${devices.trustExpiresAt})`,
        // COALESCE inversé : la révocation existante prime — jamais levée,
        // jamais redatée par un octroi local.
        trustRevokedAt: sql`coalesce(${devices.trustRevokedAt}, excluded.trust_revoked_at)`,
        // `first_seen_at` est volontairement absent : inaltérable.
        // `name`/`os` : uniquement si le patch les fournit (un placeholder
        // NOT NULL ne doit jamais écraser une valeur connue).
      };
      if (patch.name !== undefined) set.name = sql`excluded.name`;
      if (patch.os !== undefined) set.os = sql`excluded.os`;

      const rows = await database
        .insert(devices)
        .values(values)
        .onConflictDoUpdate({ target: devices.id, set })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        // Inatteignable en pratique (INSERT … ON CONFLICT DO UPDATE … RETURNING
        // renvoie toujours la ligne cible) : signalé plutôt que `undefined!`.
        throw new Error(
          `device-trust-db : l'upsert de « ${deviceId} » n'a renvoyé aucune ligne.`,
        );
      }
      return toRecord(row);
    },

    async touch(deviceId: string, at: Date): Promise<void> {
      // `updated_at` est également re-stampé automatiquement par Drizzle
      // (`$onUpdate`) : simple horodatage d'audit. `first_seen_at`, `rev`,
      // `last_sync_at` et la confiance ne sont jamais touchés.
      await database
        .update(devices)
        .set({ lastSeenAt: at })
        .where(eq(devices.id, deviceId));
    },
  };
}
