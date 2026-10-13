/**
 * Tâche 5.2a — **Jeton d'appareil côté serveur central** (authentification de
 * la synchronisation).
 *
 * Le poste desktop doit s'authentifier auprès du serveur central pour pousser /
 * tirer des données (étape 5.2b : `POST /api/sync/token`, `/push`, `/pull`,
 * `/health`). Le login local (NextAuth) ne vaut pas côté central : on échange
 * email + mot de passe contre un **jeton d'appareil** aléatoire, présenté ensuite
 * en `Authorization: Bearer <jeton>`.
 *
 * ## Cycle de vie du jeton
 *
 *  - **Émission** (`issueDeviceToken`) : email + mot de passe vérifiés (bcrypt)
 *    → `randomBytes(32).toString("base64url")` renvoyé **une seule fois**, seul
 *    son **SHA-256** est persisté (`device.token_hash`). La fenêtre de validité
 *    est portée par `device.trust_expires_at` (bornée par `trustDays`).
 *  - **Vérification** (`verifyDeviceToken`) : hash du jeton présenté → recherche
 *    par `token_hash` → révocation / expiration → échec fermé.
 *  - **Révocation** : `device.trust_revoked_at` non nul → le jeton meurt
 *    immédiatement (prime sur une expiration encore valide).
 *
 * ## Invariants de sécurité (NON NÉGOCIABLES)
 *
 *  1. **Jamais de secret journalisé** : ni le jeton en clair, ni son hash, ni le
 *     mot de passe. Zéro `console.*` ici.
 *  2. **Anti-énumération** : « email inconnu » et « mot de passe faux » rendent
 *     **exactement** la même raison `invalid-credentials` — et un email inconnu
 *     déclenche quand même une comparaison bcrypt (hash factice) pour uniformiser
 *     le temps de réponse.
 *  3. **Échec fermé** partout : jeton absent/malformé, inconnu, révoqué, expiré,
 *     `trust_expires_at` nul ou `Date` caduque → `null` / refus. Aucun repli.
 *  4. **`device` n'est JAMAIS répliqué** : `token_hash` ne quitte donc jamais le
 *     central — la table `device` est explicitement exclue du registre
 *     `TABLE_REGISTRY` de `src/lib/sync/protocol.ts` (« structure
 *     d'infrastructure, jamais répliquées entre postes »). Le jeton ne peut donc
 *     pas fuiter par la synchronisation.
 *  5. **Comparaison de mot de passe** : toujours via `verifyPassword` de
 *     `src/lib/auth-utils.ts` (bcryptjs) — **jamais** de comparaison en temps
 *     constant manuelle. Voir `createCentralAuthDbRepo().verifyPassword`, qui
 *     l'importe paresseusement (voir note plus bas).
 *
 * ## Testabilité (style `src/lib/offline/device-trust.ts`)
 *
 *  - Toute décision est portée par des fonctions **pures** (`hashDeviceToken`,
 *    `evaluateCentralTrust`).
 *  - L'accès au monde extérieur passe par `CentralAuthRepo`, **injecté** : les
 *    tests hermétiques fournissent un repo mémoire (aucune base, aucun réseau).
 *  - La fonction publique accepte un `repo` optionnel qui, par défaut, est le
 *    repo Drizzle réel (`createCentralAuthDbRepo()`).
 *
 * ## Note d'import (pourquoi `verifyPassword` est importé paresseusement)
 *
 *  `src/lib/auth-utils.ts` importe, en tête de fichier, `@/lib/auth` →
 *  `next-auth` → `next/server`, **non résolvable** hors du bundler Next (un
 *  test Vitest en environnement node pur plante sur cet import). Le repo Drizzle
 *  réel importe donc `verifyPassword` via un `await import("@/lib/auth-utils")`
 *  **au moment de l'appel** : en production le chemin est le même (la fonction
 *  est bien réutilisée, jamais réimplémentée), et les tests hermétiques, qui
 *  injectent un repo mémoire, ne déclenchent jamais cette dynamique.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { clinicMemberships, clinics, devices, users } from "@/lib/db/schema";

/* -------------------------------------------------------------------------- */
/* 1. Types publics                                                            */
/* -------------------------------------------------------------------------- */

