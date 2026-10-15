import { NextResponse } from "next/server";
import { REJECT, SyncScopeError, applyOps } from "@/lib/sync/central-store";
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
 *  - **portée (A3)** → **403** `{ error: "clinic-out-of-scope" }`, code aligné
 *    sur `POST /api/sync/pull` (même portée, même verrou) quand **toutes** les
 *    opérations du lot ont été refusées pour `clinic-mismatch` (ou que le store
 *    lève `SyncScopeError`) ;
 *  - lot **mixte** (au moins une op acceptée ET des rejets de portée) →
 *    **200** avec `rejected` détaillé : voir « Portée et contrat 403 » ci-bas ;
 *  - toute autre exception → **500** générique (jamais le message interne,
 *    jamais de stack).
 *
 * ## Portée et contrat 403 (choix explicité, tâche 10.3)
 *
 * Le verrou de portée est appliqué **côté store** (`applyOps` →
 * `RejectedOpError(REJECT.clinicMismatch)` : aucune ligne hors portée n'est
 * jamais écrite). Le **store reste total** : il renvoie toujours un rapport de
 * lot (`accepted` / `rejected` / `conflicts`) et ne lève jamais pour un rejet
 * de portée — c'est le contrat qu'attestent les tests du cœur serveur (un lot
 * intégralement refusé reste un rapport exploitable). La **route traduit donc
 * la réponse en code HTTP**, exactement comme `/api/sync/pull` traduit
 * `SyncScopeError` :
 *
 *  - **100 % hors portée** (`rejected` non vide, `accepted` vide, toutes les
 *    raisons `clinic-mismatch`) → **403** `{ error: "clinic-out-of-scope" }`. Le
 *    refus est total : détailler les rejets ne dirait rien de plus, et le code
 *    identique au tirage évite deux dialectes pour un même verrou ;
 *  - **lot mixte** (au moins une op acceptée) → **200** avec `rejected`
 *    détaillé. C'est le contrat **idempotent** : la partie acceptée a été
 *    écrite et journalisée (`sync_applied`), le client doit pouvoir lire le
 *    sort de CHAQUE opération (abandonner celles qui sont rejetées, garder le
 *    reste) ; un 403 masquerait des écritures pourtant advenues.
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
  error:
    | "unauthorized"
    | "invalid-request"
    | "too-many-ops"
    | "clinic-out-of-scope"
    | "internal-error",
  status: number,
): Response {
  return NextResponse.json({ error }, { status });
}

/**
 * Lot **intégralement** hors portée : au moins une opération refusée, aucune
 * acceptée, et **toutes** les raisons valant `clinic-mismatch`.
 *
 * - `accepted` vide est le marqueur décisif : il contient aussi les opId déjà
 *   journalisés (rejeu A1), donc un lot « rejoué + hors portée » est mixte →
 *   **200** (contrat idempotent, voir l'en-tête) ;
 * - `conflicts` n'est jamais renseigné sans op acceptée (le journal n'est
 *   écrit qu'après une écriture réussie) : pas de garde supplémentaire ;
 * - une raison autre que `clinic-mismatch` (table inconnue, `parent-missing`…)
 *   n'est **pas** une question de portée → 200 avec `rejected` détaillé.
 */
function isScopeOnlyRejection(response: PushResponse): boolean {
  return (
    response.rejected.length > 0 &&
    response.accepted.length === 0 &&
    response.rejected.every((op) => op.reason === REJECT.clinicMismatch)
  );
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
      // (4bis) Portée : lot 100 % hors portée → 403 aligné sur le tirage ;
      //       lot mixte → 200 avec `rejected` détaillé (voir l'en-tête).
      if (isScopeOnlyRejection(response)) {
        return jsonError("clinic-out-of-scope", 403);
      }
      return NextResponse.json(response);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        // Même code que `POST /api/sync/pull` : un seul dialecte pour le
        // verrou de portée.
        return jsonError("clinic-out-of-scope", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/push] échec imprévu de l'application du lot");
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncPushHandler();
