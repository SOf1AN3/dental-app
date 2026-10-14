/**
 * Tâche 5.2d — **Limitation de débit de `POST /api/sync/token`**.
 *
 * `issueDeviceToken` exécute une vérification bcrypt à CHAQUE requête. Sans
 * limitation, la route est à la fois un vecteur de brute-force (email + mot de
 * passe) et d'amplification de coût : le paiement bcrypt est supporté par le
 * serveur, pas par l'attaquant. Le login web (`src/lib/auth.ts`) en a déjà une ;
 * ce module aligne l'API de synchronisation sur les mêmes règles **sans
 * modifier `auth.ts`**.
 *
 * ## Journal forensique partagé : `login_attempt`
 *
 *  Le compteur réutilise la table `login_attempt` du login web (déjà indexée
 *  `idx_login_attempts_email_ip_time`) : c'est le MÊME journal forensique, ce
 *  qui produit volontairement une **réciprocité** — un brute-force passé par
 *  l'API de sync fait grimper le compteur d'échecs du même compte au login web
 *  (backoff de `auth.ts`), et les échecs du login web bloquent aussi
 *  `/api/sync/token`. Chaque tentative est tracée avec le **vrai** email
 *  (forensique) et un `denied_reason` préfixé `sync-token:`.
 *
 * ## Règles (alignées sur `src/lib/auth.ts`)
 *
 *  • **par compte** : ≥ 5 échecs (`successful = false`) pour cet email sur les
 *    15 dernières minutes → refus (`allowed: false, reason: "account"`) ;
 *  • **par IP** : ≥ 50 échecs pour cette IP sur 15 minutes → refus
 *    (`reason: "ip"`) ;
 *  • **un succès réinitialise le compteur du compte** (les lignes
 *    `successful = true` neutralisent les échecs plus anciennes du même
 *    compte, sans être supprimées : forensique + export propriétaire) ;
 *  • fenêtre **glissante** : une tentative sortie de la fenêtre de 15 min ne
 *    compte plus ;
 *  • lecture **bornée** à `RECENT_ATTEMPTS_ROW_CAP` lignes (1 requête) ;
 *  • purge des lignes > 24 h **au plus une fois par heure et par process**
 *    (mémoire statique `lastAttemptPurgeAt`), comme `auth.ts` —
 *    `login_attempt` n'a pas d'index sur `created_at` seul.
 *
 * ## Différence assumée avec `auth.ts` : blocage NET par compte
 *
 *  `auth.ts` remplace le blocage par compte par un backoff progressif pour
 *  éviter qu'un attaquant ne verrouille un praticien connu (DoS : 5 requêtes
 *  et le titulaire du BON mot de passe est dehors 15 min). Pour l'API de
 *  sync, le refus d'entrée en était demandé : le coût du DoS y est
 *  considérablement réduit — il ne touche que l'échange de jeton poste
 *  desktop (le login WEB reste toujours accessible, soumis au seul backoff de
 *  `auth.ts`), il dure au pire une fenêtre glissante de 15 min, et il suppose
 *  de cibler l'email exact d'un compte. C'est un arbitrage conscient, pas une
 *  omission.
 *
 * ## Limites connues (documentées, comme dans `auth.ts`)
 *
 *  ⚠️ L'IP est lue dans `x-forwarded-for` / `x-real-ip`, des en-têtes
 *  **spoofables**. La collecte est inchangée, mais la limitation par IP n'est
 *  fiable que DERRIÈRE UN PROXY DE CONFIANCE qui écrase/ajoute ces en-têtes ;
 *  en accès direct, un attaquant peut les falsifier pour faire bondir son
 *  plafond. Ne jamais traiter l'IP comme une preuve d'identité : ici, frein à
 *  l'automatisation + forensique uniquement.
 *
 * ## Testabilité (style `src/lib/sync/central-auth.ts`)
 *
 *  Toute décision est portée par `checkTokenThrottle` / `recordTokenAttempt`,
 *  qui ne connaissent du monde extérieur que `TokenThrottleRepo` (injecté) :
 *  les tests hermétiques fournissent un repo mémoire — **aucune base, aucun
 *  réseau**. L'implémentation SQL réelle est `createTokenThrottleDbRepo(db)`,
 *  appelée par la route avec l'instance Drizzle partagée.
 *
 *  Aucun secret n'est journalisé ni renvoyé : ni mot de passe, ni jeton, ni
 *  hash — seuls l'email (forensique, comme `auth.ts`), l'IP et la raison le
 *  sont.
 */