/** Contexte d'un jeton d'appareil **valide** — porté jusqu'aux routes sync. */
export interface DeviceTokenContext {
  /** Identifiant de l'appareil (clé du registre `device`). */
  deviceId: string;
  /** Compte propriétaire du jeton. */
  userId: string;
  /** Cabinets accessibles (via `clinic_membership`, actifs) — **verrou anti-IDOR**. */
  clinicIds: string[];
  /** Fin de fenêtre de confiance (même valeur que `device.trust_expires_at`). */
  trustExpiresAt: Date;
}

/** Raisons d'échec d'émission — volontairement génériques (anti-énumération). */
export type CentralAuthFailureReason =
  | "invalid-request"
  | "invalid-credentials"
  | "no-membership"
  | "invalid-trust-days";

export type IssueDeviceTokenResult =
  | { ok: true; token: string; trustExpiresAt: Date }
  | { ok: false; reason: CentralAuthFailureReason };

/** Bornes de `trustDays` — alignées sur `electron/env.ts` (1 … 3650 = 10 ans). */
export const MIN_TRUST_DAYS = 1;
export const MAX_TRUST_DAYS = 3650;

/** Durée d'un jour en ms (calcul de `trust_expires_at`). */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Hash bcrypt **valide** mais ne correspondant à aucun compte réel, utilisé pour
 * que « email inconnu » consomme le même temps de vérification que « mot de passe
 * faux » (contre l'énumération par chronométrage). Sa valeur est sans importance
 * : `bcrypt.compare` renverra `false` sans jamais lever.
 */
const DUMMY_PASSWORD_HASH =
  "$2b$12$PBX4TBwHJqm0bb.xh1O2R.zEUcAo.2YtUUnAzXgmv1ebyqhYFBc4W";

/* -------------------------------------------------------------------------- */
/* 2. Hash du jeton (pur)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * SHA-256 (hex) d'un jeton d'appareil — **fonction pure**, testable
 * hermétiquement. Le jeton en clair n'est stocké nulle part : seul ce hash
 * persiste dans `device.token_hash`.
 */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* 3. Repo injecté (frontière I/O)                                             */
/* -------------------------------------------------------------------------- */

/** Ligne d'utilisateur réduite à ce dont l'émission a besoin. */
export interface CentralAuthUser {
  id: string;
  /** `null` = compte sans mot de passe (ne peut jamais s'authentifier ici). */
  passwordHash: string | null;
}

/** Ligne `device` réduite à ce dont la vérification a besoin. */
export interface CentralAuthDeviceRecord {
  id: string;
  userId: string | null;
  clinicId: string | null;
  trustExpiresAt: Date | null;
  trustRevokedAt: Date | null;
  tokenHash: string | null;
}

/** Paramètres de l'upsert MERGE du `device` (jamais un remplacement). */
export interface UpsertDeviceTokenInput {
  deviceId: string;
  userId: string;
  name: string;
  os: string;
  lastSeenAt: Date;
  trustExpiresAt: Date;
  tokenHash: string;
}

/**
 * Accès au monde extérieur (DB + bcrypt). **Injecté** pour que toute la logique
 * reste testable sans base. L'implémentation SQL réelle est
 * `createCentralAuthDbRepo()` (même fichier, chemin de production).
 */
export interface CentralAuthRepo {
  /** L'utilisateur par email, `null` si inconnu. */
  findUserByEmail(email: string): Promise<CentralAuthUser | null>;
  /** Cabinets **actifs** auxquels l'utilisateur appartient (membership rejoint). */
  listUserClinicIds(userId: string): Promise<string[]>;
  /** Vérification bcrypt — réutilise `verifyPassword` de `auth-utils` en prod. */
  verifyPassword(password: string, hash: string): Promise<boolean>;
  /**
   * Upsert **MERGE** du `device` : préserve `first_seen_at`, met à jour `name`,
   * `os`, `last_seen_at`, `trust_expires_at`, `user_id`, `token_hash`, et **lève
   * délibérément** `trust_revoked_at` (voir commentaire dans l'implémentation).
   */
  upsertDeviceToken(input: UpsertDeviceTokenInput): Promise<void>;
  /** appareil porteur d'un `token_hash` donné, `null` si absent. */
  findDeviceByTokenHash(tokenHash: string): Promise<CentralAuthDeviceRecord | null>;
}

/* -------------------------------------------------------------------------- */
/* 4. Décision pure de vérification                                            */
/* -------------------------------------------------------------------------- */

/**
 * Applique l'échec fermé sur une ligne `device` déjà trouvée par `token_hash`.
 * **Pure** (aucune I/O) — séparée pour la testabilité.
 *
 * Ordre de priorité :
 *  1. ligne absente                    → `null`
 *  2. `trustRevokedAt` non nul         → `null` (la révocation prime sur tout)
 *  3. `userId` nul (compte supprimé)   → `null`
 *  4. expiry nulle / passée / caduque  → `null` (fail-closed)
 *  5. sinon → contexte valide.
 */
function evaluateCentralTrust(
  record: CentralAuthDeviceRecord | null,
  clinicIds: string[],
  now: Date,
): DeviceTokenContext | null {
  if (!record) {
    return null;
  }
  if (record.trustRevokedAt) {
    return null;
  }
  const userId = record.userId;
  if (!userId) {
    return null;
  }
  const expiresAt = record.trustExpiresAt;
  const nowTs = now.getTime();
  if (
    !expiresAt ||
    !Number.isFinite(nowTs) ||
    !Number.isFinite(expiresAt.getTime()) ||
    nowTs >= expiresAt.getTime()
  ) {
    // Fail-closed : horloge fausse (NaN) ou fenêtre close → refus déterministe.
    return null;
  }
  return {
    deviceId: record.id,
    userId,
    clinicIds,
    trustExpiresAt: expiresAt,
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Émission                                                                 */
/* -------------------------------------------------------------------------- */

/** Schéma Zod des champs « request » (hors `trustDays`, validé à part). */
const issueRequestSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
  deviceId: z.string().trim().min(1),
  deviceName: z.string().trim().min(1),
  os: z.string().trim().min(1),
  now: z.date().refine((d) => Number.isFinite(d.getTime())),
});

export interface IssueDeviceTokenParams {
  email: string;
  password: string;
  deviceId: string;
  deviceName: string;
  os: string;
  trustDays: number;
  now: Date;
}

/** Repo par défaut, construit une seule fois (chemin de production). */
let defaultRepo: CentralAuthRepo | null = null;
function getDefaultRepo(): CentralAuthRepo {
  if (!defaultRepo) {
    defaultRepo = createCentralAuthDbRepo();
  }
  return defaultRepo;
}

/**
 * Émet un jeton d'appareil après avoir vérifié l'identité.
 *
 * - `trustDays` hors `[1, 3650]` → `invalid-trust-days` (contrôlé **avant** toute
 *   vérification d'identité : c'est une erreur de requête, pas un secret).
 * - email/mot de passe/champs manquants ou `now` caduque → `invalid-request`.
 * - email inconnu **ou** mot de passe faux → `invalid-credentials` (raison
 *   **identique** : anti-énumération ; un email inconnu déclenche quand même une
 *   comparaison bcrypt sur `DUMMY_PASSWORD_HASH` pour uniformiser le temps).
 * - identité OK mais aucun `clinic_membership` actif → `no-membership`.
 * - succès : upsert MERGE du `device` + jeton renvoyé **une fois**.
 */
export async function issueDeviceToken(
  params: IssueDeviceTokenParams,
  repo: CentralAuthRepo = getDefaultRepo(),
): Promise<IssueDeviceTokenResult> {
  // (a) `trustDays` borné [1, 3650] — entier strict.
  if (
    !Number.isInteger(params.trustDays) ||
    params.trustDays < MIN_TRUST_DAYS ||
    params.trustDays > MAX_TRUST_DAYS
  ) {
    return { ok: false, reason: "invalid-trust-days" };
  }

  // (b) Validation Zod du reste de la requête.
  const parsed = issueRequestSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, reason: "invalid-request" };
  }
  const { email, password, deviceId, deviceName, os, now } = parsed.data;

  // (c) Identification.
  const user = await repo.findUserByEmail(email);
  if (!user || !user.passwordHash) {
    // Email inconnu (ou compte sans mot de passe) : on consomme quand même une
    // comparaison bcrypt pour ne pas être détectable par chronométrage.
    await repo.verifyPassword(password, DUMMY_PASSWORD_HASH);
    return { ok: false, reason: "invalid-credentials" };
  }
  const passwordOk = await repo.verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    return { ok: false, reason: "invalid-credentials" };
  }

  // (d) Autorisation : le compte doit appartenir à au moins un cabinet actif.
  const clinicIds = await repo.listUserClinicIds(user.id);
  if (clinicIds.length === 0) {
    return { ok: false, reason: "no-membership" };
  }

  // (e) Génération + persistance du hash seul.
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashDeviceToken(token);
  const trustExpiresAt = new Date(now.getTime() + params.trustDays * DAY_MS);

  await repo.upsertDeviceToken({
    deviceId,
    userId: user.id,
    name: deviceName,
    os,
    lastSeenAt: now,
    trustExpiresAt,
    tokenHash,
  });

  // Le jeton en clair n'est renvoyé qu'ici, jamais stocké ni journalisé.
  return { ok: true, token, trustExpiresAt };
}

