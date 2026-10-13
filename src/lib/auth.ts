import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import os from "node:os";
import { db } from "@/lib/db/db";
import * as schema from "@/lib/db/schema";
import { verifyPassword } from "@/lib/auth-utils";
import {
  checkTrust,
  grantTrust,
  isCentralReachable,
} from "@/lib/offline/device-trust";
import { createDeviceTrustRepo } from "@/lib/offline/device-trust-db";
import { and, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Limitation de débit (brute-force) — fenêtre glissante sur `login_attempt`
//
// DEUX plafonds indépendants, car ils répondent à deux menaces distinctes :
//
// • PAR COMPTE (5 échecs / 15 min) : SANS blocage net. Au-delà du seuil, un
//   BACKOFF PROGRESSIF (2 s, doublant par échec supplémentaire, plafonné à
//   60 s) retarde la vérification du mot de passe mais ne la refuse jamais.
//   Un verrouillage « 5 échecs = hors 15 min » est en effet un DoS que
//   n'importe qui inflige à une adresse connue : 5 requêtes sur
//   `dentiste@cabinet.dz` et le praticien est dehors, même avec le BON mot de
//   passe. Ici il n'existe aucun état de refus PAR COMPTE : le titulaire du
//   bon mot de passe entre toujours (il attend 2-4 s au lieu d'être exclu), et
//   un succès de connexion réinitialise le compteur. L'attaquant ne peut donc
//   plus cibler un praticien précis.
//
//   ⚠️ Nuance importante : un refus DUR subsiste sur l'axe IP. Partager la
//   IP publique de l'attaquat (NAT d'un cabinet, CGNAT d'opérateur) fait
//   échouer la connexion avec le BON mot de passe, jusqu'à 15 min. Le DoS
//   n'est donc pas supprimé : il a changé d'axe, du ciblé-précis (connaître
//   l'email suffisait) au non-ciblé-mais-large (il faut partager l'IP). C'est
//   un meilleur arbitrage, pas une elimination. Un succès de connexion
//   réinitialise le compteur du compte.
//
// • PAR IP (50 échecs / 15 min) : plafond DUR, c'est le vrai frein au spray
//   et à l'énumération « 5 essais par adresse, puis on passe à l'adresse
//   suivante, depuis une seule IP, des milliers de fois ». Un IP ne dépasse
//   pas 50 tentatives / 15 min quel que soit le nombre de comptes visés.
//
// ⚠️ L'IP est lue dans `x-forwarded-for`, en-tête SPOOFABLE. La collecte est
// inchangée, mais la limitation par IP n'est fiable que DERRIÈRE UN PROXY DE
// CONFIANCE qui écrase/ajoute cette en-tête ; en accès direct, un attaquant
// peut la falsifier pour faire bondir son propre plafond. Ne jamais traiter
// l'IP comme une preuve d'identité : ici, frein à l'automatisation +
// forensique uniquement.
// ---------------------------------------------------------------------------
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_FAILURE_LIMIT = 5;
const ACCOUNT_BACKOFF_BASE_MS = 2 * 1000;
const ACCOUNT_BACKOFF_MAX_MS = 60 * 1000;
const IP_FAILURE_LIMIT = 50;
// Purge des tentatives > 24 h : borne la croissance de la table (les plafonds
// ne portent que sur les 15 dernières minutes). `login_attempt` n'a pas
// d'index sur `created_at` seul → un DELETE à CHAQUE connexion serait un
// scan complet ; on purge donc au plus une fois par heure et par process.
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
// Bornage de la lecture de fenêtre (1 requête, au plus N lignes).
const RECENT_ATTEMPTS_ROW_CAP = 500;

let lastAttemptPurgeAt = 0;

// ---------------------------------------------------------------------------
// Confiance d'appareil (étape 3.2 — D-8)
//
// Deux modes distingués par `SYNC_BASE_URL` (décision d'architecture D-A) :
//
// • `DEVICE_ID` absent (web Vercel, dev local, desktop sans identifiant
//   d'appareil) OU `SYNC_BASE_URL` absente (serveur central inexistant avant
//   l'étape 5) → **aucun contrôle**, comportement strictement identique à
//   aujourd'hui, avec un avertissement **unique par process** lorsque la
//   confiance est présente mais non opposable. Imposer la confiance maintenant
//   interdirait tout login.
// • `SYNC_BASE_URL` présente (desktop en production) → contrôle actif :
//   central joignable → `grantTrust` (fenêtre de 30 j ouverte/renouvelée,
//   échec fermé si la ligne est révoquée) ; central injoignable →
//   `checkTrust` (une fenêtre encore valide est exigée, sinon refus).
//
// Le contrôle s'applique **uniquement après** une vérification bcrypt
// réussie — jamais avant, jamais à la place du rate-limiting. Aucun secret
// (hash, mot de passe, `AUTH_SECRET`, `DATABASE_URL`) n'est journalisé : seuls
// la décision, l'appareil, le compte et la raison le sont.
// ---------------------------------------------------------------------------
/** `TRUST_DAYS` : durée par défaut de la fenêtre de confiance (jours). */
const TRUST_DAYS_DEFAULT = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Avertissement « confiance non opposable » émis au plus une fois par process. */
let trustNotEnforceableWarned = false;

/**
 * Durée de la fenêtre de confiance en millisecondes. `TRUST_DAYS` absent →
 * 30 j ; invalide (non entier, nul ou négatif) → repli sur 30 j **avec
 * journalisation** : la fenêtre reste bornée, et le desktop rejette déjà une
 * valeur invalide au démarrage (`electron/env.ts`), ce qui rend ce repli
 * inatteignable hors configuration bricolée à la main.
 */
function resolveTrustTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return TRUST_DAYS_DEFAULT * MS_PER_DAY;
  }
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    console.warn(
      `[auth] TRUST_DAYS invalide : repli sur ${TRUST_DAYS_DEFAULT} j.`,
    );
    return TRUST_DAYS_DEFAULT * MS_PER_DAY;
  }
  return days * MS_PER_DAY;
}

