import { bigint, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { clinics } from "./tenant";

/**
 * D-8 — Registre des appareils (`device`) et modèle de confiance.
 *
 * L'application de bureau fonctionne **hors-ligne** : la base locale contient les
 * utilisateurs et bcrypt tourne localement, le login local n'a donc jamais besoin
 * du réseau. Cette table est le contrôle qui empêche un poste de s'authentifier
 * indéfiniment hors-ligne. Elle sert à la fois de registre local et, aux étapes
 * 4.4 / 5, de réplique côté serveur central.
 *
 * Rôle de chaque colonne :
 * - `id` : identifiant stable du poste, généré côté app (jamais auto-incrémenté),
 *   il est la clé de la confiance et doit survivre aux réinstallations.
 * - `trustExpiresAt` : **cœur de D-8** — fenêtre de confiance locale (30 j par
 *   défaut), renouvelée uniquement lors d'un échange en ligne (`grantTrust`).
 *   Nulle ou dépassée → login hors-ligne refusé (reason `expired`).
 * - `trustRevokedAt` : coupure posée par le serveur central. **Prime sur tout** :
 *   aucun octroi local ne la lève, seul le serveur peut le faire (sync étapes 4/5).
 * - `userId` : compte qui a ouvert la session sur ce poste. `onDelete: "set null"`
 *   → la suppression d'un compte ne doit pas supprimer la trace de l'appareil.
 *   Un changement de compte sans nouvel échange en ligne est refusé
 *   (reason `user-mismatch`) : un device n'est pas transmissible entre comptes.
 * - `clinicId` : nullable car peut être inconnu au premier login (poste
 *   hors-réseau ou compte non encore rattaché), renseigné ensuite. FK
 *   `set null` (convention du projet, cf. `audit.ts`) : la suppression d'une
 *   clinique au central ne doit pas supprimer la trace de l'appareil, comme
 *   pour `userId`. La table est neuve et vide : la FK est sans risque ici.
 * - `firstSeenAt` / `lastSeenAt` : empreinte de fréquentation ; `firstSeenAt`
 *   n'est jamais modifié après la création de la ligne.
 * - `lastSyncAt` : renseigné à l'étape 5 (pull/push vers le central).
 * - `rev` : compteur **monotone attribué côté serveur**, préparation de la
 *   résolution de conflits par curseur (étapes 4/5). Ne jamais l'incrémenter
 *   côté app.
 * - `updatedAt` / `createdAt` : audit standard du projet.
 *
 * Index : `(clinic_id, updated_at, id)` = curseur de pull futur ; `user_id` pour
 * les recherches « appareils d'un compte ».
 */
export const devices = pgTable(
  "device",
  {
    id: text("id").primaryKey(),
    clinicId: text("clinic_id").references(() => clinics.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    os: text("os").notNull(),
    firstSeenAt: timestamp("first_seen_at", { mode: "date" }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date" }).defaultNow().notNull(),
    lastSyncAt: timestamp("last_sync_at", { mode: "date" }),
    trustExpiresAt: timestamp("trust_expires_at", { mode: "date" }),
    trustRevokedAt: timestamp("trust_revoked_at", { mode: "date" }),
    // Tâche 5.2a — jeton d'appareil du serveur central (authentification sync).
    // SHA-256 du jeton d'appareil — JAMAIS répliqué (`device` est exclue du
    // registre `TABLE_REGISTRY` de `src/lib/sync/protocol.ts`), JAMAIS journalisé.
    // Le jeton en clair n'est renvoyé qu'une fois à l'émission ; seul son hash
    // est stocké. Valide tant que `trustExpiresAt` court et `trustRevokedAt` est nul.
    tokenHash: text("token_hash"),
    rev: bigint("rev", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    createdAt: timestamp("created_at", { mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_devices_clinic_updated_id").on(table.clinicId, table.updatedAt, table.id),
    index("idx_devices_user_id").on(table.userId),
  ],
);