/* -------------------------------------------------------------------------- */
/* 6. Vérification                                                             */
/* -------------------------------------------------------------------------- */

/** Jeton « plausible » : non vide et charset base64url (défense en profondeur). */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * Vérifie un jeton présenté (`Authorization: Bearer <jeton>`).
 *
 * - jeton manquant / malformé (vide, charset inattendu) → `null` **sans** requête ;
 * - inconnu (hash absent) → `null` ;
 * - `trust_revoked_at` non nul → `null` (la révocation prime) ;
 * - `trust_expires_at` nul, passée ou caduque → `null` (fail-closed) ;
 * - `userId` nul → `null`.
 *
 * Renvoie le contexte complet (`clinicIds` de l'utilisateur via
 * `clinic_membership`) — c'est cette liste qui servira de **verrou anti-IDOR**
 * sur `/pull` : chaque `clinicId` demandé doit y appartenir.
 */
export async function verifyDeviceToken(
  token: string,
  now: Date,
  repo: CentralAuthRepo = getDefaultRepo(),
): Promise<DeviceTokenContext | null> {
  if (typeof token !== "string" || token.length === 0 || !TOKEN_SHAPE.test(token)) {
    return null;
  }
  const tokenHash = hashDeviceToken(token);
  const record = await repo.findDeviceByTokenHash(tokenHash);
  if (!record) {
    return null;
  }
  if (record.trustRevokedAt || !record.userId) {
    return null;
  }
  const clinicIds = await repo.listUserClinicIds(record.userId);
  return evaluateCentralTrust(record, clinicIds, now);
}