/** Résultat du contrôle de confiance appliqué dans `authorize`. */
type DeviceTrustGateResult =
  | { ok: true }
  | { ok: false; reason: string };

interface DeviceTrustGateParams {
  readonly deviceId: string;
  readonly syncBaseUrl: string;
  readonly userId: string;
}

/**
 * Applique le mode D-A pour un login dont le mot de passe est déjà validé :
 * en ligne → renouvelle la confiance (30 j) puis autorise ; hors-ligne →
 * n'autorise que si la fenêtre ouverte reste valide. `grantTrust` ne lève
 * jamais une révocation : un poste révoqué est donc refusé même en ligne,
 * jusqu'à ce que le serveur central (étape 5) lève la coupure.
 */
async function authorizeDeviceTrust(
  params: DeviceTrustGateParams,
): Promise<DeviceTrustGateResult> {
  const repo = createDeviceTrustRepo(db);
  const now = new Date();
  if (await isCentralReachable(params.syncBaseUrl)) {
    const decision = await grantTrust(
      repo,
      {
        deviceId: params.deviceId,
        userId: params.userId,
        name: os.hostname(),
        os: process.platform,
        ttlMs: resolveTrustTtlMs(process.env.TRUST_DAYS),
      },
      now,
    );
    return decision.ok ? { ok: true } : { ok: false, reason: decision.reason };
  }
  const decision = await checkTrust(repo, params.deviceId, params.userId, now);
  return decision.ok
    ? { ok: true }
    : { ok: false, reason: `hors-ligne:${decision.reason}` };
}


