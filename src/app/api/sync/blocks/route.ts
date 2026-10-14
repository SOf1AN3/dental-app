import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/db";
import { documentSequences } from "@/lib/db/schema";
import { SyncScopeError } from "@/lib/sync/central-store";
import {
  verifyDeviceToken,
  type DeviceTokenContext,
} from "@/lib/sync/central-auth";
import { documentSequenceTypeSchema } from "@/lib/sync/numbering";

/**
 * Tâche 6.1 — `POST /api/sync/blocks` : **réservation d'un bloc de numéros**
 * (décision client D-4).
 *
 * Un compteur atomique (`document_sequence.last_number`) est inallocable
 * hors-ligne : deux postes créant une facture offline inventeraient le même
 * numéro. La route découpe donc **côté central** un intervalle exclusif
 * `[block_start … block_end]` pour UN poste, qui le consomme ensuite localement
 * sans réseau (`src/lib/sync/numbering.ts`). Bloc épuisé hors-ligne → le poste
 * refuse explicitement de créer le document : **jamais de numéro inventé**.
 *
 * Contrat (aligné sur `/api/sync/push` et `/api/sync/pull`) :
 *  - `Authorization: Bearer <jeton d'appareil>` — absent / malformé / inconnu /
 *    révoqué / expiré → **401** (échec fermé, message générique) ;
 *  - corps `{ clinicId, type, size? }` validé par Zod → sinon **400**
 *    (`size` entier borné [1, 200], défaut 50 ; `type` limité aux types
 *    réellement numérotés : `invoice`, `quote`, `prosthesis:<année>`) ;
 *  - `clinicId ∉ ctx.clinicIds` → **403** (`SyncScopeError`) ;
 *  - succès → **200** `{ blockStart, blockEnd, type, clinicId }` ;
 *  - toute autre exception → **500** générique (jamais de message interne).
 *
 * Invariants d'allocation :
 *  - **atomicité** : la ligne `(clinic_id, type)` est verrouillée
 *    `SELECT … FOR UPDATE` dans une transaction (créée avec
 *    `last_number = 0` si absente, dans cette même transaction) → deux postes
 *    ne peuvent jamais recevoir le même intervalle ;
 *  - **idempotence** : si un bloc `reserved` existe encore **pour CE MÊME
 *    device**, il est renvoyé tel quel (l'écraser ferait sauter des numéros) ;
 *  - **jamais de vol** : un bloc `reserved` appartenant à **un autre** device
 *    n'est pas réattribué — un **nouveau** bloc est découpé au-delà de
 *    `last_number` (le bloc du premier device reste acquis) ;
 *  - `now` est **toujours l'horloge serveur** ; zéro `console.log`,
 *    `console.error` uniquement sur les 500, sans secret ;
 *  - la route n'est jamais mise en cache (`force-dynamic`).
 */

export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Bornes et schéma du corps                                                   */
/* -------------------------------------------------------------------------- */

export const MIN_BLOCK_SIZE = 1;
export const MAX_BLOCK_SIZE = 200;
export const DEFAULT_BLOCK_SIZE = 50;

const blocksRequestSchema = z.object({
  clinicId: z.string().min(1),
  type: documentSequenceTypeSchema,
  size: z.number().int().min(MIN_BLOCK_SIZE).max(MAX_BLOCK_SIZE).optional(),
});

export type BlocksRequest = z.infer<typeof blocksRequestSchema>;

/** Corps contractuel d'une réservation réussie. */
export interface BlockReservation {
  blockStart: number;
  blockEnd: number;
  type: string;
  clinicId: string;
}

/* -------------------------------------------------------------------------- */
/* Réponses                                                                    */
/* -------------------------------------------------------------------------- */

