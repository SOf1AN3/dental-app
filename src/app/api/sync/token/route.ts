import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { devices } from "@/lib/db/schema";
import {
  MAX_TRUST_DAYS,
  MIN_TRUST_DAYS,
  createCentralAuthDbRepo,
  issueDeviceToken,
  type CentralAuthRepo,
  type IssueDeviceTokenParams,
  type IssueDeviceTokenResult,
} from "@/lib/sync/central-auth";
import {
  checkTokenThrottle,
  createTokenThrottleDbRepo,
  recordTokenAttempt,
  type TokenThrottleCheckParams,
  type TokenThrottleCheckResult,
  type TokenThrottleRecordParams,
  type TokenThrottleRepo,
} from "@/lib/sync/token-throttle";

/**
 * Tâche 5.2c — `POST /api/sync/token` : échange email + mot de passe contre un
 * **jeton d'appareil** (voir `src/lib/sync/central-auth.ts` pour le cycle de
 * vie complet).
 *
 * Contrat :
 *  - corps `{ email, password, deviceId, deviceName, os, trustDays? }`,
 *    validé par Zod ;
 *  - `now` vient **TOUJOURS du serveur** — l'horloge client ne doit jamais
 *    décaler la fenêtre de confiance ;
 *  - `200 { token, trustExpiresAt }` ; sinon `400` (`invalid-request`,
 *    `invalid-trust-days`) / `401` (`invalid-credentials`) / `403`
 *    (`no-membership`, `device-bound-to-another-user`) / `429` (`throttled`).
 *
 * ## Limitation de débit (tâche 5.2d)
 *
 *  `issueDeviceToken` paie un bcrypt à chaque requête : sans limitation, la
 *  route est un vecteur de brute-force et d'amplification de coût. Deux
 *  plafonds alignés sur `src/lib/auth.ts` (fichier inchangé), portés par le
 *  MÊME journal forensique `login_attempt` :
 *
 *  • ≥ 5 échecs pour cet email sur 15 min → `429` ;
 *  • ≥ 50 échecs pour cette IP sur 15 min → `429`.
 *
 *  Le contrôle est posé **avant** toute vérification bcrypt (c'est justement
 *  lui qui évite de la payer), la tentative est **toujours** journalisée
 *  (`sync-token:throttled`, `sync-token:invalid-credentials`, etc. — les
 *  refus liés à la POLITIQUE après un mot de passe pourtant valide sont
 *  journalisés `successful = true`, exactement comme la gate de confiance
 *  d'appareil de `auth.ts`, pour ne pas pénaliser un utilisateur légitime).
 *  Voir `src/lib/sync/token-throttle.ts` (règles, limites, spoofabilité de
 *  `x-forwarded-for`).
 *
 * ## Garde anti-détournement d'appareil (mineur 5.2a #3)
 *
 *  L'upsert MERGE de `issueDeviceToken` écraserait `user_id` / `token_hash`
 *  d'un `deviceId` déjà rattaché à **un autre** compte : un attaquant possédant
 *  un compte valide pourrait ainsi « voler » l'appareil d'une victime (son
 *  jeton serait révoqué et le sien prendrait la main). Sans modifier
 *  `central-auth.ts`, la garde est posée **ici**, en enveloppant le repo : le
 *  `upsertDeviceToken` exécuté par `issueDeviceToken` est intercepté et refuse
 *  (`403 device-bound-to-another-user`) si la ligne `device` existante appartient
 *  à un autre `userId`.
 *
 *  L'enveloppe s'exécute **après** la vérification de l'identité et de
 *  l'appartenance (logique interne à `issueDeviceToken`) : un mot de passe
 *  faux rend toujours `401`, jamais un oracle « cet appareil appartient à
 *  quelqu'un ». Un `deviceId` inconnu, ou dont `user_id` est nul, est
 *  librement rattachable.
 */

export const dynamic = "force-dynamic";

/**
 * `trustDays` par défaut (30 j) — aligné sur `DEFAULT_TRUST_DAYS` de
 * `electron/env.ts` (constante copiée : `electron/` n'est jamais importé par
 * le serveur web).
 */
