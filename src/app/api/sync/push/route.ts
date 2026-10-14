import { NextResponse } from "next/server";
import { SyncScopeError, applyOps } from "@/lib/sync/central-store";
import { verifyDeviceToken, type DeviceTokenContext } from "@/lib/sync/central-auth";
import {
  MAX_PUSH_OPS,
  pushRequestSchema,
  type ChangeOp,
  type PushResponse,
} from "@/lib/sync/protocol";

/**
 * Tâche 5.2c — `POST /api/sync/push` : application d'un lot d'opérations
 * d'un poste sur le serveur central (voir `src/lib/sync/central-store.ts`).
 *
 * Contrat :
 *  - `Authorization: Bearer <jeton d'appareil>` — jeton absent / malformé /
 *    inconnu / révoqué / expiré → **401** (message générique, échec fermé) ;
 *  - corps validé par `pushRequestSchema` → sinon **400** ;
 *  - plus de `MAX_PUSH_OPS` opérations → **400** (un tel lot serait rejeté par
 *    le schéma : on répond explicitement plutôt qu'un 500 venant de
 *    `applyOps`) ;
 *  - succès → **200** avec la `PushResponse` contractuelle ;
 *  - `SyncScopeError` → **403** ; toute autre exception → **500** générique
 *    (jamais le message interne, jamais de stack).
 *
 * Invariants :
 *  - `now` est **toujours l'horloge serveur** (`new Date()` ici) : aucune
 *    horloge client n'arbitre un conflit ni n'attribue une `rev` ;
 *  - zéro `console.log` ; `console.error` uniquement sur les 500, sans secret
 *    (pas de jeton, pas de mot de passe, pas d'URL de base) ;
 *  - la route n'est jamais mise en cache (`force-dynamic`).
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Réponses                                                                   */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "unauthorized" | "invalid-request" | "too-many-ops" | "forbidden" | "internal-error",
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

export interface SyncPushHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /** Application du lot — chemin de prod : `applyOps`. */
  apply: (
    ctx: DeviceTokenContext,
    ops: ChangeOp[],
    now: Date,
  ) => Promise<PushResponse>;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncPushHandler(
  overrides: Partial<SyncPushHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const apply =
    overrides.apply ??
    ((ctx: DeviceTokenContext, ops: ChangeOp[], now: Date) =>
      applyOps(ctx, ops, now));

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
      console.error("[api/sync/push] échec imprévu de la vérification du jeton");
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

    // (3) Lot trop grand → 400 explicite (et non 500 depuis `applyOps`).
    if (
      typeof raw === "object" &&
      raw !== null &&
      Array.isArray((raw as { ops?: unknown }).ops) &&
      (raw as { ops: unknown[] }).ops.length > MAX_PUSH_OPS
    ) {
      return jsonError("too-many-ops", 400);
    }

    const parsed = pushRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }

    // (4) Application — `now` horloge serveur, une transaction par opération.
    try {
      const response: PushResponse = await apply(ctx, parsed.data.ops, new Date());
      return NextResponse.json(response);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        return jsonError("forbidden", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/push] échec imprévu de l'application du lot");
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncPushHandler();