function jsonError(
  error: "unauthorized" | "invalid-request" | "forbidden" | "internal-error",
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
/* Réservation atomique (chemin de production)                                 */
/* -------------------------------------------------------------------------- */

export type BlocksDb = typeof db;

export interface ReserveBlockParams {
  clinicId: string;
  type: string;
  size: number;
}

/**
 * Réserve `[blockStart … blockEnd]` pour `ctx.deviceId`.
 *
 * Transaction unique :
 *  1. `INSERT … ON CONFLICT DO NOTHING` (ligne absente → `last_number = 0`) ;
 *  2. `SELECT … FOR UPDATE` sur `(clinic_id, type)` : le verrou sérialise deux
 *    réservations concurrentes ;
 *  3. bloc `reserved` déjà détenu par CE device → renvoi idempotent (aucune
 *    écriture) ; bloc d'un autre device → nouveau bloc au-delà de `last_number` ;
 *  4. sinon `blockStart = last_number + 1`, `blockEnd = blockStart + size - 1`,
 *    `last_number = blockEnd`, colonnes de bloc écrites → commit.
 *
 * @param now horloge **serveur** (jamais l'horloge client).
 * @throws SyncScopeError si le cabinet est hors portée du jeton.
 */
export async function reserveNumberBlock(
  ctx: DeviceTokenContext,
  params: ReserveBlockParams,
  now: Date,
  database: BlocksDb = db,
): Promise<BlockReservation> {
  if (!ctx.clinicIds.includes(params.clinicId)) {
    throw new SyncScopeError();
  }

  return database.transaction(async (tx): Promise<BlockReservation> => {
    // (1) Ligne absente → créée ici, dans la même transaction que le verrou.
    await tx
      .insert(documentSequences)
      .values({ clinicId: params.clinicId, type: params.type, lastNumber: 0 })
      .onConflictDoNothing();

    // (2) Verrou d'allocateur : deux postes ne peuvent pas se partager un
    //     intervalle, quel que soit l'ordre d'arrivée.
    const rows = await tx
      .select()
      .from(documentSequences)
      .where(
        and(
          eq(documentSequences.clinicId, params.clinicId),
          eq(documentSequences.type, params.type),
        ),
      )
      .for("update");

    const row = rows[0];
    if (row === undefined) {
      // Inatteignable en normal : l'INSERT ci-dessus vient d'échouer silencieusement.
      throw new Error("sync/blocks : ligne de séquence introuvable après insertion.");
    }

    // (3) Idempotence : ne JAMAIS écraser un bloc non épuisé de ce poste.
    if (
      row.blockStatus === "reserved" &&
      row.blockDeviceId === ctx.deviceId &&
      row.blockStart !== null &&
      row.blockEnd !== null
    ) {
      return {
        blockStart: row.blockStart,
        blockEnd: row.blockEnd,
        type: params.type,
        clinicId: params.clinicId,
      };
    }

    // (4) Nouveau bloc (bloc d'un autre device non volé : `last_number` a déjà
    //     été poussé au-delà de son intervalle lors de sa réservation).
    const blockStart = row.lastNumber + 1;
    const blockEnd = blockStart + params.size - 1;

    await tx
      .update(documentSequences)
      .set({
        lastNumber: blockEnd,
        blockStart,
        blockEnd,
        blockDeviceId: ctx.deviceId,
        blockStatus: "reserved",
        blockReservedAt: now,
      })
      .where(
        and(
          eq(documentSequences.clinicId, params.clinicId),
          eq(documentSequences.type, params.type),
        ),
      );

    return { blockStart, blockEnd, type: params.type, clinicId: params.clinicId };
  });
}

/* -------------------------------------------------------------------------- */
/* Handler (fabrique injectable pour les tests hermétiques)                    */
/* -------------------------------------------------------------------------- */

export interface SyncBlocksHandlerDeps {
  /** Vérification du jeton — chemin de prod : `verifyDeviceToken`. */
  verifyToken: (
    token: string,
    now: Date,
  ) => Promise<DeviceTokenContext | null>;
  /** Réservation — chemin de prod : `reserveNumberBlock`. */
  reserve: (
    ctx: DeviceTokenContext,
    params: ReserveBlockParams,
    now: Date,
  ) => Promise<BlockReservation>;
}

/**
 * Construit le handler `POST`. Les tests injectent des deps mémoire (aucune
 * base) ; `POST` ci-dessous est le chemin de production.
 */
export function createSyncBlocksHandler(
  overrides: Partial<SyncBlocksHandlerDeps> = {},
): (request: Request) => Promise<Response> {
  const verifyToken =
    overrides.verifyToken ??
    ((token: string, now: Date) => verifyDeviceToken(token, now));
  const reserve =
    overrides.reserve ??
    ((ctx: DeviceTokenContext, p: ReserveBlockParams, now: Date) =>
      reserveNumberBlock(ctx, p, now));

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
      console.error("[api/sync/blocks] échec imprévu de la vérification du jeton");
      return jsonError("internal-error", 500);
    }
    if (ctx === null) {
      return jsonError("unauthorized", 401);
    }

    // (2) Corps — JSON valide puis validation Zod (400 structuré).
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonError("invalid-request", 400);
    }
    const parsed = blocksRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonError("invalid-request", 400);
    }

    // (3) Portée, réservation, erreurs — `now` = horloge serveur.
    try {
      if (!ctx.clinicIds.includes(parsed.data.clinicId)) {
        throw new SyncScopeError();
      }
      const reservation = await reserve(
        ctx,
        {
          clinicId: parsed.data.clinicId,
          type: parsed.data.type,
          size: parsed.data.size ?? DEFAULT_BLOCK_SIZE,
        },
        new Date(),
      );
      return NextResponse.json(reservation);
    } catch (error) {
      if (error instanceof SyncScopeError) {
        return jsonError("forbidden", 403);
      }
      // 500 générique : aucun message interne ni stack ne quitte le serveur.
      console.error("[api/sync/blocks] échec imprévu de la réservation du bloc");
      return jsonError("internal-error", 500);
    }
  };
}

export const POST = createSyncBlocksHandler();