import { and, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import { loginAttempts } from "@/lib/db/schema";
import type { db as SharedDb } from "@/lib/db/db";

/** Instance Drizzle partagée (`src/lib/db/db.ts`) — injectée par la route. */
export type TokenThrottleDb = typeof SharedDb;

/* -------------------------------------------------------------------------- */
/* Constantes — alignées sur `src/lib/auth.ts` (fichier inchangé)             */
/* -------------------------------------------------------------------------- */

/** Fenêtre glissante des tentatives prises en compte. */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Échecs **du même compte** au-delà desquels la requête est refusée. */
const ACCOUNT_FAILURE_LIMIT = 5;
/** Échecs **de la même IP** au-delà desquels la requête est refusée. */
const IP_FAILURE_LIMIT = 50;
/** Rétention forensique : les lignes plus vieilles sont purgées. */
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Purge opportuniste au plus 1×/h/process (pas d'index sur `created_at` seul). */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** Bornage de la lecture de fenêtre : 1 requête, au plus N lignes. */
const RECENT_ATTEMPTS_ROW_CAP = 500;

/** Dernière purge effectuée (horloge `Date.now()`), mémoire **statique**. */
let lastAttemptPurgeAt = 0;

/* -------------------------------------------------------------------------- */
/* Types publics                                                               */
/* -------------------------------------------------------------------------- */

/** Raison d'un refus par le throttle. */
export type TokenThrottleReason = "account" | "ip";

/** Ligne `login_attempt` réduite à ce dont le décompte a besoin. */
export interface TokenThrottleAttempt {
  readonly email: string;
  readonly ipAddress: string | null;
  readonly successful: boolean;
  readonly createdAt: Date;
}

/** Paramètres de `checkTokenThrottle`. */
export interface TokenThrottleCheckParams {
  /** **Vrai** email de la requête (forensique) — déjà validé par la route. */
  readonly email: string;
  /** IP lue dans `x-forwarded-for` / `x-real-ip` (en-têtes spoofables). */
  readonly ipAddress: string | undefined;
  /** Horloge **serveur** — jamais l'horloge client. */
  readonly now: Date;
}

/** Décision du throttle — la route en déduit un `429 { error: "throttled" }`. */
export interface TokenThrottleCheckResult {
  readonly allowed: boolean;
  readonly reason?: TokenThrottleReason;
}

/** Paramètres de `recordTokenAttempt`. */
export interface TokenThrottleRecordParams {
  readonly email: string;
  readonly ipAddress: string | undefined;
  readonly successful: boolean;
  /** `sync-token:<raison>` — ex. `sync-token:invalid-credentials`. */
  readonly deniedReason?: string | undefined;
  readonly now: Date;
}

/* -------------------------------------------------------------------------- */
/* Repo injecté (frontière I/O)                                                */
/* -------------------------------------------------------------------------- */

export interface TokenThrottleListParams {
  readonly since: Date;
  readonly email: string;
  readonly ipAddress: string | undefined;
  readonly limit: number;
}

export interface TokenThrottleInsertParams {
  readonly email: string;
  readonly ipAddress: string | undefined;
  readonly successful: boolean;
  readonly deniedReason: string | null;
  readonly createdAt: Date;
}

/**
 * Accès au journal `login_attempt` — **injecté** pour que toute la décision
 * reste testable sans base ni réseau. Implémentation SQL réelle :
 * `createTokenThrottleDbRepo`.
 */
export interface TokenThrottleRepo {
  /** Purge des lignes antérieures à `cutoff` (rétention > 24 h). */
  purgeAttemptsOlderThan(cutoff: Date): Promise<void>;
  /** Tentatives de la fenêtre concernant ce compte **ou** cette IP, plus récentes d'abord. */
  listRecentAttempts(
    params: TokenThrottleListParams,
  ): Promise<readonly TokenThrottleAttempt[]>;
  /** Écriture d'une tentative (forensique). */
  insertAttempt(params: TokenThrottleInsertParams): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Décision                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Purge opportuniste des tentatives > 24 h — au plus une fois par heure et par
 * process. Une erreur de purge n'empêche **jamais** la décision de throttle :
 * c'est une optimisation de taille de table, pas un contrôle de sécurité (seul
 * le nom de l'erreur est journalisé, jamais son message).
 */
async function purgeIfNeeded(
  repo: TokenThrottleRepo,
  nowMs: number,
): Promise<void> {
  if (!Number.isFinite(nowMs) || nowMs - lastAttemptPurgeAt < PURGE_INTERVAL_MS) {
    return;
  }
  lastAttemptPurgeAt = nowMs;
  try {
    await repo.purgeAttemptsOlderThan(new Date(nowMs - ATTEMPT_RETENTION_MS));
  } catch (error) {
    console.error(
      `[sync/token-throttle] purge opportuniste échouée (raison=${
        error instanceof Error ? error.name : "unknown"
      })`,
    );
  }
}

/**
 * Vérifie les deux plafonds (compte puis IP) sur la fenêtre glissante.
 *
 * Une **seule lecture** de fenêtre porte les deux décomptes : les échecs
 * concernant ce compte OU cette IP. Les succès sont inclus, mais uniquement
 * pour « vider » le compteur d'un compte au dernier succès de CE compte (les
 * lignes historiques ne sont jamais effacées).
 *
 * Échec fermé : si le repo lève (base injoignable…), l'erreur remonte — la
 * route convertit alors la requête en `500 internal-error`, **jamais** en
 * token émis.
 */
export async function checkTokenThrottle(
  repo: TokenThrottleRepo,
  params: TokenThrottleCheckParams,
): Promise<TokenThrottleCheckResult> {
  const { email, ipAddress } = params;
  const nowMs = params.now.getTime();

  await purgeIfNeeded(repo, nowMs);

  const recentAttempts = await repo.listRecentAttempts({
    since: new Date(nowMs - FAILURE_WINDOW_MS),
    email,
    ipAddress,
    limit: RECENT_ATTEMPTS_ROW_CAP,
  });

  let emailFailures = 0;
  let ipFailures = 0;
  let lastEmailSuccessAt: Date | null = null;

  // Ordre décroissant (du plus récent au plus ancien) : le premier succès
  // rencontré pour ce compte neutralise TOUS les échecs plus anciens que lui.
  for (const attempt of recentAttempts) {
    if (
      attempt.successful &&
      attempt.email === email &&
      (lastEmailSuccessAt === null ||
        attempt.createdAt.getTime() > lastEmailSuccessAt.getTime())
    ) {
      lastEmailSuccessAt = attempt.createdAt;
      continue;
    }
    if (attempt.successful) continue;
    if (
      attempt.email === email &&
      (lastEmailSuccessAt === null ||
        attempt.createdAt.getTime() > lastEmailSuccessAt.getTime())
    ) {
      emailFailures++;
    }
    if (ipAddress !== undefined && attempt.ipAddress === ipAddress) {
      ipFailures++;
    }
  }

  if (emailFailures >= ACCOUNT_FAILURE_LIMIT) {
    return { allowed: false, reason: "account" };
  }
  if (ipAddress !== undefined && ipFailures >= IP_FAILURE_LIMIT) {
    return { allowed: false, reason: "ip" };
  }
  return { allowed: true };
}

/**
 * Journalise une tentative (réussie ou refusée) dans `login_attempt`, avec son
 * `denied_reason` préfixé `sync-token:` et l'horloge **serveur**. Aucun secret
 * n'est passé à cette fonction : email, IP et raison seulement.
 */
export async function recordTokenAttempt(
  repo: TokenThrottleRepo,
  params: TokenThrottleRecordParams,
): Promise<void> {
  await repo.insertAttempt({
    email: params.email,
    ipAddress: params.ipAddress,
    successful: params.successful,
    deniedReason: params.deniedReason ?? null,
    createdAt: params.now,
  });
}

/* -------------------------------------------------------------------------- */
/* Implémentation SQL réelle (Drizzle) — chemin de production                  */
/* -------------------------------------------------------------------------- */

/**
 * Repo Drizzle sur `login_attempt`. Requêtes **paramétrées** (`eq`/`and`/`or`
 * Drizzle) : aucun formatage SQL manuel, aucune injection possible. La
 * contrainte est injectée par la route (`createTokenThrottleDbRepo(db)`).
 */
export function createTokenThrottleDbRepo(
  database: TokenThrottleDb,
): TokenThrottleRepo {
  return {
    async purgeAttemptsOlderThan(cutoff: Date): Promise<void> {
      await database
        .delete(loginAttempts)
        .where(lt(loginAttempts.createdAt, cutoff));
    },

    async listRecentAttempts(
      params: TokenThrottleListParams,
    ): Promise<readonly TokenThrottleAttempt[]> {
      const scope: SQL<unknown>[] = [eq(loginAttempts.email, params.email)];
      if (params.ipAddress !== undefined) {
        scope.push(eq(loginAttempts.ipAddress, params.ipAddress));
      }
      return database.query.loginAttempts.findMany({
        where: and(
          gt(loginAttempts.createdAt, params.since),
          or(...scope),
        ),
        columns: {
          email: true,
          ipAddress: true,
          successful: true,
          createdAt: true,
        },
        orderBy: desc(loginAttempts.createdAt),
        limit: params.limit,
      });
    },

    async insertAttempt(params: TokenThrottleInsertParams): Promise<void> {
      await database.insert(loginAttempts).values({
        email: params.email,
        ipAddress: params.ipAddress ?? null,
        successful: params.successful,
        deniedReason: params.deniedReason,
        createdAt: params.createdAt,
      });
    },
  };
}
