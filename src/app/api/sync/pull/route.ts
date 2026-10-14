import { NextResponse } from "next/server";
import { SyncScopeError, fetchChanges } from "@/lib/sync/central-store";
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
 *    inconnu / révoqué / expiré → **401** (message générique) ;
 *  - corps validé par `pullRequestSchema` → sinon **400** ;
 *  - **anti-IDOR au niveau route** : le `clinicId` demandé doit appartenir à
 *    `ctx.clinicIds` → sinon **403** (verrou supplémentaire, en plus du
 *    filtrage SQL et de la re-vérification pure déjà posés dans le store) ;
 *  - succès → **200** avec la `PullResponse` (`changes`, `cursor`, `hasMore`) ;
 *  - `SyncScopeError` → **403** ; toute autre exception → **500** générique.
 *
 * Invariants : `now` toujours serveur ; zéro `console.log` ; `console.error`
 * uniquement sur les 500, sans secret ; jamais mis en cache (`force-dynamic`).
 */

export const dynamic = "force-dynamic";

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
  /** Tirage paginé — chemin de prod : `fetchChanges`. */
  pull: (
    ctx: DeviceTokenContext,
    req: PullRequest,
    now: Date,
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
    ((ctx: DeviceTokenContext, req: PullRequest, now: Date) =>
      fetchChanges(ctx, req, now));

  return async function POST(request: Request): Promise<Response> {
    // (1) Authentification — échec fermé, réponse générique (pas d'oracle).
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

    // (2) Corps — JSON valide puis validation Zod.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = pullRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }
    const req: PullRequest = parsed.data;

    // (3) Anti-IDOR au niveau route : le cabinet réclamé doit être dans la
    //     portée du jeton (`clinic_membership` actif, dérivé à l'émission).
    if (!ctx.clinicIds.includes(req.clinicId)) {
      return jsonError("clinic-out-of-scope", 403);
    }

    // (4) Tirage — `now` horloge serveur ; curseur paginé côté store.
    try {
      const response: PullResponse = await pull(ctx, req, new Date());
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
