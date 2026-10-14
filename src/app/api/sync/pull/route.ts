import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SyncScopeError,
  fetchChanges,
  type FetchChangesOptions,
} from "@/lib/sync/central-store";
import { verifyDeviceToken, type DeviceTokenContext } from "@/lib/sync/central-auth";
import {
  pullRequestSchema,
  type PullRequest,
  type PullResponse,
} from "@/lib/sync/protocol";

/**
 * Tâche 5.2c — `POST /api/sync/pull` : tirage paginé des changements du
 * serveur central (voir `src/lib/sync/central-store.ts`).
 *
 * **POST plutôt que GET** : le curseur composite `(updated_at, id)` et les
 * options (`limit`) voyagent dans le corps — un GET ne devrait pas porter un
 * corps de requête. (Le plan §5.2 évoquait `GET` ; la décision d'implémentation
 * retient POST pour les raisons ci-dessus — le client de l'étape 6 s'aligne.)
 *
 * Contrat :
 *  - `Authorization: Bearer <jeton d'appareil>` — jeton absent / malformé /
 *    inconnu / révoqué / expiré → **401** (message générique), **avant**
 *    toute lecture/validation du corps ;
 *  - corps validé par `pullRequestSchema` + `variant` → sinon **400** ;
 *  - **anti-IDOR au niveau route** : le `clinicId` demandé doit appartenir à
 *    `ctx.clinicIds` → sinon **403** (verrou supplémentaire, en plus du
 *    filtrage SQL et de la re-vérification pure déjà posés dans le store) ;
 *  - succès → **200** avec la `PullResponse` (`changes`, `cursor`, `hasMore`) ;
 *  - `SyncScopeError` → **403** ; toute autre exception → **500** générique.
 *
 * Invariants : `now` toujours serveur ; zéro `console.log` ; `console.error`
 * uniquement sur les 500, sans secret ; jamais mis en cache (`force-dynamic`).
 *
 * ## Tâche 7.1b — `variant: "bootstrap"` (variante amorçage)
 *
 * Champ **optionnel et à valeur fermée** : `z.literal("bootstrap")` — toute
 * autre valeur (`"malveillant"`, `"admin"`, …) échoue la validation → **400**
 * (une valeur ouverte ne serait pas reconnue ni journalisée correctement).
 *
 *  - `variant` absent → appel au store **strictement inchangé** (aucun
 *    `options`, donc aucun `passwordHash` dans la réponse) ;
 *  - `variant: "bootstrap"` → `fetchChanges(..., { includeAuthBootstrap: true })`
 *    : le store ajoute `passwordHash` **uniquement** sur les opérations
 *    `user` **vivantes** (voir `FetchChangesOptions`) ;
 *  - le transport reste protégé par le même chemin : **auth (401) → corps
 *    (400) → anti-IDOR (403)**, aucun ordre n'est modifié ;
 *  - **journalisation** : le premier tirage bootstrap émis pour un device
 *    donné lève un `console.warn` **sans secret** (device, clinic, horloge —
 *    **jamais** le hash ni aucun mot de passe), puis ce device est marqué :
 *    les tirages suivants ne sont plus journalisés (pas de bruit, acte
 *    sensible traçable une fois). Choix du **log** plutôt que `audit_log` :
 *    cette route ne détient aucun `actorUserId` (auth = jeton d'appareil) et
 *    écrire dans `audit_log` (table `push-only`, créée par les postes)
 *    imposerait un horodatage/une portée d'audit artificiels — hors périmètre
 *    de la tâche et non couvert par le dépôt « simplement ».
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Corps (Zod) — `pullRequestSchema` + `variant` fermé (tâche 7.1b)            */
/* -------------------------------------------------------------------------- */

/**
 * Corps exact de cette route : le schéma du protocole (`pullRequestSchema`,
 * **non modifié** — `protocol.ts` est verrouillé) étendu d'un seul champ à
 * **valeur fermée**. Toute autre valeur que `"bootstrap"` échoue la
 * validation → **400 `invalid-request`** ; `variant` absent → tirage normal.
 */