export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        const email = credentials.email as string;
        const ipAddress =
          request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          request?.headers?.get("x-real-ip") ||
          undefined;

        const now = Date.now();

        // Purge opportuniste des entrées > 24 h (au plus 1×/h par process).
        if (now - lastAttemptPurgeAt >= PURGE_INTERVAL_MS) {
          lastAttemptPurgeAt = now;
          await db
            .delete(schema.loginAttempts)
            .where(
              lt(schema.loginAttempts.createdAt, new Date(now - ATTEMPT_RETENTION_MS))
            );
        }

        // Une seule lecture de fenêtre : les échecs concernant ce compte OU
        // cette IP (les deux compteurs sont dérivés en mémoire). Les succès
        // sont inclus pour « vider » le compteur d'un compte au dernier succès
        // de CE compte, sans effacer les lignes d'historique (forensique +
        // export propriétaire).
        const scope: SQL<unknown>[] = [eq(schema.loginAttempts.email, email)];
        if (ipAddress) scope.push(eq(schema.loginAttempts.ipAddress, ipAddress));

        const recentAttempts = await db.query.loginAttempts.findMany({
          where: and(
            gt(schema.loginAttempts.createdAt, new Date(now - FAILURE_WINDOW_MS)),
            or(...scope)
          ),
          columns: {
            email: true,
            ipAddress: true,
            successful: true,
            createdAt: true,
          },
          // Du plus récent au plus ancien : le premier succès rencontré pour
          // ce compte neutralise les échecs plus anciens que lui.
          orderBy: desc(schema.loginAttempts.createdAt),
          limit: RECENT_ATTEMPTS_ROW_CAP,
        });

        let emailFailures = 0;
        let ipFailures = 0;
        let lastEmailSuccessAt: Date | null = null;
        for (const attempt of recentAttempts) {
          if (
            attempt.successful &&
            attempt.email === email &&
            (lastEmailSuccessAt === null || attempt.createdAt > lastEmailSuccessAt)
          ) {
            lastEmailSuccessAt = attempt.createdAt;
            continue;
          }
          if (attempt.successful) continue;
          if (
            attempt.email === email &&
            (lastEmailSuccessAt === null || attempt.createdAt > lastEmailSuccessAt)
          ) {
            emailFailures++;
          }
          if (ipAddress && attempt.ipAddress === ipAddress) ipFailures++;
        }

        // Plafond DUR par IP : rejet avant toute lecture utilisateur / vérif
        // bcrypt.
        //
        // ⚠️ AUCUNE écriture sur ce chemin, volontairement. Journaliser chaque
        // tentative bloquée créerait une amplification : l'attaquant ne paie
        // qu'un SELECT + un INSERT (bcrypt évité) mais gonfle la table que le
        // défenseur relit à chaque connexion — coût attaquant constant, coût
        // défenseur croissant. Et le blocage tient déjà 15 min grâce aux 50
        // échecs RÉELS déjà présents, sans avoir besoin d'une ligne de plus.
        if (ipAddress && ipFailures >= IP_FAILURE_LIMIT) {
          return null;
        }

        // Backoff progressif par compte — le substitut du blocage net (cf.
        // commentaire en tête de fichier : aucun état de « compte verrouillé »,
        // le bon mot de passe reste toujours accepté).
        if (emailFailures >= ACCOUNT_FAILURE_LIMIT) {
          const exponent = Math.min(emailFailures - ACCOUNT_FAILURE_LIMIT, 16);
          const delayMs = Math.min(
            ACCOUNT_BACKOFF_BASE_MS * 2 ** exponent,
            ACCOUNT_BACKOFF_MAX_MS
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }

        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.email, email),
        });

        let valid = false;
        if (user?.passwordHash) {
          valid = await verifyPassword(credentials.password as string, user.passwordHash);
        }

        await db.insert(schema.loginAttempts).values({
          email,
          ipAddress,
          successful: valid,
        });

        if (!user || !valid) return null;

        // Contrôle de confiance d'appareil (étape 3.2, mode D-A) — atteint
        // **uniquement** après une vérification bcrypt réussie. `DEVICE_ID`
        // absent (web Vercel, dev local) → comportement strictement inchangé.
        const deviceId = process.env.DEVICE_ID;
        if (deviceId) {
          const syncBaseUrl = process.env.SYNC_BASE_URL;
          if (!syncBaseUrl) {
            // Confiance présente mais non opposable (serveur central inexistant
            // avant l'étape 5) : un refus ici interdirait tout login — on
            // autorise, avec un avertissement unique par process.
            if (!trustNotEnforceableWarned) {
              trustNotEnforceableWarned = true;
              console.warn(
                `[auth] confiance d'appareil non opposable (SYNC_BASE_URL absente) : login autorisé sans contrôle ` +
                  `(device=${deviceId}, userId=${user.id}).`,
              );
            }
          } else {
            try {
              const trust = await authorizeDeviceTrust({
                deviceId,
                syncBaseUrl,
                userId: user.id,
              });
              if (!trust.ok) {
                console.warn(
                  `[auth] login refusé (device=${deviceId}, userId=${user.id}, raison=${trust.reason}).`,
                );
                return null;
              }
            } catch (error) {
              // Échec fermé : une erreur d'infrastructure (table `device`
              // injoignable…) ne doit jamais laisser entrer un poste dont la
              // confiance n'a pas pu être vérifiée. Message seul, jamais de
              // détail de connexion.
              console.error(
                `[auth] login refusé (device=${deviceId}, userId=${user.id}, raison=infra: ${
                  error instanceof Error ? error.message : String(error)
                }).`,
              );
              return null;
            }
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { passwordHash, ...userWithoutPassword } = user;
        return userWithoutPassword;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Connexion : on fige la version de jeton du compte dans le JWT.
        // `user` provient de `authorize` (ligne complète moins passwordHash).
        const { emailVerified, tokenVersion } = user as {
          emailVerified?: Date | null;
          tokenVersion?: number;
        };
        token.id = user.id;
        token.emailVerified = emailVerified ? emailVerified.toISOString() : null;
        token.tokenVersion = typeof tokenVersion === "number" ? tokenVersion : 0;
        return token;
      }

      if (!token.id) return token;

      // Compatibilité : un jeton émis avant l'ajout de la colonne n'a pas de
      // `tokenVersion` ; il est traité comme la version 0 (valeur par défaut en
      // base), donc il continue de fonctionner — pas de déconnexion massive au
      // déploiement — mais il sera révoqué au prochain changement de mot de passe.
      const tokenVersion =
        typeof token.tokenVersion === "number" ? token.tokenVersion : 0;

      // Une seule requête, réutilisée à la fois pour rafraîchir `emailVerified`
      // (comportement historique) et pour re-vérifier la version de jeton.
      const dbUser = await db.query.users.findFirst({
        where: (users, { eq }) => eq(users.id, token.id as string),
        columns: { emailVerified: true, tokenVersion: true },
      });

      // Compte supprimé, ou mot de passe changé depuis l'émission du jeton
      // (changePassword / resetPassword incrémentent tokenVersion) : on rejette
      // la session. NextAuth v5 typant `jwt` en `Awaitable<null | JWT>`,
      // retourner `null` invalide le jeton et la session devient non authentifiée.
      if (!dbUser) return null;
      if (tokenVersion !== dbUser.tokenVersion) return null;

      token.emailVerified = dbUser.emailVerified
        ? dbUser.emailVerified.toISOString()
        : null;
      token.tokenVersion = dbUser.tokenVersion;
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        (session.user as { emailVerified?: string | null }).emailVerified =
          token.emailVerified as string | null | undefined;
      }
      return session;
    },
  },
});