const DEFAULT_TRUST_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Schéma de la requête                                                        */
/* -------------------------------------------------------------------------- */

const tokenRequestSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
  deviceId: z.string().trim().min(1),
  deviceName: z.string().trim().min(1),
  os: z.string().trim().min(1),
  trustDays: z
    .number()
    .int()
    .min(MIN_TRUST_DAYS)
    .max(MAX_TRUST_DAYS)
    .optional(),
});

type TokenRequest = z.infer<typeof tokenRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Repo injecté (frontière I/O) + garde anti-détournement                      */
/* -------------------------------------------------------------------------- */

/** Ligne `device` minimale lue par la garde (rattachement d'un `deviceId`). */
export interface DeviceBindingRecord {
  id: string;
  userId: string | null;
}

/** Lookup du rattachement d'un appareil — injectable (tests hermétiques). */
export type FindDeviceBinding = (
  deviceId: string,
) => Promise<DeviceBindingRecord | null>;

/**
 * `deviceId` déjà rattaché à un **autre** compte : la route répond `403
 * device-bound-to-another-user` sans jamais toucher à la ligne `device`.
 */
class DeviceBoundError extends Error {
  constructor() {
    super("api/sync/token : deviceId déjà rattaché à un autre compte.");
    this.name = "DeviceBoundError";
  }
}

/**
 * Enveloppe le repo d'identité d'une **garde** sur `upsertDeviceToken` :
 * refus si la ligne `device` existante appartient à un autre `userId`. Aucune
 * écriture n'a alors eu lieu (jeton de l'appareil intact).
 */
function guardDeviceBinding(
  repo: CentralAuthRepo,
  findDeviceBinding: FindDeviceBinding,
): CentralAuthRepo {
  return {
    ...repo,
    async upsertDeviceToken(input) {
      const existing = await findDeviceBinding(input.deviceId);
      if (
        existing &&
        existing.userId !== null &&
        existing.userId !== input.userId
      ) {
        throw new DeviceBoundError();
      }
      await repo.upsertDeviceToken(input);
    },
  };
}

/** Repo par défaut (Drizzle), construit paresseusement (chemin de production). */
let defaultAuthRepo: CentralAuthRepo | null = null;
function getDefaultAuthRepo(): CentralAuthRepo {
  if (!defaultAuthRepo) {
    defaultAuthRepo = createCentralAuthDbRepo();
  }
  return defaultAuthRepo;
}

/** Repo de throttle par défaut (Drizzle sur `login_attempt`) — chemin de production. */
let defaultThrottleRepo: TokenThrottleRepo | null = null;
function getDefaultThrottleRepo(): TokenThrottleRepo {
  if (!defaultThrottleRepo) {
    defaultThrottleRepo = createTokenThrottleDbRepo(db);
  }
  return defaultThrottleRepo;
}

/**
 * IP du client : `x-forwarded-for` (premier saut) puis `x-real-ip`.
 *
 * ⚠️ En-têtes **spoofables** — la limitation par IP n'est fiable que derrière
 * un proxy de confiance (documenté dans `token-throttle.ts`, comme dans
 * `auth.ts`). Ici : frein à l'automatisation + forensique, jamais une preuve
 * d'identité.
 */
export function resolveClientIp(request: Request): string | undefined {
  const forwarded = request.headers.get("x-forwarded-for");
  const firstHop = forwarded?.split(",")[0]?.trim();
  return firstHop || request.headers.get("x-real-ip") || undefined;
}

/**
 * Lookup réel de la garde : `device.user_id` pour un `deviceId` donné.
 * Requête **paramétrée** (Drizzle/`eq`), aucun formatage SQL manuel.
 */