/* -------------------------------------------------------------------------- */
/* 7. Implémentation SQL réelle (Drizzle) — chemin de production               */
/* -------------------------------------------------------------------------- */

/** Instance Drizzle partagée (`src/lib/db/db.ts`) — injectable pour les tests d'intégration. */
export type CentralAuthDb = typeof db;

/**
 * Construit le repo SQL. `database` est injectable (tests d'intégration) ; par
 * défaut c'est l'instance partagée.
 *
 * `verifyPassword` importe **paresseusement** `@/lib/auth-utils` : cet module
 * charge `@/lib/auth` → `next-auth` → `next/server`, non résolvable hors du
 * bundler Next. L'import dynamique déplace ce coût au premier appel réel (jamais
 * atteint par les tests hermétiques, qui injectent un repo mémoire) tout en
 * **réutilisant** la fonction existante — jamais réimplémentée.
 */
export function createCentralAuthDbRepo(
  database: CentralAuthDb = db,
): CentralAuthRepo {
  return {
    async findUserByEmail(email: string): Promise<CentralAuthUser | null> {
      const rows = await database
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : { id: row.id, passwordHash: row.passwordHash };
    },

    async listUserClinicIds(userId: string): Promise<string[]> {
      const rows = await database
        .select({ clinicId: clinicMemberships.clinicId })
        .from(clinicMemberships)
        .innerJoin(clinics, eq(clinicMemberships.clinicId, clinics.id))
        .where(
          and(
            eq(clinicMemberships.userId, userId),
            isNotNull(clinicMemberships.joinedAt),
            isNull(clinicMemberships.deletedAt),
            isNull(clinics.deletedAt),
          ),
        );
      return rows.map((r) => r.clinicId);
    },

    async verifyPassword(password: string, hash: string): Promise<boolean> {
      const { verifyPassword } = await import("@/lib/auth-utils");
      return verifyPassword(password, hash);
    },

    async upsertDeviceToken(input: UpsertDeviceTokenInput): Promise<void> {
      await database
        .insert(devices)
        .values({
          id: input.deviceId,
          userId: input.userId,
          name: input.name,
          os: input.os,
          firstSeenAt: input.lastSeenAt,
          lastSeenAt: input.lastSeenAt,
          trustExpiresAt: input.trustExpiresAt,
          tokenHash: input.tokenHash,
          // À l'INSERT (poste inconnu) : aucune révocation.
          trustRevokedAt: null,
        })
        .onConflictDoUpdate({
          target: devices.id,
          set: {
            userId: input.userId,
            name: input.name,
            os: input.os,
            lastSeenAt: input.lastSeenAt,
            trustExpiresAt: input.trustExpiresAt,
            tokenHash: input.tokenHash,
            // LEVÉE DÉLIBÉRÉE de la révocation : c'est une **ré-authentification
            // en ligne** avec des identifiants valides. Contrairement à
            // `grantTrust` local (qui ne lève jamais une révocation — seul le
            // central le peut), ici le central EST l'autorité et l'échange en
            // ligne réussi est précisément l'acte qui autorise un nouveau jeton.
            // Une révocation antérieure ne doit pas empêcher l'utilisateur de
            // re-créer un appareil en se reconnectant volontairement.
            trustRevokedAt: null,
            updatedAt: input.lastSeenAt,
            // `first_seen_at`, `clinic_id`, `rev`, `created_at`, `last_sync_at`
            // ne sont PAS dans le SET : préservés sur une ligne existante
            // (upsert MERGE, jamais un remplacement).
          },
        });
    },

    async findDeviceByTokenHash(
      tokenHash: string,
    ): Promise<CentralAuthDeviceRecord | null> {
      const rows = await database
        .select({
          id: devices.id,
          userId: devices.userId,
          clinicId: devices.clinicId,
          trustExpiresAt: devices.trustExpiresAt,
          trustRevokedAt: devices.trustRevokedAt,
          tokenHash: devices.tokenHash,
        })
        .from(devices)
        .where(eq(devices.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        id: row.id,
        userId: row.userId,
        clinicId: row.clinicId,
        trustExpiresAt: row.trustExpiresAt,
        trustRevokedAt: row.trustRevokedAt,
        tokenHash: row.tokenHash,
      };
    },
  };
}