const pullBodySchema = pullRequestSchema.extend({
  variant: z.literal("bootstrap").optional(),
});

type PullBody = z.infer<typeof pullBodySchema>;

/* -------------------------------------------------------------------------- */
/* Réponses                                                                   */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "unauthorized" | "invalid-request" | "clinic-out-of-scope" | "internal-error",
  status: number,
): Response {
  return NextResponse.json({ error }, { status });
}

/** Extrait le jeton d'un en-tête `Authorization: Bearer <jeton>`, `null` sinon. */
function readBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncPullHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /**
   * Tirage paginé — chemin de prod : `fetchChanges`.
   *
   * `options` (4ᵉ argument, **optionnel**) ne porte que la variante
   * « bootstrap » (`{ includeAuthBootstrap: true }`) ; `undefined` signifie
   * un tirage strictement normal. Les implémentations sans 4ᵉ paramètre
   * (tests existants) restent compatibles.
   */
  pull: (
    ctx: DeviceTokenContext,
    req: PullRequest,
    now: Date,
    options?: FetchChangesOptions,
  ) => Promise<PullResponse>;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncPullHandler(
  overrides: Partial<SyncPullHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const pull =
    overrides.pull ??
    ((ctx: DeviceTokenContext, req: PullRequest, now: Date, options?: FetchChangesOptions) =>
      fetchChanges(ctx, req, now, undefined, options));

  // Traçabilité (7.1b) : devices déjà journalisés en « tirage bootstrap ».
  // Portée = cette instance de handler (le `POST` de prod est créé une fois
  // par chargement de module). Croissance bornée au nombre d'appareils.
  const bootstrapLoggedDevices = new Set<string>();

  return async function POST(request: Request): Promise<Response> {
    // (1) Authentification — échec fermé, réponse générique (pas d'oracle).
    //     AVANT toute lecture du corps : un `variant` malveillant sans jeton
    //     reste un 401, jamais un 400 (aucune oracle de validation).
    const token = readBearerToken(request.headers.get("authorization"));
    if (token === null) {
      return jsonError("unauthorized", 401);
    }
    let ctx: DeviceTokenContext | null;
    try {
      ctx = await verifyToken(token, new Date());
    } catch {
      console.error("[api/sync/pull] échec imprévu de la vérification du jeton");
      return jsonError("internal-error", 500);
    }
    if (ctx === null) {
      return jsonError("unauthorized", 401);
    }

    // (2) Corps — JSON valide puis validation Zod (`variant` fermé → 400).
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = pullBodySchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    // `variant` est consigné SÉPARÉMENT : le store ne reçoit jamais le corps
    // brut, et `PullRequest` ne change pas de forme.
    const { variant, ...body }: PullBody = parsed.data;
    const req: PullRequest = body;
    const options: FetchChangesOptions | undefined =
      variant === "bootstrap" ? { includeAuthBootstrap: true } : undefined;

    // (3) Anti-IDOR au niveau route : le cabinet réclamé doit être dans la
    //     portée du jeton (`clinic_membership` actif, dérivé à l'émission).
    if (!ctx.clinicIds.includes(req.clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (4) Tirage — `now` horloge serveur ; curseur paginé côté store.
    try {
      const response: PullResponse = await pull(ctx, req, new Date(), options);
      if (variant === "bootstrap" && !bootstrapLoggedDevices.has(ctx.deviceId)) {
        // 7.1b — acte sensible, journalisé UNE fois par device, **sans secret** :
        // ni hash, ni mot de passe, ni payload ne figurent dans ce journal.
        bootstrapLoggedDevices.add(ctx.deviceId);
        console.warn(
          `[api/sync/pull] tirage bootstrap émis pour device ${ctx.deviceId} ` +
            `(clinic ${req.clinicId})`,
        );
      }
      return NextResponse.json(response);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        return jsonError("clinic-out-of-scope", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/pull] échec imprévu du tirage");
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncPullHandler();