const findDeviceBindingDb: FindDeviceBinding = async (deviceId) => {
  const rows = await db
    .select({ id: devices.id, userId: devices.userId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { id: row.id, userId: row.userId };
};

/* -------------------------------------------------------------------------- */
/* Réponses                                                                   */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "invalid-request" | "invalid-trust-days" | "invalid-credentials" | "no-membership" | "device-bound-to-another-user" | "throttled" | "internal-error",
  status: number,
): Response {
  return NextResponse.json({ error }, { status });
}

/**
 * Journalise la tentative dans `login_attempt` **sans jamais faire échouer la
 * réponse** : une écriture forensique tombée (table saturée…) ne doit pas
 * priver un poste légitime de son jeton une fois la décision rendue. Seul le
 * nom de l'erreur est journalisé — la requête porte un mot de passe, aucun
 * détail interne (ni message pg, ni stack, ni email) ne quitte le serveur.
 */
async function safeRecordAttempt(
  record: (params: TokenThrottleRecordParams) => Promise<void>,
  params: TokenThrottleRecordParams,
): Promise<void> {
  try {
    await record(params);
  } catch (error) {
    console.error(
      `[api/sync/token] journalisation de la tentative impossible (raison=${
        error instanceof Error ? error.name : "unknown"
      })`,
    );
  }
}

/** Raison d'un rejet Zod : `trustDays` seul fautif → `invalid-trust-days`. */
function mapZodFailure(
  issues: z.ZodError["issues"],
): "invalid-request" | "invalid-trust-days" {
  const onlyTrustDays = issues.every(
    (issue) => issue.path.length === 1 && issue.path[0] === "trustDays",
  );
  return onlyTrustDays ? "invalid-trust-days" : "invalid-request";
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncTokenHandlerDeps {
  /** Repo d'identité (chemin de prod : Drizzle ; tests : repo mémoire). */
  authRepo: CentralAuthRepo;
  /** Lookup du rattachement des appareils (garde anti-détournement). */
  findDeviceBinding: FindDeviceBinding;
  /** Point d'entrée d'émission — même signature que `issueDeviceToken`. */
  issue: (
    params: IssueDeviceTokenParams,
    repo: CentralAuthRepo,
  ) => Promise<IssueDeviceTokenResult>;
  /** Contrôle de débit AVANT l'émission (prod : Drizzle ; tests : mémoire). */
  checkThrottle: (
    params: TokenThrottleCheckParams,
  ) => Promise<TokenThrottleCheckResult>;
  /** Journalisation de la tentative dans `login_attempt` (forensique). */
  recordAttempt: (
    params: TokenThrottleRecordParams,
  ) => Promise<void>;
}

/**
 * Construit le handler `POST`. Les tests appellent cette fabrique avec des
 * deps mémoire (aucune base, aucun réseau) ; `POST` ci-dessous est le chemin
 * de production, avec les deps Drizzle par défaut.
 */
export function createSyncTokenHandler(
  overrides: Partial<SyncTokenHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    const authRepo = overrides.authRepo ?? getDefaultAuthRepo();
    const findDeviceBinding =
      overrides.findDeviceBinding ?? findDeviceBindingDb;
    const issue = overrides.issue ?? issueDeviceToken;
    const checkThrottle =
      overrides.checkThrottle ??
      ((params: TokenThrottleCheckParams) =>
        checkTokenThrottle(getDefaultThrottleRepo(), params));
    const recordAttempt =
      overrides.recordAttempt ??
      ((params: TokenThrottleRecordParams) =>
        recordTokenAttempt(getDefaultThrottleRepo(), params));

    // (1) Corps JSON — un corps vide ou malformé est une erreur de requête.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }

    // (2) Validation Zod AVANT tout traitement (raison dédiée pour trustDays).
    const parsed = tokenRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError(mapZodFailure(parsed.error.issues), 400);
    }
    const body: TokenRequest = parsed.data;

    // `now` vient TOUJOURS du serveur (jamais l'horloge client) : elle porte à
    // la fois la fenêtre de confiance et l'horodatage forensique.
    const now = new Date();
    const ipAddress = resolveClientIp(request);

    // (3) Limitation de débit — AVANT toute vérification bcrypt : c'est
    // précisément elle qui évite de payer l'amplification de coût. Un refus
    // est toujours journalisé (`sync-token:throttled`), même si l'insert
    // forensique échoue, la réponse reste un `429`.
    let throttle: TokenThrottleCheckResult;
    try {
      throttle = await checkThrottle({ email: body.email, ipAddress, now });
    } catch (error) {
      // Échec fermé : sans lecture fiable du journal de tentatives, AUCUN
      // jeton n'est émis (seul le nom de l'erreur est journalisé).
      console.error(
        `[api/sync/token] lecture du throttle impossible (raison=${
          error instanceof Error ? error.name : "unknown"
        })`,
      );
      return jsonError("internal-error", 500);
    }
    if (!throttle.allowed) {
      await safeRecordAttempt(recordAttempt, {
        email: body.email,
        ipAddress,
        successful: false,
        deniedReason: "sync-token:throttled",
        now,
      });
      return jsonError("throttled", 429);
    }

    // (4) Émission.
    let result: IssueDeviceTokenResult;
    try {
      result = await issue(
        {
          email: body.email,
          password: body.password,
          deviceId: body.deviceId,
          deviceName: body.deviceName,
          os: body.os,
          trustDays: body.trustDays ?? DEFAULT_TRUST_DAYS,
          now,
        },
        guardDeviceBinding(authRepo, findDeviceBinding),
      );
    } catch (error) {
      if (error instanceof DeviceBoundError) {
        // Le jeton d'appareil n'a PAS été émis, mais le mot de passe était
        // POURTANT valide (la garde s'exécute après la vérification) : ligne
        // `successful = true` qualifiée par `denied_reason`, exactement comme
        // la gate de confiance de `auth.ts`. Ce n'est pas un signal de
        // brute-force : l'écrire comme un échec ferait grimper le compteur du
        // compte et pénaliserait son titulaire.
        await safeRecordAttempt(recordAttempt, {
          email: body.email,
          ipAddress,
          successful: true,
          deniedReason: "sync-token:device-bound-to-another-user",
          now,
        });
        return jsonError("device-bound-to-another-user", 403);
      }
      // Journal SANS détail : la requête contient un mot de passe, aucun
      // message interne (DB, stack…) n'est journalisé ni renvoyé. Aucune ligne
      // n'est écrite : le résultat réel de l'émission n'est pas déterminable,
      // et une panne d'infrastructure ne doit pas faire grimper le compteur
      // d'échecs d'un compte (ni gonfler la table face à un attaquant).
      console.error("[api/sync/token] échec imprévu de l'émission du jeton");
      return jsonError("internal-error", 500);
    }

    if (!result.ok) {
      switch (result.reason) {
        case "invalid-credentials":
          await safeRecordAttempt(recordAttempt, {
            email: body.email,
            ipAddress,
            successful: false,
            deniedReason: "sync-token:invalid-credentials",
            now,
          });
          return jsonError("invalid-credentials", 401);
        case "no-membership":
          // Mot de passe pourtant VALIDE, refus pour absence de cabinet actif :
          // `successful = true` + `denied_reason` (cf. supra), afin que la
          // politique de contrôle d'accès ne pénalise pas son titulaire.
          await safeRecordAttempt(recordAttempt, {
            email: body.email,
            ipAddress,
            successful: true,
            deniedReason: "sync-token:no-membership",
            now,
          });
          return jsonError("no-membership", 403);
        case "invalid-trust-days":
          // Inatteignable ici (Zod contrôle `trustDays` en (2)) — journalisé
          // par souci d'exhaustivité forensique.
          await safeRecordAttempt(recordAttempt, {
            email: body.email,
            ipAddress,
            successful: false,
            deniedReason: "sync-token:invalid-trust-days",
            now,
          });
          return jsonError("invalid-trust-days", 400);
        case "invalid-request":
          // Inatteignable ici (Zod contrôle le corps en (2)) — idem.
          await safeRecordAttempt(recordAttempt, {
            email: body.email,
            ipAddress,
            successful: false,
            deniedReason: "sync-token:invalid-request",
            now,
          });
          return jsonError("invalid-request", 400);
      }
    }

    // Succès : la ligne `successful = true` réinitialise le compteur d'échecs
    // du compte (règle alignée sur `auth.ts`). Le jeton en clair n'apparaît
    // qu'ici, renvoyé **une seule fois**.
    await safeRecordAttempt(recordAttempt, {
      email: body.email,
      ipAddress,
      successful: true,
      now,
    });

    return NextResponse.json({
      token: result.token,
      trustExpiresAt: result.trustExpiresAt.toISOString(),
    });
  };
}

export const POST = createSyncTokenHandler();
